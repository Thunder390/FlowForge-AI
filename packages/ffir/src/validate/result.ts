import type { ErrorCode } from "./codes.js";
import { ERROR_CLASS, type ErrorClass } from "./codes.js";

export interface ValidationError {
  code: ErrorCode;
  /** JSON Pointer into the document. `""` means the document as a whole. */
  path: string;
  /** Human-readable, and specific enough to act on without reading the code. */
  message: string;
  /** Machine-readable specifics: the limit name, the actual value, and so on. */
  details?: Record<string, unknown>;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

/**
 * Builds a result from a collected error list. Named for the common case; an
 * empty list is a pass, which is what lets every check append unconditionally
 * and return once.
 */
export function invalid(errors: ValidationError[]): ValidationResult {
  return { ok: errors.length === 0, errors };
}

/** True when any error is terminal, meaning a repair attempt is pointless. */
export function isTerminal(result: ValidationResult): boolean {
  return result.errors.some((e) => ERROR_CLASS[e.code] === "terminal");
}

export function classOf(error: ValidationError): ErrorClass {
  return ERROR_CLASS[error.code];
}
