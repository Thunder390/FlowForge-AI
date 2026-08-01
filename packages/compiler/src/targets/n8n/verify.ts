/**
 * Stage 6: a structural self-check on the compiler's own output.
 *
 * Cheap, and it catches a class of bug unit tests miss. A unit test proves that
 * one lowering does what its author expected; this proves that whatever the
 * whole pipeline produced is internally consistent, including for documents
 * nobody wrote a test for.
 *
 * For n8n: every `connections` entry names an existing node, every node has a
 * `type` and a `typeVersion`, node names are unique, every emitted credential
 * carries a placeholder rather than a value, and the JSON round-trips through
 * parse and stringify unchanged.
 *
 * **A failure here is an internal error, not a user error.** It means the
 * compiler has a bug, and the correct response is to fail rather than hand the
 * user a broken file. The driver turns any failure into an
 * `internal_inconsistency` error that says as much, because a user told their
 * workflow is invalid when in fact our emitter produced a dangling connection
 * will spend an afternoon editing something that was already correct.
 *
 * ## The secret scan
 *
 * The compiler refuses to emit any parameter value matching a secret pattern.
 * This duplicates validation rule 14 on purpose: it is a safety property, and
 * safety properties get belt and braces. Rule 14 covers what the *document*
 * carries; this covers what the compiler *produced*, which is a different thing
 * once static parameters and transforms have run.
 *
 * A match is reported as an internal inconsistency, and deliberately so. The
 * document was already scanned and passed, so a secret appearing here came from
 * registry data or from a transform, and both are ours. The finding names the
 * node and the parameter and never the matched text, because a verify failure
 * reaches logs and the repair prompt, and the repair prompt is sent to a model
 * and stored.
 */

import { findSecret } from "@flowforge/ffir";

import type { EmitResult, VerifyResult } from "../../target.js";
import { CREDENTIAL_PLACEHOLDER } from "./lower.js";

interface ParsedNode {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  typeVersion?: unknown;
  parameters?: unknown;
  credentials?: Record<string, { id?: unknown; name?: unknown }>;
}

interface ParsedWorkflow {
  name?: unknown;
  nodes?: ParsedNode[];
  connections?: Record<string, Record<string, ({ node?: unknown }[] | null)[]>>;
}

export function verifyN8n(output: EmitResult): VerifyResult {
  const failures: string[] = [];

  let parsed: ParsedWorkflow;
  try {
    parsed = JSON.parse(output.content) as ParsedWorkflow;
  } catch (cause) {
    return {
      ok: false,
      failures: [`emitted content is not valid JSON: ${describe(cause)}`],
    };
  }

  // Round-trip: re-serializing what we just parsed must reproduce the bytes.
  // Catches a value that survives stringify but not parse, `-0` and lone
  // surrogates among them.
  if (`${JSON.stringify(parsed, null, 2)}\n` !== output.content) {
    failures.push("emitted JSON does not round-trip through parse and stringify");
  }

  const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
  if (!Array.isArray(parsed.nodes)) failures.push("workflow has no nodes array");

  const names = new Set<string>();
  for (const node of nodes) {
    const label = typeof node.name === "string" ? node.name : "<unnamed>";

    if (typeof node.name !== "string" || node.name === "") {
      failures.push("a node has no name");
    } else if (names.has(node.name)) {
      failures.push(`two nodes are called "${node.name}"`);
    } else {
      names.add(node.name);
    }

    if (typeof node.id !== "string" || node.id === "") {
      failures.push(`node "${label}" has no id`);
    }
    if (typeof node.type !== "string" || node.type === "") {
      failures.push(`node "${label}" has no type`);
    }
    if (typeof node.typeVersion !== "number") {
      failures.push(`node "${label}" has no typeVersion`);
    }

    failures.push(...credentialFailures(node, label));
    failures.push(...secretFailures(node, label));
  }

  failures.push(...connectionFailures(parsed, names));

  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}

/**
 * Every emitted credential is a placeholder with a name.
 *
 * The name is what n8n shows the user when it asks them to connect one, so a
 * blank name produces an unlabelled prompt on an import they did not expect to
 * have to configure. The placeholder id is the safety half: a real id here
 * would mean the compiler had learned a value it has no business holding.
 */
function credentialFailures(node: ParsedNode, label: string): string[] {
  if (node.credentials === undefined) return [];

  const failures: string[] = [];
  for (const [key, credential] of Object.entries(node.credentials)) {
    if (credential.id !== CREDENTIAL_PLACEHOLDER) {
      failures.push(
        `node "${label}" credential "${key}" does not carry the placeholder id`,
      );
    }
    if (typeof credential.name !== "string" || credential.name === "") {
      failures.push(`node "${label}" credential "${key}" has no name`);
    }
  }
  return failures;
}

/** Never echoes what matched. Only where it is and which pattern fired. */
function secretFailures(node: ParsedNode, label: string): string[] {
  const failures: string[] = [];

  walkStrings(node.parameters, "", (pointer, value) => {
    const match = findSecret(value);
    if (match === undefined) return;
    failures.push(
      `node "${label}" parameter "${pointer}" looks like a ${match.pattern} and was not emitted`,
    );
  });

  return failures;
}

function connectionFailures(
  parsed: ParsedWorkflow,
  names: ReadonlySet<string>,
): string[] {
  const failures: string[] = [];
  const connections = parsed.connections;
  if (connections === undefined) return ["workflow has no connections object"];

  for (const [source, outputs] of Object.entries(connections)) {
    if (!names.has(source)) {
      failures.push(`connections name "${source}", which is not a node`);
    }

    for (const [port, slots] of Object.entries(outputs)) {
      for (const slot of slots) {
        for (const connection of slot ?? []) {
          if (typeof connection.node !== "string" || !names.has(connection.node)) {
            failures.push(
              `"${source}" connects on ${port} to "${String(connection.node)}", which is not a node`,
            );
          }
        }
      }
    }
  }

  return failures;
}

function walkStrings(
  value: unknown,
  pointer: string,
  visit: (pointer: string, value: string) => void,
): void {
  if (typeof value === "string") {
    visit(pointer === "" ? "/" : pointer, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, `${pointer}/${index}`, visit));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      walkStrings(child, `${pointer}/${key}`, visit);
    }
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
