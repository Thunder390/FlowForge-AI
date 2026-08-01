/**
 * Named parameter transforms: a closed, unit-tested table.
 *
 * A binding maps an FFIR parameter to a platform path, and sometimes the value
 * needs reshaping on the way. `combine_by_fields` is an array in FFIR and a
 * comma-separated string in n8n; `assignments` is a list of field-and-value
 * pairs in FFIR and a nested collection of typed entries in n8n. A binding names
 * the reshaping it needs and this table supplies it.
 *
 * ## Why the table is closed
 *
 * Registry data never contains executable code. A `transform` value is a *name*
 * that must already exist here, not a snippet to evaluate. Generated data that
 * can execute is a supply chain, not a config file: the registry is built by a
 * tool from an upstream package plus an overlay, and an overlay that could ship
 * a function would let anyone who lands a curation PR run code inside the
 * compiler.
 *
 * The cost is that adding a transform is a code change with a test, which is
 * the intended friction.
 *
 * ## Transforms run after expression compilation
 *
 * By the time a value reaches a transform, its strings are already in the
 * target's expression syntax. That ordering matters for `object_to_json_string`:
 * it serializes a body whose strings may contain `{{ ... }}`, and the `=` prefix
 * that marks an expression-bearing parameter is applied afterwards, to the
 * finished string, exactly once. A transform never has to think about it.
 */

import type { ParameterValue } from "@flowforge/ffir";

import { partUuid } from "./uuid.js";

/**
 * What a transform knows besides its value.
 *
 * Only what is needed to mint deterministic ids for nested structures. A
 * transform that wanted more than this would be doing lowering, and lowering is
 * not the transform table's job.
 */
export interface TransformContext {
  workflowId: string;
  nodeId: string;
  /** The FFIR parameter name being transformed, used to seed nested ids. */
  parameter: string;
}

export type TransformFn = (value: ParameterValue, ctx: TransformContext) => ParameterValue;

/** `snake_case` to `camelCase`. n8n spells its enum values the second way. */
export const enum_to_camel_case: TransformFn = (value) => {
  if (typeof value !== "string") return value;
  return value.replace(/_([a-z0-9])/g, (_, character: string) => character.toUpperCase());
};

/** `["a", "b"]` to `"a,b"`. n8n's field-matching parameters take one string. */
export const array_to_comma_string: TransformFn = (value) => {
  if (!Array.isArray(value)) return value;
  return value.map((item) => (typeof item === "string" ? item : String(item))).join(",");
};

/**
 * FFIR `assignments` to the entry list an n8n Set node takes.
 *
 * FFIR says `{ field, value }`. n8n v3.4 wants `{ id, name, value, type }`, and
 * the id has to be stable across compiles or every re-export is a diff. The
 * declared type is inferred from the value that is already there: a value
 * carrying an expression is `string`, because what it resolves to is unknowable
 * until the workflow runs and claiming otherwise would make n8n coerce it.
 */
export const assignments_to_set_fields: TransformFn = (value, ctx) => {
  if (!Array.isArray(value)) return value;

  return value.map((entry, index) => {
    const assignment = isRecord(entry) ? entry : {};
    const name = typeof assignment["field"] === "string" ? assignment["field"] : "";
    const assigned = assignment["value"] ?? "";

    return {
      id: partUuid(ctx.workflowId, ctx.nodeId, `${ctx.parameter}:${index}:${name}`),
      name,
      value: assigned,
      type: setFieldType(assigned),
    };
  });
};

/**
 * `{ "X-Key": "v" }` to n8n's fixed-collection shape.
 *
 * n8n stores repeatable name-value pairs as `{ parameters: [...] }` rather than
 * as an object. Key order follows the object's own, which stage 3 has already
 * pinned, so the same document always produces the same list.
 */
export const object_to_name_value_pairs: TransformFn = (value) => {
  if (!isRecord(value)) return value;

  return {
    parameters: Object.entries(value).map(([name, entry]) => ({
      name,
      value: typeof entry === "string" ? entry : stringifyStable(entry),
    })),
  };
};

/** An object to the JSON text n8n's HTTP node wants in `jsonBody`. */
export const object_to_json_string: TransformFn = (value) => {
  if (typeof value === "string") return value;
  return stringifyStable(value);
};

/**
 * Every transform a binding may name.
 *
 * A `Map` rather than an object literal because the name arrives from registry
 * data, and an object lookup for `"constructor"` returns a function instead of
 * `undefined`. The same reasoning as the expression grammar dispatch table.
 */
export const TRANSFORMS: ReadonlyMap<string, TransformFn> = new Map([
  ["enum_to_camel_case", enum_to_camel_case],
  ["array_to_comma_string", array_to_comma_string],
  ["assignments_to_set_fields", assignments_to_set_fields],
  ["object_to_name_value_pairs", object_to_name_value_pairs],
  ["object_to_json_string", object_to_json_string],
]);

export function isKnownTransform(name: string): boolean {
  return TRANSFORMS.has(name);
}

/**
 * Applies a named transform.
 *
 * Returns `undefined` for a name the table does not hold, which the caller
 * reports rather than silently passing the value through untouched. A binding
 * naming a transform that does not exist is a broken registry build, and a
 * value that quietly skipped its reshaping produces a workflow that imports
 * cleanly and behaves wrongly.
 */
export function applyTransform(
  name: string,
  value: ParameterValue,
  ctx: TransformContext,
): { ok: true; value: ParameterValue } | { ok: false } {
  const transform = TRANSFORMS.get(name);
  if (transform === undefined) return { ok: false };
  return { ok: true, value: transform(value, ctx) };
}

function setFieldType(value: ParameterValue): string {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return "array";
  if (value === null) return "string";
  return "object";
}

function isRecord(value: unknown): value is Record<string, ParameterValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `JSON.stringify` with no indentation, so the same value always serializes the same. */
function stringifyStable(value: ParameterValue): string {
  return JSON.stringify(value);
}
