/**
 * Validation stage 0: document limits (rule 19).
 *
 * Runs before schema conformance, on every document regardless of origin. The
 * input is therefore `unknown` and this module must never throw on a hostile
 * shape: anything it cannot interpret it skips and leaves for stage 1 to
 * report. Its job is to bound cost, not to describe structure.
 *
 * Exceeding a limit is terminal. There is no repair prompt for "your document
 * is too big".
 */

import { DOCUMENT_LIMITS, type LimitName } from "../limits.js";
import { escapePointer } from "../pointer.js";
import { ErrorCode } from "./codes.js";
import { invalid, type ValidationError, type ValidationResult } from "./result.js";

const encoder = new TextEncoder();

export interface LimitCheckOptions {
  /**
   * Byte length of the document as received on the wire. Supply it when the
   * raw text is available: it is what an attacker actually sends, and it
   * accounts for whitespace that re-serializing discards.
   */
  rawByteLength?: number;
}

/** A single expression occurrence found by the scanner. */
interface FoundExpression {
  /** Full text including the braces. */
  raw: string;
  /** Character length including the braces, measured against the length limit. */
  length: number;
  /**
   * Levels of traversal the reference walks: dot-separated components after
   * the root, plus one per bracket index. `n_http.body.items[0].id` is 4.
   * This bounds parse cost without requiring the parser, which does not exist
   * until the expression grammar ships.
   */
  depth: number;
}

const EXPRESSION_PATTERN = /\{\{([\s\S]*?)\}\}/g;

/**
 * Finds expression occurrences in a string. Deliberately a scanner and not a
 * parser: stage 0 bounds resource use and must run before grammar dispatch.
 */
export function scanExpressions(text: string): FoundExpression[] {
  const found: FoundExpression[] = [];
  EXPRESSION_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EXPRESSION_PATTERN.exec(text)) !== null) {
    const raw = match[0];
    const inner = (match[1] ?? "").trim();
    found.push({ raw, length: raw.length, depth: pathDepth(inner) });
  }
  return found;
}

function pathDepth(inner: string): number {
  if (inner === "") return 0;
  const components = inner.split(".");
  const afterRoot = Math.max(0, components.length - 1);
  const brackets = (inner.match(/\[/g) ?? []).length;
  return afterRoot + brackets;
}

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function limitError(
  limit: LimitName,
  actual: number,
  path: string,
  what: string,
): ValidationError {
  const max = DOCUMENT_LIMITS[limit];
  return {
    code: ErrorCode.DOCUMENT_LIMIT_EXCEEDED,
    path,
    message: `${what} exceeds the ${limit} limit: ${actual} against a maximum of ${max}.`,
    details: { limit, max, actual },
  };
}

/**
 * Walks a parameter value collecting every expression in every nested string.
 */
function collectExpressions(value: unknown, into: FoundExpression[]): void {
  if (typeof value === "string") {
    into.push(...scanExpressions(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectExpressions(item, into);
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) collectExpressions(value[key], into);
  }
}

/**
 * Checks a document against every limit in the limits table, collecting all
 * failures rather than stopping at the first.
 */
export function checkLimits(
  input: unknown,
  options: LimitCheckOptions = {},
): ValidationResult {
  if (!isPlainObject(input)) {
    return invalid([
      {
        code: ErrorCode.DOCUMENT_MALFORMED,
        path: "",
        message: `An FFIR document must be a JSON object, received ${describe(input)}.`,
        details: { received: describe(input) },
      },
    ]);
  }

  const errors: ValidationError[] = [];

  // Total document size. Prefer the raw wire bytes when the caller has them.
  let documentBytes = options.rawByteLength;
  if (documentBytes === undefined) {
    try {
      documentBytes = byteLength(JSON.stringify(input) ?? "");
    } catch {
      return invalid([
        {
          code: ErrorCode.DOCUMENT_MALFORMED,
          path: "",
          message:
            "Document is not serializable as JSON, which usually means it contains a cycle or a BigInt.",
        },
      ]);
    }
  }
  if (documentBytes > DOCUMENT_LIMITS.max_document_bytes) {
    errors.push(limitError("max_document_bytes", documentBytes, "", "Document size in bytes"));
  }

  checkCollection(input["nodes"], "max_nodes", "/nodes", "Node count", errors);
  checkCollection(input["edges"], "max_edges", "/edges", "Edge count", errors);
  checkCollection(input["variables"], "max_variables", "/variables", "Variable count", errors);
  checkCollection(
    input["credentials"],
    "max_credentials",
    "/credentials",
    "Credential count",
    errors,
  );

  const nodes = input["nodes"];
  if (Array.isArray(nodes)) {
    nodes.forEach((node, index) => {
      if (!isPlainObject(node)) return;
      checkNodeParameters(node["parameters"], `/nodes/${index}/parameters`, errors);
    });
  }

  return invalid(errors);
}

function checkCollection(
  value: unknown,
  limit: LimitName,
  path: string,
  what: string,
  errors: ValidationError[],
): void {
  // A non-array is a schema problem, not a limits problem. Stage 1 reports it.
  if (!Array.isArray(value)) return;
  if (value.length > DOCUMENT_LIMITS[limit]) {
    errors.push(limitError(limit, value.length, path, what));
  }
}

function checkNodeParameters(
  parameters: unknown,
  path: string,
  errors: ValidationError[],
): void {
  if (!isPlainObject(parameters)) return;

  let payloadBytes: number;
  try {
    payloadBytes = byteLength(JSON.stringify(parameters) ?? "");
  } catch {
    return;
  }
  if (payloadBytes > DOCUMENT_LIMITS.max_parameter_payload_bytes) {
    errors.push(
      limitError("max_parameter_payload_bytes", payloadBytes, path, "Parameter payload in bytes"),
    );
  }

  for (const key of Object.keys(parameters)) {
    const parameterPath = `${path}/${escapePointer(key)}`;
    const expressions: FoundExpression[] = [];
    collectExpressions(parameters[key], expressions);

    if (expressions.length > DOCUMENT_LIMITS.max_expressions_per_parameter) {
      errors.push(
        limitError(
          "max_expressions_per_parameter",
          expressions.length,
          parameterPath,
          "Expression count",
        ),
      );
    }

    for (const expression of expressions) {
      if (expression.length > DOCUMENT_LIMITS.max_expression_length) {
        errors.push(
          limitError(
            "max_expression_length",
            expression.length,
            parameterPath,
            "Expression length in characters",
          ),
        );
      }
      if (expression.depth > DOCUMENT_LIMITS.max_expression_path_depth) {
        errors.push(
          limitError(
            "max_expression_path_depth",
            expression.depth,
            parameterPath,
            "Expression path depth",
          ),
        );
      }
    }
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}
