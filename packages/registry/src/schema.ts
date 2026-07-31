/**
 * Artifact schema conformance.
 *
 * A registry build is an immutable published artifact that the loader trusts
 * downstream of this check and nowhere else. If the registry is wrong,
 * everything downstream is confidently wrong, so a malformed artifact fails at
 * load with a pointer into the file rather than as an undefined three layers
 * later inside a compiler.
 *
 * The three schemas mirror the three artifact kinds in the build layout:
 * `capabilities/<integration>.json`, `bindings/<platform>/<integration>.json`,
 * and `index.json`.
 */

import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020Module from "ajv/dist/2020.js";

import bindingFileSchema from "./binding-file.schema.json" with { type: "json" };
import capabilityFileSchema from "./capability-file.schema.json" with { type: "json" };
import registryIndexSchema from "./registry-index.schema.json" with { type: "json" };
import type { BindingFile, CapabilityFile, RegistryIndex } from "./types.js";

export {
  bindingFileSchema,
  capabilityFileSchema,
  registryIndexSchema,
};

// ajv v8 is published as CommonJS. Depending on which loader resolves it, the
// constructor arrives either as the module itself or under `.default`.
const Ajv2020 = ((Ajv2020Module as unknown as { default?: unknown }).default ??
  Ajv2020Module) as typeof Ajv2020Module;

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  messages: true,
});

const validateCapabilityFileSchema: ValidateFunction = ajv.compile(capabilityFileSchema);
const validateBindingFileSchema: ValidateFunction = ajv.compile(bindingFileSchema);
const validateRegistryIndexSchema: ValidateFunction = ajv.compile(registryIndexSchema);

/** One schema failure, located by JSON Pointer into the artifact. */
export interface SchemaViolation {
  /** JSON Pointer into the artifact. `""` means the artifact as a whole. */
  path: string;
  message: string;
  keyword: string;
}

export interface SchemaCheckResult<T> {
  ok: boolean;
  violations: SchemaViolation[];
  /** Present only when `ok`. */
  value?: T;
}

export function checkCapabilityFile(input: unknown): SchemaCheckResult<CapabilityFile> {
  return run<CapabilityFile>(validateCapabilityFileSchema, input);
}

export function checkBindingFile(input: unknown): SchemaCheckResult<BindingFile> {
  return run<BindingFile>(validateBindingFileSchema, input);
}

export function checkRegistryIndex(input: unknown): SchemaCheckResult<RegistryIndex> {
  return run<RegistryIndex>(validateRegistryIndexSchema, input);
}

/**
 * Ajv validators are stateful: `errors` belongs to the last call. Reading it
 * immediately and never handing the validator out is what keeps these functions
 * safe to call from anywhere.
 */
function run<T>(validate: ValidateFunction, input: unknown): SchemaCheckResult<T> {
  if (validate(input)) {
    return { ok: true, violations: [], value: input as T };
  }
  return {
    ok: false,
    violations: (validate.errors ?? []).map(toViolation),
  };
}

function toViolation(error: ErrorObject): SchemaViolation {
  return {
    path: error.instancePath,
    message: describe(error),
    keyword: error.keyword,
  };
}

/**
 * Ajv's defaults are accurate and unhelpful. "must NOT have additional
 * properties" without naming the property is the single most common complaint
 * about schema tooling, and a curator hand-editing a capability file is exactly
 * the reader who needs to be told which key is wrong.
 */
function describe(error: ErrorObject): string {
  const where = error.instancePath === "" ? "The artifact" : error.instancePath;
  const params = error.params as Record<string, unknown>;

  switch (error.keyword) {
    case "required":
      return `${where} is missing the required property "${String(params["missingProperty"])}".`;
    case "additionalProperties":
      return `${where} has an unrecognised property "${String(params["additionalProperty"])}". Registry artifacts are closed: an unknown field is a defect, not an extension point.`;
    case "propertyNames":
      return `${where} has a property name that is not a legal identifier.`;
    case "enum": {
      const allowed = params["allowedValues"];
      return `${where} must be one of: ${Array.isArray(allowed) ? allowed.join(", ") : String(allowed)}.`;
    }
    case "type":
      return `${where} must be of type ${String(params["type"])}.`;
    case "pattern":
      return `${where} does not match the required format ${String(params["pattern"])}.`;
    case "oneOf":
      return `${where} does not match exactly one of the permitted shapes. A binding names an n8n node type, a Make module, or a Zapier app and action.`;
    case "false schema":
      return `${where} is present, and this combination forbids it. Only a capability with kind "trigger" may declare a trigger block.`;
    case "if":
      return `${where} breaks a rule that depends on its own field values: a trigger capability declares a trigger block and nothing else may, a deprecated capability names its replacement, and an enum lists its values.`;
    case "minItems":
      return `${where} must not be empty.`;
    case "minProperties":
      return `${where} must declare at least one property rather than being present and empty.`;
    case "maxProperties":
      return `${where} must declare exactly one property.`;
    case "minLength":
      return `${where} must not be empty.`;
    case "minimum":
      return `${where} must be at least ${String(params["limit"])}.`;
    case "exclusiveMinimum":
      return `${where} must be greater than ${String(params["limit"])}.`;
    default:
      return `${where} ${error.message ?? "failed schema validation"}.`;
  }
}
