/**
 * Stage 5: the n8n IR becomes a JSON file.
 *
 * Deliberately dumb. Key ordering and formatting, and nothing else: every
 * decision was made in stage 4. A stage 5 that decided anything would be a
 * second place to look when the output is wrong.
 *
 * This is where determinism is enforced. Object keys are written in a fixed
 * order, no array is reordered here because stage 4 already put every one of
 * them in its final order, and nothing generates a timestamp or a random id.
 * Same input, byte-identical output, always. That is what makes golden files
 * work, and golden files are the only thing that makes a compiler's silent bugs
 * show up as a reviewable diff.
 *
 * ## Key order is written out rather than inherited
 *
 * `JSON.stringify` follows insertion order, so emitting an object built
 * elsewhere would make the file's shape depend on the order stage 4 happened to
 * assign fields in. Rebuilding each object here, field by field, means the
 * output format is stated in one place and a reordering upstream cannot quietly
 * rewrite every golden file.
 */

import type { EmitResult } from "../../target.js";
import type {
  N8nConnections,
  N8nIR,
  N8nNode,
  N8nNodeConnections,
  N8nWorkflow,
} from "./ir.js";
import { N8N_TARGET_KEY } from "./ir.js";

/** Two-space indentation and a trailing newline, matching every other artifact. */
export function emitN8n(ir: N8nIR): EmitResult {
  return {
    target: N8N_TARGET_KEY,
    content: `${JSON.stringify(orderWorkflow(ir.workflow), null, 2)}\n`,
  };
}

function orderWorkflow(workflow: N8nWorkflow): unknown {
  return {
    name: workflow.name,
    nodes: workflow.nodes.map(orderNode),
    connections: orderConnections(workflow.connections),
    settings: { executionOrder: workflow.settings.executionOrder },
    pinData: workflow.pinData,
    meta: { instanceId: workflow.meta.instanceId },
  };
}

/**
 * One node's fields, in the order n8n's own exports use.
 *
 * Optional fields are omitted rather than written as `undefined`, so a node
 * with no credentials and no error handling emits the five fields it actually
 * has. `JSON.stringify` would drop an explicit `undefined` anyway; building the
 * object conditionally makes that intent visible instead of incidental.
 */
function orderNode(node: N8nNode): unknown {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    typeVersion: node.typeVersion,
    position: node.position,
    parameters: node.parameters,
    ...(node.credentials === undefined ? {} : { credentials: node.credentials }),
    ...(node.onError === undefined ? {} : { onError: node.onError }),
    ...(node.retryOnFail === undefined ? {} : { retryOnFail: node.retryOnFail }),
    ...(node.maxTries === undefined ? {} : { maxTries: node.maxTries }),
    ...(node.waitBetweenTries === undefined
      ? {}
      : { waitBetweenTries: node.waitBetweenTries }),
  };
}

/**
 * Connections, with `main` written before `error` on every node.
 *
 * The source-node keys keep the order stage 4 built them in, which is the
 * order the nodes appear in the file. Within a node the output keys are pinned
 * here so that two workflows differing only in which port stage 4 saw first
 * still serialize identically.
 */
function orderConnections(connections: N8nConnections): unknown {
  const ordered: Record<string, unknown> = {};

  for (const [name, outputs] of Object.entries(connections)) {
    ordered[name] = orderNodeConnections(outputs);
  }

  return ordered;
}

function orderNodeConnections(outputs: N8nNodeConnections): unknown {
  const ordered: Record<string, unknown> = {};

  // `main` first, then `error`, then anything a future node type introduces, in
  // sorted order so the tail cannot drift.
  const keys = Object.keys(outputs).sort(byOutputKey);
  for (const key of keys) ordered[key] = outputs[key];

  return ordered;
}

const OUTPUT_KEY_ORDER = ["main", "error"];

function byOutputKey(a: string, b: string): number {
  const left = OUTPUT_KEY_ORDER.indexOf(a);
  const right = OUTPUT_KEY_ORDER.indexOf(b);
  if (left !== -1 && right !== -1) return left - right;
  if (left !== -1) return -1;
  if (right !== -1) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
