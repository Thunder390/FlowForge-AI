/**
 * The validation stages that live in `ffir`: 0, 1, and 4.
 *
 * Stages 2 and 3 are registry-dependent and therefore live in `ai`, which owns
 * the registry join. `ffir` must not depend on the registry, so no function
 * here can claim to have run the whole pipeline.
 *
 * Validation does not trust its input's origin. Every document passes the same
 * pipeline whether it came from the model, a human, or the public marketplace,
 * because the strongest guarantee in the system is a property of one model
 * provider and nothing is allowed to depend on it alone.
 */

import { ErrorCode } from "./codes.js";
import { checkGraph } from "./graph.js";
import { checkLimits, type LimitCheckOptions } from "./limits.js";
import { checkSchema } from "./schema.js";
import { invalid, type ValidationResult } from "./result.js";
import type { FFIRDocument } from "../types.js";

export { checkLimits, type LimitCheckOptions } from "./limits.js";
export { checkSchema, isFFIRDocument, ffirJsonSchema } from "./schema.js";
export { checkGraph, GRAPH_RULES, RULE_OWNERSHIP } from "./graph.js";
export {
  findSecret,
  isSecretFieldName,
  shannonEntropy,
  SECRET_PATTERNS,
  type SecretMatch,
  type SecretPattern,
  type SecretScanOptions,
} from "./secrets.js";
export {
  ErrorCode,
  ERROR_CLASS,
  RULE_CODES,
  type ErrorClass,
} from "./codes.js";
export {
  isTerminal,
  classOf,
  // Exported for the registry-dependent stages, which live outside this package
  // and must not reinvent "a result is ok when the error list is empty".
  invalid,
  type ValidationError,
  type ValidationResult,
} from "./result.js";

/**
 * Runs stage 0 then stage 1.
 *
 * Stage 0 short-circuits: a document that breaches a resource limit is not
 * handed to the schema validator, because doing so is the attack the limits
 * exist to stop. Within a stage, all failures are collected.
 */
export function validateStructure(
  input: unknown,
  options: LimitCheckOptions = {},
): ValidationResult {
  const limits = checkLimits(input, options);
  if (!limits.ok) return limits;

  return checkSchema(input);
}

/**
 * Runs every stage `ffir` owns: 0, 1, and 4.
 *
 * Named for what it omits. Stages 2 and 3 resolve capabilities and parameter
 * schemas against the registry, which lives outside this package, so a caller
 * that stops here has *not* validated the document. The compiler and the
 * pipeline both compose this with the registry stages; nothing should treat a
 * pass from this function as a green light to emit.
 *
 * Stage 4 runs only when stages 0 and 1 pass, because the graph rules assume a
 * document whose shape has already been proven.
 */
export function validateWithoutRegistry(
  input: unknown,
  options: LimitCheckOptions = {},
): ValidationResult {
  const structure = validateStructure(input, options);
  if (!structure.ok) return structure;

  return checkGraph(input as FFIRDocument);
}

/** Convenience for callers holding the raw request body rather than parsed JSON. */
export function validateStructureFromText(text: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return invalid([
      {
        code: ErrorCode.DOCUMENT_MALFORMED,
        path: "",
        message: `Document is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      },
    ]);
  }
  return validateStructure(parsed, {
    rawByteLength: new TextEncoder().encode(text).length,
  });
}
