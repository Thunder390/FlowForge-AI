/**
 * Building the closed JSON schema pass B's output is constrained to.
 *
 * This is the strongest guarantee in the pipeline. Because pass A has already
 * committed to a set of capabilities and node ids, the exact parameter schema
 * for *this specific workflow* can be constructed from registry data at request
 * time. With `additionalProperties: false` at every level, the model **cannot**
 * emit a parameter name that does not exist. Not "is unlikely to". Cannot: the
 * API enforces it.
 *
 * What remains is invented parameter *values*, which the validator catches with
 * the registry's `pattern` and `one_of` rules. That is the division of labour
 * this file exists to create.
 *
 * ## What the schema cannot carry
 *
 * Structured outputs supports neither `pattern` nor `minLength` nor `minimum`,
 * so none of them appear here. Those constraints are enforced by validation
 * stage 3 instead, and the schema bundle states them in prose so the model
 * knows about them before it writes rather than only after it fails. A schema
 * that quietly carried them would be rejected by the API, which is a better
 * failure than being ignored, but neither is a reason to write one.
 *
 * ## Which parameters are required
 *
 * AI_SPEC's rule is that an optional parameter is omitted from `required` when
 * the registry gives it a default, and otherwise included with the model told
 * to emit an empty string when it does not apply. That is right for strings and
 * wrong for everything else: `""` is not a legal `number`, `boolean`, `array`,
 * or `object`, so forcing those keys would manufacture a stage 3 type failure
 * on every single generation, and the repair loop cannot fix a value the schema
 * requires. Nor is `""` legal for a string carrying a `pattern`, a `min_length`,
 * or `not_empty`.
 *
 * So the rule implemented here is: required in the registry means required in
 * the schema; otherwise the key is required only when the empty string is a
 * value that would actually survive validation. `additionalProperties: false`
 * is what closes the name set, and that is untouched either way, so nothing
 * about the central guarantee rests on this.
 *
 * ## Parameters that cannot be expressed at all
 *
 * An `object` parameter with no declared `fields` is opaque by design: HTTP
 * headers and a Block Kit payload have no fixed key set. A closed schema cannot
 * describe one, because `additionalProperties` may only be `false`. Such a
 * parameter is dropped from the schema and reported. Dropping an optional one
 * is a real but bounded loss, the model cannot set it and a person still can.
 * A *required* one would leave pass B unable to produce a valid document at
 * all, so that is an error rather than a warning.
 */

import type { JsonSchema } from "./provider/types.js";
import {
  resolve,
  type Capability,
  type ParameterDefinition,
  type ParameterValue,
  type Registry,
} from "@flowforge/registry";

/** One node the schema must carry a property for. */
export interface SchemaNode {
  id: string;
  capability: string;
}

export const SYNTHESIS_ISSUE_CODES = [
  /** The capability is not in this registry. Stage 2 and the ladder own this. */
  "unknown_capability",
  /** Two planned nodes share an id. One property cannot serve both. */
  "duplicate_node_id",
  /** An object with no declared fields, or an array of them. Not expressible closed. */
  "open_object_parameter",
  /** An enum whose values are not all JSON primitives. */
  "unrepresentable_parameter",
] as const;
export type SynthesisIssueCode = (typeof SYNTHESIS_ISSUE_CODES)[number];

export interface SynthesisIssue {
  code: SynthesisIssueCode;
  /** `error` means pass B cannot produce a valid document; `warning` means a loss. */
  severity: "error" | "warning";
  message: string;
  nodeId?: string;
  capability?: string;
  /** Dotted path within the parameters object, when the issue is about one. */
  parameter?: string;
}

export interface SynthesisResult {
  /** The closed object schema, one property per node id. */
  schema: JsonSchema;
  issues: SynthesisIssue[];
  /** True when no issue has `severity: "error"`. */
  ok: boolean;
}

/**
 * Builds the pass B output schema for a planned graph.
 *
 * Node order follows the order given, which is the plan's order, so two
 * identical plans synthesize byte-identical schemas. That matters more than it
 * looks: the schema is part of the request, the request is part of the prompt
 * cache key, and a schema whose key order wandered would miss the cache on
 * every request while still working.
 */
export function synthesizeParameterSchema(
  nodes: readonly SchemaNode[],
  registry: Registry,
): SynthesisResult {
  const issues: SynthesisIssue[] = [];
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const seen = new Set<string>();

  for (const node of nodes) {
    if (seen.has(node.id)) {
      issues.push({
        code: "duplicate_node_id",
        severity: "error",
        nodeId: node.id,
        capability: node.capability,
        message: `Two nodes share the id "${node.id}". Every node id must be unique, because the parameter object is keyed by it.`,
      });
      continue;
    }
    seen.add(node.id);

    const resolved = resolve(registry, node.capability);
    if (resolved === undefined) {
      issues.push({
        code: "unknown_capability",
        severity: "error",
        nodeId: node.id,
        capability: node.capability,
        message: `Node "${node.id}" uses capability "${node.capability}", which this registry does not contain, so its parameter shape is unknown.`,
      });
      continue;
    }

    properties[node.id] = objectSchemaFor(resolved.capability, node, issues);
    required.push(node.id);
  }

  return {
    schema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    issues,
    ok: !issues.some((issue) => issue.severity === "error"),
  };
}

/** One node's parameter object: the capability's declared parameters, closed. */
function objectSchemaFor(
  capability: Capability,
  node: SchemaNode,
  issues: SynthesisIssue[],
): JsonSchema {
  return closedObject(capability.parameters, node, capability, issues, []);
}

