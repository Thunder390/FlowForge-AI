/**
 * FFIR conditions to n8n's condition model.
 *
 * | FFIR operator | n8n |
 * | --- | --- |
 * | `equals` | `string.equals` |
 * | `not_equals` | `string.notEquals` |
 * | `contains` | `string.contains` |
 * | `greater_than` | `number.gt` |
 * | `less_than` | `number.lt` |
 * | `not_contains` | `string.notContains` |
 * | `is_empty` | `string.isEmpty` |
 * | `is_not_empty` | `string.isNotEmpty` |
 * | `matches_regex` | `string.regex` |
 *
 * All nine map. `is_empty` and `is_not_empty` take no right operand and lower to
 * a single-operand condition; the other seven take both.
 *
 * ## Operand type
 *
 * Inferred from the registry's declared output type for the referenced field,
 * falling back to string. Getting this wrong means comparing `"10" > "9"`
 * lexically, which is false and surprising, so the table above gives the
 * *default* type and inference is allowed to change it only where n8n has the
 * operator on more than one type:
 *
 * - `gt` and `lt` are always numeric. That is the case the inference exists for,
 *   and letting a string field make them lexical would reintroduce exactly the
 *   bug being avoided.
 * - `contains`, `notContains`, `regex`, `isEmpty`, and `isNotEmpty` are string
 *   operations in n8n whatever the field is.
 * - `equals` and `notEquals` take the inferred type, so a boolean field compares
 *   as a boolean and a number as a number.
 */

import {
  expressionParts,
  type ConditionOperator,
  type NodeRef,
  type Template,
} from "@flowforge/ffir";
import type { OutputField, ParameterType, Registry } from "@flowforge/registry";

import type { NormalizedCondition, NormalizedGraph } from "../../normalize.js";
import { partUuid } from "../../uuid.js";
import { compileTemplate, type ExpressionContext } from "./expression.js";

/** n8n's condition value types. */
export type N8nOperandType =
  | "string"
  | "number"
  | "boolean"
  | "dateTime"
  | "array"
  | "object";

interface OperatorSpec {
  operation: string;
  /** The type used when inference is not consulted, or when it finds nothing. */
  fallback: N8nOperandType;
  /** False when n8n only has this operation on `fallback`. */
  infers: boolean;
  unary?: boolean;
}

export const CONDITION_OPERATORS: Record<ConditionOperator, OperatorSpec> = {
  equals: { operation: "equals", fallback: "string", infers: true },
  not_equals: { operation: "notEquals", fallback: "string", infers: true },
  contains: { operation: "contains", fallback: "string", infers: false },
  not_contains: { operation: "notContains", fallback: "string", infers: false },
  greater_than: { operation: "gt", fallback: "number", infers: false },
  less_than: { operation: "lt", fallback: "number", infers: false },
  is_empty: { operation: "isEmpty", fallback: "string", infers: false, unary: true },
  is_not_empty: {
    operation: "isNotEmpty",
    fallback: "string",
    infers: false,
    unary: true,
  },
  matches_regex: { operation: "regex", fallback: "string", infers: false },
};

/** Registry parameter types to n8n's condition types. */
const OPERAND_TYPES: Record<ParameterType, N8nOperandType> = {
  string: "string",
  number: "number",
  boolean: "boolean",
  array: "array",
  object: "object",
  enum: "string",
  datetime: "dateTime",
};

export interface N8nCondition {
  id: string;
  leftValue: string;
  rightValue?: string;
  operator: { type: N8nOperandType; operation: string; singleValue?: true };
}

export interface N8nConditionGroup {
  options: {
    caseSensitive: boolean;
    leftValue: "";
    typeValidation: "loose";
    version: 2;
  };
  conditions: N8nCondition[];
  combinator: "and";
}

export interface ConditionContext {
  graph: NormalizedGraph;
  registry: Registry;
  expressions: ExpressionContext;
  workflowId: string;
  nodeId: string;
  caseSensitive: boolean;
}

/**
 * One FFIR condition as an n8n condition group.
 *
 * A group rather than a bare condition because n8n nests conditions under a
 * combinator even when there is exactly one, and FFIR has no way to express
 * more than one condition per edge. `typeValidation` is loose because an
 * operand that resolves at run time cannot be type-checked at import time, and
 * strict validation would reject the workflow at the point n8n loads it.
 */
export function lowerCondition(
  condition: NormalizedCondition,
  seed: string,
  ctx: ConditionContext,
): N8nConditionGroup {
  const spec = CONDITION_OPERATORS[condition.operator];
  const type = spec.infers
    ? (inferOperandType(condition.left, ctx) ?? spec.fallback)
    : spec.fallback;

  const unary = spec.unary === true || condition.right === undefined;

  // Fields are built in one place rather than spread onto a base, so the key
  // order in the emitted file matches the order this interface declares.
  return group(ctx.caseSensitive, [
    {
      id: partUuid(ctx.workflowId, ctx.nodeId, `condition:${seed}`),
      leftValue: expressionValue(condition.left, ctx.expressions),
      ...(unary || condition.right === undefined
        ? {}
        : { rightValue: expressionValue(condition.right, ctx.expressions) }),
      operator: unary
        ? { type, operation: spec.operation, singleValue: true }
        : { type, operation: spec.operation },
    },
  ]);
}

function group(caseSensitive: boolean, conditions: N8nCondition[]): N8nConditionGroup {
  return {
    options: { caseSensitive, leftValue: "", typeValidation: "loose", version: 2 },
    conditions,
    combinator: "and",
  };
}

/**
 * A condition operand, compiled and prefixed.
 *
 * The `=` prefix applies here for the same reason it applies to a parameter:
 * without it n8n treats the braces as literal text. Conditions never pass
 * through a transform, so unlike a parameter the prefix can be settled at the
 * point the string is built.
 */
function expressionValue(template: Template, ctx: ExpressionContext): string {
  const compiled = compileTemplate(template, ctx);
  return compiled.includes("{{") ? `=${compiled}` : compiled;
}

/**
 * The declared type of the field a condition reads.
 *
 * Only a template that is exactly one node reference can be inferred: a
 * template that concatenates text around a reference is a string by
 * construction, and one referencing a variable has FFIR's variable type rather
 * than a registry output type, which is deliberately not consulted here because
 * a variable's declared type describes what the user types into a form.
 */
export function inferOperandType(
  template: Template,
  ctx: ConditionContext,
): N8nOperandType | undefined {
  if (template.parts.length !== 1) return undefined;

  const parts = expressionParts(template);
  const reference = parts[0]?.reference;
  if (reference === undefined || reference.type !== "node_ref") return undefined;

  return lookupOutputType(reference, ctx);
}

function lookupOutputType(
  reference: NodeRef,
  ctx: ConditionContext,
): N8nOperandType | undefined {
  const source = ctx.graph.byId.get(reference.node_id);
  if (source === undefined) return undefined;

  const capability = ctx.registry.capabilities.get(source.node.capability);
  let field: OutputField | undefined;
  let fields: Record<string, OutputField> | undefined = capability?.output;

  for (const segment of reference.path) {
    if (segment.type === "index") {
      // An index selects an element, so the type in play becomes the element's.
      const element: OutputField | undefined = field?.items;
      if (element === undefined) return undefined;
      field = element;
      fields = element.fields;
      continue;
    }

    const named: OutputField | undefined = fields?.[segment.name];
    if (named === undefined) return undefined;
    field = named;
    fields = named.fields;
  }

  return field === undefined ? undefined : OPERAND_TYPES[field.type];
}
