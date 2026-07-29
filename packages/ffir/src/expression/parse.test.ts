import { describe, expect, it } from "vitest";

import { cloneOnboarding, onboardingExample } from "../__fixtures__/index.js";
import type { FFIRDocument, ParameterValue } from "../types.js";
import { SUPPORTED_EXPRESSION_GRAMMARS } from "../types.js";
import { ErrorCode } from "../validate/codes.js";
import { scanExpressions } from "../validate/limits.js";
import { isTerminal } from "../validate/result.js";
import { referenceDepth } from "./ast.js";
import {
  checkTemplate,
  isSupportedGrammar,
  parseTemplate,
  supportedGrammars,
} from "./parse.js";

describe("version dispatch", () => {
  it("implements exactly the grammars types.ts advertises", () => {
    // A grammar advertised as supported but missing from the dispatch table
    // would be rejected at parse time with a message saying it is supported.
    expect(supportedGrammars().sort()).toEqual([...SUPPORTED_EXPRESSION_GRAMMARS].sort());
  });

  it("reports support per version", () => {
    expect(isSupportedGrammar("1")).toBe(true);
    expect(isSupportedGrammar("2")).toBe(false);
  });

  it("rejects an unknown grammar rather than parsing it optimistically", () => {
    // Parsing grammar 2 with the grammar 1 parser would mis-parse rather than
    // fail, and a mis-parsed expression compiles to a workflow that silently
    // reads the wrong field.
    const result = parseTemplate("{{ n_trigger.email }}", "2");
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe(ErrorCode.EXPRESSION_GRAMMAR_UNSUPPORTED);
    expect(result.errors[0]?.details).toEqual({
      declared: "2",
      supported: [...SUPPORTED_EXPRESSION_GRAMMARS],
    });
  });

  it("rejects an unknown grammar even when the string holds no expressions", () => {
    // The declared grammar is a property of the document, not of the string.
    // Passing plain text through under an unreadable grammar would let a
    // document be half-processed.
    expect(parseTemplate("plain text", "9").ok).toBe(false);
  });

  it("treats an unsupported grammar as terminal, because a retry cannot fix it", () => {
    expect(isTerminal(checkTemplate("{{ $now }}", "2"))).toBe(true);
  });

  it("treats a syntax failure as repairable, because a retry can fix it", () => {
    expect(isTerminal(checkTemplate("{{ n_trigger }}", "1"))).toBe(false);
  });

  it("does not resolve a grammar named after an Object prototype member", () => {
    expect(isSupportedGrammar("constructor")).toBe(false);
    expect(parseTemplate("{{ $now }}", "toString").ok).toBe(false);
  });
});

describe("error paths", () => {
  it("defaults to the document root", () => {
    const result = parseTemplate("{{ n_trigger }}", "1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.path).toBe("");
  });

  it("carries the caller's JSON pointer, so a failure names its parameter", () => {
    const result = parseTemplate("{{ n_trigger }}", "1", {
      path: "/nodes/3/parameters/text",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.path).toBe("/nodes/3/parameters/text");
  });

  it("carries the pointer on an unsupported grammar too", () => {
    const result = parseTemplate("{{ $now }}", "2", { path: "/expression_grammar" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.path).toBe("/expression_grammar");
  });
});

describe("checkTemplate", () => {
  it("returns a passing ValidationResult for a valid template", () => {
    expect(checkTemplate("Welcome {{ n_trigger.name }}", "1")).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("returns the same errors parseTemplate does", () => {
    const source = "{{ n_trigger }}";
    const parsed = parseTemplate(source, "1");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(checkTemplate(source, "1").errors).toEqual(parsed.errors);
  });
});

/** Every string in a document that may carry expressions, with its pointer. */
function templateStrings(doc: FFIRDocument): Array<{ path: string; source: string }> {
  const found: Array<{ path: string; source: string }> = [];

  const walk = (value: ParameterValue | undefined, path: string): void => {
    if (typeof value === "string") {
      found.push({ path, source: value });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}/${i}`));
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, child] of Object.entries(value)) walk(child, `${path}/${key}`);
    }
  };

  doc.nodes.forEach((node, i) => {
    for (const [key, value] of Object.entries(node.parameters)) {
      walk(value, `/nodes/${i}/parameters/${key}`);
    }
  });
  doc.edges.forEach((edge, i) => {
    if (edge.condition === undefined) return;
    walk(edge.condition.left, `/edges/${i}/condition/left`);
    walk(edge.condition.right, `/edges/${i}/condition/right`);
  });

  return found;
}

describe("the worked example", () => {
  it("has every string parse under the grammar it declares", () => {
    const strings = templateStrings(onboardingExample);
    expect(strings.length).toBeGreaterThan(0);

    for (const { path, source } of strings) {
      const result = parseTemplate(source, onboardingExample.expression_grammar, { path });
      if (!result.ok) {
        throw new Error(
          `${path}: ${source}\n  ${result.errors.map((e) => e.message).join("\n  ")}`,
        );
      }
    }
  });

  it("fails as a whole if one parameter is broken", () => {
    const doc = cloneOnboarding();
    doc.nodes[3]!.parameters["text"] = "Welcome {{ n_trigger.employee.first_name * 2 }}";

    const broken = templateStrings(doc).filter(
      ({ source, path }) => !parseTemplate(source, doc.expression_grammar, { path }).ok,
    );
    expect(broken).toHaveLength(1);
    expect(broken[0]?.path).toBe("/nodes/3/parameters/text");
  });
});

describe("agreement with the stage 0 limit scanner", () => {
  // Stage 0 cannot call the parser: limits are enforced before grammar
  // dispatch, because handing an unbounded document to a parser is the
  // denial-of-service the limits exist to stop. It therefore approximates
  // path depth with a regex, and the approximation has to match.
  const corpus = [
    "{{ $now }}",
    "{{ $workflow_id }}",
    "{{ $vars.company_domain }}",
    "{{ n_trigger.email }}",
    "{{ n_trigger.employee.first_name }}",
    "{{ n_http_1.body.items[0].id }}",
    "{{ n_loop_rows.row.column_name }}",
    "{{ n_a.b[12] }}",
  ];

  it.each(corpus)("agrees on the depth of %s", (source) => {
    const result = parseTemplate(source, "1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const part = result.template.parts[0];
    expect(part?.type).toBe("expression");
    if (part?.type !== "expression") return;

    expect(referenceDepth(part.reference)).toBe(scanExpressions(source)[0]?.depth);
  });

  it("agrees on every expression in the worked example", () => {
    for (const { source, path } of templateStrings(onboardingExample)) {
      const scanned = scanExpressions(source);
      const result = parseTemplate(source, "1", { path });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;

      const parsedDepths = result.template.parts.flatMap((p) =>
        p.type === "expression" ? [referenceDepth(p.reference)] : [],
      );
      expect(parsedDepths).toEqual(scanned.map((s) => s.depth));
    }
  });
});