/**
 * One level of a parameters object.
 *
 * Walks the registry's declaration order rather than any other, so the property
 * order is a property of the registry build and not of iteration luck.
 */
function closedObject(
  declared: Readonly<Record<string, ParameterDefinition>>,
  node: SchemaNode,
  capability: Capability,
  issues: SynthesisIssue[],
  path: readonly string[],
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const [name, definition] of Object.entries(declared)) {
    const here = [...path, name];
    const converted = toJsonSchema(definition);

    if (converted === undefined) {
      issues.push({
        code:
          definition.type === "enum" ? "unrepresentable_parameter" : "open_object_parameter",
        // A required parameter the schema cannot describe leaves pass B unable
        // to produce a document that validates, and no repair can add a key the
        // schema forbids. An optional one is only a capability we give up.
        severity: definition.required ? "error" : "warning",
        nodeId: node.id,
        capability: capability.id,
        parameter: here.join("."),
        message: describeUnrepresentable(node, capability, here.join("."), definition),
      });
      continue;
    }

    properties[name] = converted;
    if (isRequiredInSchema(definition)) required.push(name);
  }

  return { type: "object", properties, required, additionalProperties: false };
}

/**
 * Whether the model must emit this key.
 *
 * See the module note. The short version: a registry-required parameter is
 * always required; an optional one is required only when the empty string,
 * which is the sentinel the prompt tells the model to use, is a value that
 * would actually pass validation.
 */
export function isRequiredInSchema(definition: ParameterDefinition): boolean {
  if (definition.required) return true;
  if (definition.default !== undefined) return false;
  return emptyStringIsLegal(definition);
}

/** True when `""` would survive validation stage 3 for this parameter. */
export function emptyStringIsLegal(definition: ParameterDefinition): boolean {
  if (definition.type !== "string") return false;

  const rules = definition.validation;
  if (rules === undefined) return true;
  if (rules.pattern !== undefined) return false;
  if (rules.not_empty === true) return false;
  if (rules.min_length !== undefined && rules.min_length > 0) return false;
  if (rules.one_of !== undefined && !rules.one_of.includes("")) return false;
  return true;
}

/**
 * A registry parameter as JSON Schema, or `undefined` when it cannot be one.
 *
 * Nested objects and arrays recurse. A nested level that drops an optional
 * field does so silently here and is reported by the caller, because the issue
 * list wants the node id and this function does not have it.
 */
function toJsonSchema(definition: ParameterDefinition): JsonSchema | undefined {
  const description = definition.description;

  switch (definition.type) {
    case "string":
      return { type: "string", description };

    // `datetime` is a string. `format: "date-time"` is tempting and wrong: our
    // own validator accepts a bare date, so declaring the stricter format would
    // have the API reject values the registry considers legal. The shape is
    // stated in the description instead, and stage 3 remains the authority.
    case "datetime":
      return { type: "string", description };

    case "number":
      return { type: "number", description };

    case "boolean":
      return { type: "boolean", description };

    case "enum":
      return enumSchema(definition, description);

    case "array": {
      const items = definition.items === undefined ? undefined : toJsonSchema(definition.items);
      return items === undefined ? undefined : { type: "array", description, items };
    }

    case "object": {
      // Opaque by design, and therefore not expressible in a closed schema.
      if (definition.fields === undefined) return undefined;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [name, field] of Object.entries(definition.fields)) {
        const converted = toJsonSchema(field);
        // A required nested field we cannot describe makes the whole object
        // undescribable; an optional one is merely dropped.
        if (converted === undefined) {
          if (field.required) return undefined;
          continue;
        }
        properties[name] = converted;
        if (isRequiredInSchema(field)) required.push(name);
      }
      return { type: "object", description, properties, required, additionalProperties: false };
    }
  }
}

/**
 * An enum's closed list.
 *
 * Narrowed to a JSON primitive type when every value shares one, because a
 * typed enum is a stronger constraint and reads better in the prompt. A value
 * that is not a primitive at all cannot be expressed.
 */
function enumSchema(
  definition: ParameterDefinition,
  description: string,
): JsonSchema | undefined {
  const values = definition.values ?? [];
  if (values.length === 0) return undefined;
  if (!values.every(isJsonPrimitive)) return undefined;

  const primitives = values as (string | number | boolean | null)[];
  const kinds = new Set(primitives.map((value) => typeof value));
  const type =
    kinds.size !== 1
      ? undefined
      : kinds.has("string")
        ? ("string" as const)
        : kinds.has("number")
          ? ("number" as const)
          : kinds.has("boolean")
            ? ("boolean" as const)
            : undefined;

  return { ...(type === undefined ? {} : { type }), description, enum: primitives };
}

function isJsonPrimitive(value: ParameterValue): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function describeUnrepresentable(
  node: SchemaNode,
  capability: Capability,
  parameter: string,
  definition: ParameterDefinition,
): string {
  const subject = `Parameter "${parameter}" of ${capability.id} on node "${node.id}"`;

  if (definition.type === "enum") {
    return `${subject} is an enum whose allowed values are not all JSON primitives, so it cannot appear in a structured-output schema. The model will not be asked to fill it.`;
  }

  return (
    `${subject} accepts an object with no declared fields, which a closed schema cannot describe: ` +
    `structured outputs allows \`additionalProperties\` to be \`false\` and nothing else. ` +
    (definition.required
      ? `It is required, so pass B cannot produce a document that validates. Give the parameter declared fields in the registry, or make it optional.`
      : `The model will not be asked to fill it; a person still can.`)
  );
}
