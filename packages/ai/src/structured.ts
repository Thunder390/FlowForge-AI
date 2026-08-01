/**
 * Parsing model output against the schema it was constrained to.
 *
 * The check is deliberately redundant on a provider with strict structured
 * outputs, and deliberately kept anyway. The guarantee that the output matches
 * the schema belongs to the *provider*, not to the architecture: it weakens on
 * a provider without the feature, and it does not apply at all on a replay
 * fixture, which is what every test below M9 runs against. A pass that trusted
 * the shape would be a pass whose tests prove nothing about the real path.
 *
 * Nothing here knows about a model provider. It takes text and a schema and
 * either returns typed data or says precisely what was wrong with it, which is
 * also what the repair prompt needs.
 */

import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020Module from "ajv/dist/2020.js";

import type { JsonSchema } from "./provider/types.js";

// ajv v8 ships as CommonJS; depending on the loader the constructor arrives
// either as the module or under `.default`. Same dance as `ffir`.
const Ajv2020 = ((Ajv2020Module as unknown as { default?: unknown }).default ??
  Ajv2020Module) as typeof Ajv2020Module;

const ajv = new Ajv2020({ allErrors: true, strict: true });

/**
 * Compiled validators, keyed by the schema object.
 *
 * Pass A's schema is a module constant and compiles once for the process. Pass
 * B's is synthesized per workflow and compiles once per generation, which is
 * the cost of the guarantee and is not close to being the expensive part of a
 * generation.
 */
const compiled = new WeakMap<JsonSchema, ValidateFunction>();

export const OUTPUT_ERROR_CODES = ["malformed_json", "schema_violation"] as const;
export type OutputErrorCode = (typeof OUTPUT_ERROR_CODES)[number];

/**
 * Model output that did not survive parsing.
 *
 * `issues` is the list the repair prompt prints. It names paths within the
 * output rather than describing the problem in general, because vague feedback
 * produces vague fixes.
 */
export class OutputError extends Error {
  readonly code: OutputErrorCode;
  readonly issues: string[];
  /** The schema that was violated, for tracing. */
  readonly schemaName: string;

  constructor(code: OutputErrorCode, schemaName: string, issues: string[]) {
    super(
      `Model output did not match the "${schemaName}" schema: ${issues.join("; ")}`,
    );
    this.name = "OutputError";
    this.code = code;
    this.schemaName = schemaName;
    this.issues = issues;
  }
}

/**
 * Parses and validates one structured response.
 *
 * Throws rather than returning a result, because every caller's response to a
 * failure is the same, hand it to the repair loop, and a checked result would
 * be unwrapped identically at each of them.
 */
export function parseStructured<T>(
  text: string,
  schema: JsonSchema,
  schemaName: string,
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfence(text));
  } catch (cause) {
    throw new OutputError("malformed_json", schemaName, [
      cause instanceof Error ? cause.message : String(cause),
    ]);
  }

  const validate = validatorFor(schema);
  if (!validate(parsed)) {
    throw new OutputError(
      "schema_violation",
      schemaName,
      (validate.errors ?? []).map(describe),
    );
  }

  return parsed as T;
}

function validatorFor(schema: JsonSchema): ValidateFunction {
  const existing = compiled.get(schema);
  if (existing !== undefined) return existing;

  const validate = ajv.compile(schema as object);
  compiled.set(schema, validate);
  return validate;
}

/**
 * Strips a markdown code fence, if one is present.
 *
 * A provider with strict structured outputs never produces one. A provider
 * without it produces one often enough that rejecting the response over
 * punctuation would burn a repair attempt on something no repair prompt could
 * usefully explain. The unfenced text still has to parse and still has to
 * validate, so nothing is being trusted here that was not already checked.
 */
export function unfence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;

  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline === -1) return trimmed;

  const withoutOpener = trimmed.slice(firstNewline + 1);
  const closer = withoutOpener.lastIndexOf("```");
  return (closer === -1 ? withoutOpener : withoutOpener.slice(0, closer)).trim();
}

/** Ajv's English is accurate and unhelpful; this names the property it means. */
function describe(error: ErrorObject): string {
  const where = error.instancePath === "" ? "the output" : error.instancePath;
  const params = error.params as Record<string, unknown>;

  switch (error.keyword) {
    case "required":
      return `${where} is missing the required property "${String(params["missingProperty"])}"`;
    case "additionalProperties":
      return `${where} has the property "${String(params["additionalProperty"])}", which this schema does not allow`;
    case "enum": {
      const allowed = params["allowedValues"];
      return `${where} must be one of: ${Array.isArray(allowed) ? allowed.join(", ") : String(allowed)}`;
    }
    case "type":
      return `${where} must be of type ${String(params["type"])}`;
    default:
      return `${where} ${error.message ?? "failed validation"}`;
  }
}
