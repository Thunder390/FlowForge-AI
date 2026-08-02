/**
 * The repair prompt.
 *
 * Machine-generated from failures, never hand-phrased per case. AI_SPEC gives
 * three properties this text has on purpose: it is generated from validator
 * output, it names the node and parameter, and it ends by forbidding unrequested
 * changes. The last one earns its place: without it the model redesigns, which
 * discards correct work and tends to introduce new failures.
 *
 * ## Why this lives in `pipeline` and not in `ai`
 *
 * A repair has to be able to describe a compile failure, and `packages/ai` may
 * not import the compiler. `GenerationFailure` is the reconciled vocabulary that
 * already spans both, so the only package that can format all of them is the one
 * that owns that vocabulary. The alternative, two repair prompts that drift, is
 * worse than one prompt in the orchestrator.
 *
 * ## One deviation from the spec's example
 *
 * AI_SPEC's sample prompt prints an `Expected:` line per failure, which reads as
 * though the validators carry an `expected` field. They do not. `ValidationError`
 * has `code`, `path`, `message`, and an untyped `details` bag, and across every
 * validator the keys actually emitted are `capability`, `node_id`, `parameter`,
 * `pattern`, `value`, `reason`, `limit`, `allowed`, and `actual`. There is no
 * `expected` anywhere.
 *
 * The expectation is already in `message`, which `ffir` documents as "specific
 * enough to act on without reading the code". So `message` is printed as the
 * explanation rather than a field being invented to match the example, and
 * `value` is printed only when a failure actually carries one. Manufacturing an
 * `Expected:` line from a template would produce confident text that is
 * sometimes wrong, which is the one thing a repair prompt must never do.
 */

import type { GenerationFailure } from "./errors.js";

/** Detail keys this formatter reads. Anything else stays in `details` for logs. */
const NODE_KEY = "node_id";
const PARAMETER_KEY = "parameter";
const VALUE_KEY = "value";

/**
 * Failures worth sending back to the model.
 *
 * A terminal failure is not repairable by definition, and including one would
 * ask the model to fix something it cannot reach. A `verify` compile failure is
 * the clearest case: our emitter produced something structurally wrong, and no
 * amount of asking the model to try again changes that.
 */
export function repairable(
  failures: readonly GenerationFailure[],
): GenerationFailure[] {
  return failures.filter((failure) => failure.recovery === "repair");
}

/**
 * Builds the user turn that asks for a fix.
 *
 * Returns `undefined` when nothing is repairable, so the caller cannot
 * accidentally send an empty complaint. That is a real case: a run whose only
 * failure is terminal must go to the error path, not to the model.
 */
export function buildRepairPrompt(
  failures: readonly GenerationFailure[],
): string | undefined {
  const items = repairable(failures);
  if (items.length === 0) return undefined;

  const lines: string[] = [
    "The workflow you produced did not validate. Here are the specific problems:",
    "",
  ];

  items.forEach((failure, index) => {
    lines.push(`[${index + 1}] ${locate(failure)}`);
    lines.push(`    Code: ${failure.code}`);

    const value = failure.details?.[VALUE_KEY];
    if (value !== undefined) lines.push(`    Value: ${format(value)}`);

    lines.push(`    ${failure.message}`);
    lines.push("");
  });

  lines.push(
    "Fix exactly these problems. Return the complete corrected workflow in the",
    "same format. Do not change anything that was not flagged.",
  );

  return lines.join("\n");
}

/**
 * Names where the failure is, most specific first.
 *
 * `nodeId` is promoted onto the failure itself by `errors.ts`, but `parameter`
 * stays in `details`, so both are read. A failure with neither is a document
 * level problem and says so rather than pretending to a location.
 */
function locate(failure: GenerationFailure): string {
  const nodeId = failure.nodeId ?? asString(failure.details?.[NODE_KEY]);
  const parameter = asString(failure.details?.[PARAMETER_KEY]);

  if (nodeId !== undefined && parameter !== undefined) {
    return `node ${JSON.stringify(nodeId)}, parameter ${JSON.stringify(parameter)}`;
  }
  if (nodeId !== undefined) return `node ${JSON.stringify(nodeId)}`;
  if (failure.path !== undefined && failure.path !== "") return `at ${failure.path}`;
  return "document";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** JSON so an empty string, a number, and the string "3" are distinguishable. */
function format(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
