/**
 * The structural validation stages that live in `ffir`.
 *
 * Stages 2 and 3 are registry-dependent and therefore live in `registry`, which
 * `ffir` must not depend on. Stage 4 arrives with the graph validator.
 *
 * Validation does not trust its input's origin. Every document passes the same
 * pipeline whether it came from the model, a human, or the public marketplace,
 * because the strongest guarantee in the system is a property of one model
 * provider and nothing is allowed to depend on it alone.
 */

import { ErrorCode } from "./codes.js";
import { checkLimits, type LimitCheckOptions } from "./limits.js";
import { checkSchema } from "./schema.js";
import { invalid, type ValidationResult } from "./result.js";

export { checkLimits, type LimitCheckOptions } from "./limits.js";
export { checkSchema, isFFIRDocument, ffirJsonSchema } from "./schema.js";
export {
  ErrorCode,
  ERROR_CLASS,
  RULE_CODES,
  type ErrorClass,
} from "./codes.js";
export {
  isTerminal,
  classOf,
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
