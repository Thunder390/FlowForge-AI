/**
 * The expression AST.
 *
 * Targets receive a parsed AST, never the raw string. Regex-rewriting
 * expressions per target is how escaping bugs get shipped, so the parse happens
 * once, in this package, and every consumer shares the result.
 *
 * A parameter value is a *template*: literal text with expressions embedded in
 * it. `"Welcome {{ n_trigger.name }}!"` is three parts, two of them literal.
 * That distinction is load-bearing downstream: a target that prefixes
 * expression-bearing parameters (n8n uses `=`) must be able to tell a template
 * carrying a reference from one that is only text.
 *
 * Grammar shapes live in `grammar/`. This file is the vocabulary they produce
 * and every consumer reads, which is why it is deliberately free of parsing.
 */

/**
 * Builtin names, stored without the leading `$` that the source syntax carries.
 * Use `formatReference` to get back to source form.
 */
export const BUILTIN_NAMES = ["now", "workflow_id", "execution_id"] as const;
export type BuiltinName = (typeof BUILTIN_NAMES)[number];

/** The `$vars.` prefix that introduces a workflow-variable reference. */
export const VARS_PREFIX = "$vars.";

/** A named field access: the `.email` in `n_trigger.employee.email`. */
export interface FieldSegment {
  type: "field";
  name: string;
}

/**
 * An array index: the `[0]` in `n_http_1.body.items[0].id`.
 *
 * Indices are a separate segment type rather than a numeric field name because
 * a target lowering `items[0]` emits different syntax from one lowering a field
 * that happens to be named `0`, and collapsing the two loses that.
 */
export interface IndexSegment {
  type: "index";
  index: number;
}

export type PathSegment = FieldSegment | IndexSegment;

/**
 * A reference to data produced by an earlier node. The node id must name a
 * transitive predecessor, which is validation rule 11 and is checked by the
 * graph validator, not here: a parser's job is shape, not graph semantics.
 */
export interface NodeRef {
  type: "node_ref";
  node_id: string;
  /** Never empty. The grammar requires at least one segment after the node id. */
  path: PathSegment[];
}

/** A reference to a workflow variable: `{{ $vars.company_domain }}`. */
export interface VarRef {
  type: "var_ref";
  variable_id: string;
}

/** A runtime value the platform supplies: `{{ $now }}`. */
export interface Builtin {
  type: "builtin";
  name: BuiltinName;
}

export type Reference = NodeRef | VarRef | Builtin;

/** Text outside any braces. Emitted verbatim by every target. */
export interface LiteralPart {
  type: "literal";
  value: string;
}

export interface ExpressionPart {
  type: "expression";
  reference: Reference;
  /** Source text including the braces, so a renderer can echo the original. */
  raw: string;
  /** Character offset of the opening `{{` within the template source. */
  offset: number;
}

export type TemplatePart = LiteralPart | ExpressionPart;

export interface Template {
  /** The string this template was parsed from, unmodified. */
  source: string;
  /**
   * Parts in source order. Concatenating the literal values and the raw
   * expression text reproduces `source` exactly. An empty source produces no
   * parts: there are no empty literal parts.
   */
  parts: TemplatePart[];
}

export function isExpressionPart(part: TemplatePart): part is ExpressionPart {
  return part.type === "expression";
}

/** Every expression in the template, in source order. */
export function expressionParts(template: Template): ExpressionPart[] {
  return template.parts.filter(isExpressionPart);
}

/**
 * True when the template carries no expressions at all.
 *
 * The n8n target keys the `=` prefix off this: adding the prefix to a plain
 * literal makes n8n evaluate it as an expression, which breaks any string
 * containing braces.
 */
export function isLiteralTemplate(template: Template): boolean {
  return !template.parts.some(isExpressionPart);
}

/** Distinct node ids referenced, in first-appearance order. */
export function referencedNodeIds(template: Template): string[] {
  return distinct(
    expressionParts(template)
      .map((part) => part.reference)
      .filter((reference): reference is NodeRef => reference.type === "node_ref")
      .map((reference) => reference.node_id),
  );
}

/** Distinct variable ids referenced, in first-appearance order. */
export function referencedVariableIds(template: Template): string[] {
  return distinct(
    expressionParts(template)
      .map((part) => part.reference)
      .filter((reference): reference is VarRef => reference.type === "var_ref")
      .map((reference) => reference.variable_id),
  );
}

/**
 * How many levels of traversal a reference walks.
 *
 * This is the same quantity the stage 0 limit scanner approximates without
 * parsing, and the two must agree for every expression the grammar accepts.
 * Stage 0 cannot call the parser: limits are enforced before grammar dispatch,
 * because handing an unbounded document to a parser is the denial-of-service
 * the limits exist to stop. A test pins the agreement instead.
 */
export function referenceDepth(reference: Reference): number {
  switch (reference.type) {
    case "node_ref":
      return reference.path.length;
    case "var_ref":
      return 1;
    case "builtin":
      return 0;
  }
}

/** Renders a reference back to canonical source form, without the braces. */
export function formatReference(reference: Reference): string {
  switch (reference.type) {
    case "node_ref":
      return reference.node_id + reference.path.map(formatSegment).join("");
    case "var_ref":
      return `${VARS_PREFIX}${reference.variable_id}`;
    case "builtin":
      return `$${reference.name}`;
  }
}

/** Renders a reference back to canonical source form, braces included. */
export function formatExpression(reference: Reference): string {
  return `{{ ${formatReference(reference)} }}`;
}

function formatSegment(segment: PathSegment): string {
  return segment.type === "field" ? `.${segment.name}` : `[${segment.index}]`;
}

function distinct(values: string[]): string[] {
  return [...new Set(values)];
}
