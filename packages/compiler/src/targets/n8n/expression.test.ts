import { parseTemplate, type Template } from "@flowforge/ffir";
import { describe, expect, it } from "vitest";

import { N8N_BUILTINS, compileTemplate, type ExpressionContext } from "./expression.js";

const displayNames = new Map([
  ["n_trigger", "New employee in BambooHR"],
  ["n_build_email", "Build the email address"],
  ["n_awkward", "Sam's inbox"],
]);

function parse(source: string): Template {
  const result = parseTemplate(source, "1");
  if (!result.ok) throw new Error(`fixture does not parse: ${source}`);
  return result.template;
}

function compile(source: string, immediatePredecessor?: string): string {
  const ctx: ExpressionContext = {
    displayNames,
    ...(immediatePredecessor === undefined ? {} : { immediatePredecessor }),
  };
  return compileTemplate(parse(source), ctx);
}

describe("the four reference forms", () => {
  it("compiles a node reference through its display name", () => {
    // n8n references nodes by name, not by id. Everything goes through the map
    // stage 3 built, so renaming a node cannot break its own references.
    expect(compile("{{ n_trigger.employee.email }}")).toBe(
      "{{ $('New employee in BambooHR').item.json.employee.email }}",
    );
  });

  it("compiles a reference to the immediate predecessor as $json", () => {
    expect(compile("{{ n_build_email.email }}", "n_build_email")).toBe("{{ $json.email }}");
  });

  it("compiles a variable reference", () => {
    expect(compile("{{ $vars.company_domain }}")).toBe("{{ $vars.company_domain }}");
  });

  it("compiles every builtin", () => {
    expect(compile("{{ $now }}")).toBe("{{ $now }}");
    expect(compile("{{ $workflow_id }}")).toBe("{{ $workflow.id }}");
    expect(compile("{{ $execution_id }}")).toBe("{{ $execution.id }}");
  });

  it("has a mapping for every builtin FFIR declares", () => {
    expect(Object.keys(N8N_BUILTINS).sort()).toEqual([
      "execution_id",
      "now",
      "workflow_id",
    ]);
  });
});

describe("paths", () => {
  it("keeps an array index bracketed", () => {
    // Collapsing items[0] into a field named 0 would emit ".0" and read the
    // wrong thing, which is why the AST keeps them as different segment types.
    expect(compile("{{ n_trigger.items[0].id }}")).toBe(
      "{{ $('New employee in BambooHR').item.json.items[0].id }}",
    );
  });

  it("handles a single segment", () => {
    expect(compile("{{ n_trigger.id }}")).toBe(
      "{{ $('New employee in BambooHR').item.json.id }}",
    );
  });

  it("handles a deep path", () => {
    expect(compile("{{ n_trigger.a.b.c.d }}")).toBe(
      "{{ $('New employee in BambooHR').item.json.a.b.c.d }}",
    );
  });
});

describe("templates", () => {
  it("emits literal text verbatim", () => {
    expect(compile("plain text")).toBe("plain text");
  });

  it("interleaves literals and references", () => {
    expect(compile("Hi {{ n_trigger.name }}, welcome!")).toBe(
      "Hi {{ $('New employee in BambooHR').item.json.name }}, welcome!",
    );
  });

  it("compiles several references in one string", () => {
    expect(
      compile("{{ n_trigger.first }}.{{ n_trigger.last }}@{{ $vars.company_domain }}"),
    ).toBe(
      "{{ $('New employee in BambooHR').item.json.first }}.{{ $('New employee in BambooHR').item.json.last }}@{{ $vars.company_domain }}",
    );
  });

  it("compiles an empty template to an empty string", () => {
    expect(compile("")).toBe("");
  });

  it("mixes $json and a named reference in one template", () => {
    expect(compile("{{ n_build_email.email }} for {{ n_trigger.name }}", "n_build_email")).toBe(
      "{{ $json.email }} for {{ $('New employee in BambooHR').item.json.name }}",
    );
  });
});

describe("node names as JavaScript literals", () => {
  it("escapes an apostrophe, because n8n evaluates $() as JavaScript", () => {
    // "Sam's inbox" is a name somebody would write without thinking, and an
    // unescaped apostrophe stops the whole expression parsing.
    expect(compile("{{ n_awkward.id }}")).toBe("{{ $('Sam\\'s inbox').item.json.id }}");
  });

  it("escapes a backslash before escaping quotes", () => {
    const ctx: ExpressionContext = { displayNames: new Map([["n_x", "back\\slash"]]) };
    expect(compileTemplate(parse("{{ n_x.id }}"), ctx)).toBe(
      "{{ $('back\\\\slash').item.json.id }}",
    );
  });
});

describe("edge cases", () => {
  it("falls back to the node id when there is no display name", () => {
    // Stage 3 names every node in the document, so this can only happen for an
    // id that is not in it, which validation rule 11 already rejected.
    expect(compile("{{ n_missing.field }}")).toBe("{{ $('n_missing').item.json.field }}");
  });

  it("does not treat a node as its own predecessor unless it is one", () => {
    expect(compile("{{ n_trigger.a }}", "n_build_email")).toBe(
      "{{ $('New employee in BambooHR').item.json.a }}",
    );
  });
});
