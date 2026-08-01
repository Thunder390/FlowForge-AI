/**
 * The expression AST, compiled to n8n syntax.
 *
 * | FFIR AST | n8n output |
 * | --- | --- |
 * | `NodeRef("n_trigger", ["employee","email"])` | `{{ $('New employee in BambooHR').item.json.employee.email }}` |
 * | `NodeRef` on the immediate predecessor | `{{ $json.email }}` |
 * | `VarRef("company_domain")` | `{{ $vars.company_domain }}` |
 * | `Builtin("now")` | `{{ $now }}` |
 *
 * Two details that are easy to get wrong, both specified rather than inferred:
 *
 * 1. **n8n references nodes by display name, not by id.** Every reference goes
 *    through the id-to-name map built during normalization, so renaming a node
 *    cannot break its own references.
 * 2. **The `=` prefix is applied to a whole parameter, not here.** A parameter
 *    containing at least one expression is prefixed; one containing none stays a
 *    plain literal. Adding `=` unnecessarily makes n8n evaluate a literal as an
 *    expression, which breaks any string containing braces. This module emits
 *    the braces and `prefixExpressions` in `parameters.ts` decides the prefix,
 *    because by then transforms have run and the finished string is the thing
 *    the prefix belongs to.
 *
 * There is no regex rewriting here. The parse happened once, in `ffir`, and this
 * walks the resulting AST. That is the whole reason expressions are parsed in
 * stage 3: per-target regex rewriting is how escaping bugs get shipped.
 */

import {
  type Builtin,
  type BuiltinName,
  type NodeRef,
  type PathSegment,
  type Reference,
  type Template,
  type VarRef,
} from "@flowforge/ffir";

/**
 * FFIR builtins to n8n's globals.
 *
 * A closed record rather than a lookup with a fallback: FFIR's builtin list is a
 * frozen union, so a name absent here is a compile error in this file rather
 * than a wrong expression in someone's workflow.
 */
export const N8N_BUILTINS: Record<BuiltinName, string> = {
  now: "$now",
  workflow_id: "$workflow.id",
  execution_id: "$execution.id",
};

export interface ExpressionContext {
  /** FFIR node id to n8n display name. Built in stage 3. */
  displayNames: ReadonlyMap<string, string>;
  /**
   * The node whose output arrives on this node's input, when there is exactly
   * one. A reference to it compiles to `$json`, which is both shorter and what
   * an n8n user would have written by hand.
   */
  immediatePredecessor?: string;
}

/**
 * Compiles one template to n8n text.
 *
 * Literal parts are emitted verbatim and expression parts become n8n
 * references, so concatenation reproduces the author's string with only the
 * references rewritten.
 */
export function compileTemplate(template: Template, ctx: ExpressionContext): string {
  return template.parts
    .map((part) =>
      part.type === "literal" ? part.value : `{{ ${compileReference(part.reference, ctx)} }}`,
    )
    .join("");
}

export function compileReference(reference: Reference, ctx: ExpressionContext): string {
  switch (reference.type) {
    case "node_ref":
      return compileNodeRef(reference, ctx);
    case "var_ref":
      return compileVarRef(reference);
    case "builtin":
      return compileBuiltin(reference);
  }
}

/**
 * A node reference.
 *
 * The immediate predecessor becomes `$json`, everything else becomes
 * `$('Display Name').item.json`. A reference to a node that has no display name
 * falls back to the raw id rather than emitting `$('undefined')`: stage 3 builds
 * a name for every node in the document, so this can only happen for an id that
 * is not in the document, which validation rule 11 already rejected.
 */
function compileNodeRef(reference: NodeRef, ctx: ExpressionContext): string {
  const path = reference.path.map(formatSegment).join("");

  if (reference.node_id === ctx.immediatePredecessor) {
    return `$json${path}`;
  }

  const name = ctx.displayNames.get(reference.node_id) ?? reference.node_id;
  return `$(${quote(name)}).item.json${path}`;
}

function compileVarRef(reference: VarRef): string {
  return `$vars.${reference.variable_id}`;
}

function compileBuiltin(reference: Builtin): string {
  return N8N_BUILTINS[reference.name];
}

/**
 * A path segment.
 *
 * An index stays bracketed and a field gets a dot, which is why the AST keeps
 * them as different segment types: collapsing `items[0]` into a field named `0`
 * would emit `.0` and read the wrong thing.
 */
function formatSegment(segment: PathSegment): string {
  return segment.type === "field" ? `.${segment.name}` : `[${segment.index}]`;
}

/**
 * A node name as a single-quoted JavaScript string literal.
 *
 * n8n evaluates `$('...')` as JavaScript, so a name containing an apostrophe or
 * a backslash has to be escaped or the expression stops parsing. "Alert IT on
 * failure" is fine and "Sam's inbox" is not, and only one of those is a name
 * somebody would think twice about.
 */
function quote(name: string): string {
  return `'${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
