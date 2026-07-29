/**
 * Validation stage 1: schema conformance.
 *
 * Runs after stage 0 has bounded the document's size, because handing an
 * unbounded document to a schema validator is the denial-of-service the limits
 * exist to prevent.
 *
 * Collects all failures rather than stopping at the first, because the repair
 * prompt needs the complete list to fix everything in one retry.
 */

import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020Module from "ajv/dist/2020.js";

import schema from "../schema.json" with { type: "json" };
import { SUPPORTED_FFIR_VERSIONS, type FFIRDocument } from "../types.js";
import { ErrorCode } from "./codes.js";
import { invalid, type ValidationError, type ValidationResult } from "./result.js";

export { schema as ffirJsonSchema };

// ajv v8 is published as CommonJS. Depending on which loader resolves it, the
// constructor arrives either as the module itself or under `.default`.
const Ajv2020 = ((Ajv2020Module as unknown as { default?: unknown }).default ??
  Ajv2020Module) as typeof Ajv2020Module;

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  // Every failure is reported through our own error vocabulary, so ajv's
  // English is a fallback rather than the product.
  messages: true,
});

const validateSchema: ValidateFunction = ajv.compile(schema);

/**
 * Checks the document against the FFIR JSON Schema and confirms this build
 * implements the version it declares.
 *
 * A document whose version is newer than this build is rejected rather than
 * optimistically parsed. Guessing at the semantics of a field we do not know
 * is how a silent miscompile ships.
 */
export function checkSchema(input: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  const declared = readDeclaredVersion(input);
  if (declared !== undefined && !isSupportedVersion(declared)) {
    errors.push({
      code: ErrorCode.FFIR_VERSION_UNSUPPORTED,
      path: "/ffir_version",
      message: `This build implements FFIR ${SUPPORTED_FFIR_VERSIONS.join(", ")} and cannot read version ${declared}.`,
      details: { declared, supported: [...SUPPORTED_FFIR_VERSIONS] },
    });
  }

  if (!validateSchema(input)) {
    for (const ajvError of validateSchema.errors ?? []) {
      errors.push(toValidationError(ajvError));
    }
  }

  return invalid(errors);
}

/**
 * Narrows `unknown` to `FFIRDocument` once stages 0 and 1 have both passed.
 * This is the only place in the codebase that asserts the type, so everything
 * downstream can rely on it having been earned.
 */
export function isFFIRDocument(input: unknown): input is FFIRDocument {
  return checkSchema(input).ok;
}

function readDeclaredVersion(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const value = (input as Record<string, unknown>)["ffir_version"];
  return typeof value === "string" ? value : undefined;
}

function isSupportedVersion(version: string): boolean {
  return (SUPPORTED_FFIR_VERSIONS as readonly string[]).includes(version);
}

function toValidationError(error: ErrorObject): ValidationError {
  const details: Record<string, unknown> = {
    keyword: error.keyword,
    schemaPath: error.schemaPath,
  };
  if (error.params && Object.keys(error.params).length > 0) {
    details["params"] = error.params;
  }

  return {
    code: ErrorCode.SCHEMA_VIOLATION,
    path: error.instancePath,
    message: describe(error),
    details,
  };
}

/**
 * Turns an ajv error into something a person can act on. Ajv's defaults are
 * accurate and unhelpful: "must NOT have additional properties" without naming
 * the property is the single most common complaint about schema tooling.
 */
function describe(error: ErrorObject): string {
  const where = error.instancePath === "" ? "The document" : error.instancePath;
  const params = error.params as Record<string, unknown>;

  switch (error.keyword) {
    case "required":
      return `${where} is missing the required property "${String(params["missingProperty"])}".`;
    case "additionalProperties":
      return `${where} has an unrecognised property "${String(params["additionalProperty"])}". FFIR documents are closed: an unknown field is a defect, not an extension point.`;
    case "enum": {
      const allowed = params["allowedValues"];
      return `${where} must be one of: ${Array.isArray(allowed) ? allowed.join(", ") : String(allowed)}.`;
    }
    case "type":
      return `${where} must be of type ${String(params["type"])}.`;
    case "pattern":
      return `${where} does not match the required format ${String(params["pattern"])}.`;
    case "minLength":
      return `${where} must not be empty.`;
    case "minimum":
      return `${where} must be at least ${String(params["limit"])}.`;
    case "not":
      return `${where} has a property that is forbidden in this combination. A condition using is_empty or is_not_empty must not carry a "right" operand.`;
    default:
      return `${where} ${error.message ?? "failed schema validation"}.`;
  }
}
