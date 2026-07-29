import { describe, expect, it } from "vitest";

import {
  BUILTIN_NAMES,
  expressionParts,
  formatExpression,
  formatReference,
  isLiteralTemplate,
  referenceDepth,
  referencedNodeIds,
  referencedVariableIds,
  type Reference,
  type Template,
} from "./ast.js";
import { parseTemplate } from "./parse.js";

function parse(source: string): Template {
  const result = parseTemplate(source, "1");
  if (!result.ok) throw new Error(`expected "${source}" to parse`);
  return result.template;
}

describe("template helpers", () => {
  it("treats a string with no expressions as literal", () => {
    // The n8n target keys its "=" prefix off this: adding the prefix to a plain
    // literal makes n8n evaluate it, which breaks any string with braces in it.
    expect(isLiteralTemplate(parse("#general"))).toBe(true);
    expect(isLiteralTemplate(parse(""))).toBe(true);
    expect(isLiteralTemplate(parse("Hi {{ n_a.b }}"))).toBe(false);
  });

  it("returns expressions in source order and skips literals", () => {
    const parts = expressionParts(parse("a {{ n_x.f }} b {{ $now }} c"));
    expect(parts.map((p) => p.raw)).toEqual(["{{ n_x.f }}", "{{ $now }}"]);
  });

  it("collects distinct node ids in first-appearance order", () => {
    const template = parse("{{ n_b.x }} {{ n_a.y }} {{ n_b.z }} {{ $vars.v }}");
    expect(referencedNodeIds(template)).toEqual(["n_b", "n_a"]);
  });

  it("collects distinct variable ids in first-appearance order", () => {
    const template = parse("{{ $vars.b }}{{ $vars.a }}{{ $vars.b }}{{ n_x.y }}");
    expect(referencedVariableIds(template)).toEqual(["b", "a"]);
  });

  it("returns nothing for a template with no references of that kind", () => {
    expect(referencedNodeIds(parse("plain"))).toEqual([]);
    expect(referencedVariableIds(parse("{{ $now }}"))).toEqual([]);
  });
});

describe("referenceDepth", () => {
  it.each([
    ["{{ $now }}", 0],
    ["{{ $vars.domain }}", 1],
    ["{{ n_a.b }}", 1],
    ["{{ n_a.b.c }}", 2],
    ["{{ n_a.b.items[0].id }}", 4],
  ])("%s has depth %i", (source, depth) => {
    const part = expressionParts(parse(source))[0]!;
    expect(referenceDepth(part.reference)).toBe(depth);
  });
});

describe("formatReference", () => {
  const cases: string[] = [
    "n_trigger.employee.email",
    "n_http_1.body.items[0].id",
    "n_a.b[12]",
    "$vars.company_domain",
    "$now",
    "$workflow_id",
    "$execution_id",
  ];

  it.each(cases)("round-trips %s through the parser unchanged", (canonical) => {
    const part = expressionParts(parse(`{{ ${canonical} }}`))[0]!;
    expect(formatReference(part.reference)).toBe(canonical);
  });

  it("normalizes brace padding when rendering an expression", () => {
    const part = expressionParts(parse("{{n_a.b}}"))[0]!;
    expect(formatExpression(part.reference)).toBe("{{ n_a.b }}");
  });

  it("renders every builtin in source form", () => {
    for (const name of BUILTIN_NAMES) {
      const reference: Reference = { type: "builtin", name };
      expect(formatReference(reference)).toBe(`$${name}`);
    }
  });
});
