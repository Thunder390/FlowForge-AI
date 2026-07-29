import { describe, expect, it } from "vitest";

import type { Reference, Template } from "../ast.js";
import { parseTemplate } from "../parse.js";

const GRAMMAR = "1";

/** Parses, asserting success, so a test can read the template directly. */
function parse(source: string): Template {
  const result = parseTemplate(source, GRAMMAR);
  if (!result.ok) {
    throw new Error(
      `expected "${source}" to parse, got: ${result.errors.map((e) => e.message).join(" | ")}`,
    );
  }
  return result.template;
}

/** The references in a source string, in order. */
function refs(source: string): Reference[] {
  return parse(source).parts.flatMap((part) =>
    part.type === "expression" ? [part.reference] : [],
  );
}

/** The single reference in a source string that holds exactly one expression. */
function ref(source: string): Reference {
  const all = refs(source);
  expect(all).toHaveLength(1);
  return all[0]!;
}

/** Parses, asserting failure, so a test can read the errors directly. */
function errorsFor(source: string) {
  const result = parseTemplate(source, GRAMMAR);
  if (result.ok) {
    throw new Error(`expected "${source}" to fail, but it parsed`);
  }
  return result.errors;
}

describe("grammar 1: the examples in WORKFLOW_SCHEMA", () => {
  it("parses a node reference with a two-segment path", () => {
    expect(ref("{{ n_trigger.employee.email }}")).toEqual({
      type: "node_ref",
      node_id: "n_trigger",
      path: [
        { type: "field", name: "employee" },
        { type: "field", name: "email" },
      ],
    });
  });

  it("parses a node reference with an array index", () => {
    expect(ref("{{ n_http_1.body.items[0].id }}")).toEqual({
      type: "node_ref",
      node_id: "n_http_1",
      path: [
        { type: "field", name: "body" },
        { type: "field", name: "items" },
        { type: "index", index: 0 },
        { type: "field", name: "id" },
      ],
    });
  });

  it("parses a workflow variable reference", () => {
    expect(ref("{{ $vars.company_domain }}")).toEqual({
      type: "var_ref",
      variable_id: "company_domain",
    });
  });

  it("parses the $now builtin", () => {
    expect(ref("{{ $now }}")).toEqual({ type: "builtin", name: "now" });
  });

  it.each([
    ["$workflow_id", "workflow_id"],
    ["$execution_id", "execution_id"],
  ])("parses the %s builtin", (source, name) => {
    expect(ref(`{{ ${source} }}`)).toEqual({ type: "builtin", name });
  });

  it("parses a single-segment node reference", () => {
    expect(ref("{{ n_sheets_read.rows }}")).toEqual({
      type: "node_ref",
      node_id: "n_sheets_read",
      path: [{ type: "field", name: "rows" }],
    });
  });

  it("parses a loop item alias reference", () => {
    // Inside a loop body the current item is reached through the item_alias,
    // which is an ordinary path segment as far as the grammar is concerned.
    expect(ref("{{ n_loop_rows.row.column_name }}")).toEqual({
      type: "node_ref",
      node_id: "n_loop_rows",
      path: [
        { type: "field", name: "row" },
        { type: "field", name: "column_name" },
      ],
    });
  });

  it("parses a condition operand", () => {
    expect(ref("{{ n_trigger.employee.role }}")).toEqual({
      type: "node_ref",
      node_id: "n_trigger",
      path: [
        { type: "field", name: "employee" },
        { type: "field", name: "role" },
      ],
    });
  });
});

describe("grammar 1: templates", () => {
  it("treats a string with no braces as one literal part", () => {
    expect(parse("#general").parts).toEqual([{ type: "literal", value: "#general" }]);
  });

  it("produces no parts at all for an empty string", () => {
    expect(parse("").parts).toEqual([]);
  });

  it("keeps literal text around an expression", () => {
    // Text outside the braces is literal, which is what makes
    // "Welcome {{ ... }}!" both correct and useful.
    expect(parse("Welcome {{ n_trigger.name }}!").parts).toEqual([
      { type: "literal", value: "Welcome " },
      {
        type: "expression",
        offset: 8,
        raw: "{{ n_trigger.name }}",
        reference: {
          type: "node_ref",
          node_id: "n_trigger",
          path: [{ type: "field", name: "name" }],
        },
      },
      { type: "literal", value: "!" },
    ]);
  });

  it("parses the worked example's constructed email address", () => {
    const source =
      "{{ n_trigger.employee.first_name }}.{{ n_trigger.employee.last_name }}@{{ $vars.company_domain }}";
    const template = parse(source);

    expect(template.parts.map((p) => p.type)).toEqual([
      "expression",
      "literal",
      "expression",
      "literal",
      "expression",
    ]);
    expect(refs(source).map((r) => r.type)).toEqual([
      "node_ref",
      "node_ref",
      "var_ref",
    ]);
  });

  it("reproduces the source exactly from its parts", () => {
    const sources = [
      "",
      "plain text",
      "{{ $now }}",
      "Welcome {{ n_trigger.employee.first_name }} to the team.",
      "{{ a.b }}{{ c.d }}",
      "{{a.b}} tight braces, no padding",
      "trailing }} with no opener",
    ];

    for (const source of sources) {
      const rebuilt = parse(source)
        .parts.map((part) => (part.type === "literal" ? part.value : part.raw))
        .join("");
      expect(rebuilt).toBe(source);
    }
  });

  it("records the offset of every expression in a mixed template", () => {
    const template = parse("ab {{ x.y }} cd {{ z.w }}");
    const offsets = template.parts.flatMap((p) =>
      p.type === "expression" ? [p.offset] : [],
    );
    expect(offsets).toEqual([3, 16]);
  });

  it("allows whitespace only at the edges of the braces", () => {
    expect(ref("{{n_trigger.email}}")).toEqual(ref("{{   n_trigger.email   }}"));
    expect(errorsFor("{{ n_trigger . email }}")).toHaveLength(1);
  });

  it("accepts a newline inside the braces as edge whitespace", () => {
    expect(ref("{{\n  n_trigger.email\n}}")).toEqual({
      type: "node_ref",
      node_id: "n_trigger",
      path: [{ type: "field", name: "email" }],
    });
  });

  it("leaves a stray closing brace as literal text", () => {
    // Only "{{" opens an expression. A lone "}}" is ordinary text and must not
    // become an error, or every JSON-ish literal parameter fails to parse.
    expect(parse("value }} here").parts).toEqual([
      { type: "literal", value: "value }} here" },
    ]);
  });
});

describe("grammar 1: rejections", () => {
  it("rejects arithmetic, the excluded feature the spec calls out by name", () => {
    const errors = errorsFor("{{ $json.price * 1.08 }}");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("$json");
  });

  it("rejects arithmetic on an otherwise valid node reference", () => {
    const errors = errorsFor("{{ n_item.price * 1.08 }}");
    expect(errors[0]?.message).toContain("no arithmetic");
    expect(errors[0]?.details?.["found"]).toBe("* 1.08");
  });

  it("rejects a function call", () => {
    expect(errorsFor("{{ upper(n_trigger.name) }}")).toHaveLength(1);
  });

  it("rejects string concatenation inside the braces", () => {
    expect(errorsFor('{{ n_trigger.first + " " + n_trigger.last }}')).toHaveLength(1);
  });

  it("rejects a bare node id, which names no value", () => {
    const errors = errorsFor("{{ n_trigger }}");
    expect(errors[0]?.message).toContain("at least one field");
    expect(errors[0]?.details?.["expected"]).toBe("n_trigger.<field>");
  });

  it("rejects an empty expression", () => {
    expect(errorsFor("{{}}")).toHaveLength(1);
    expect(errorsFor("{{   }}")).toHaveLength(1);
  });

  it("rejects an unterminated expression rather than treating it as text", () => {
    // Grammar 1 has no escape for a literal "{{", so silently keeping it as
    // text would drop a reference the author meant to make.
    const errors = errorsFor("Hello {{ n_trigger.name");
    expect(errors[0]?.message).toContain("Unterminated");
    expect(errors[0]?.details?.["offset"]).toBe(6);
  });

  it("rejects an unknown builtin and names the ones that exist", () => {
    const errors = errorsFor("{{ $json }}");
    expect(errors[0]?.details?.["expected"]).toContain("$now");
    expect(errors[0]?.details?.["expected"]).toContain("$vars.<variable_id>");
  });

  it("rejects $vars with no variable id", () => {
    expect(errorsFor("{{ $vars. }}")).toHaveLength(1);
    expect(errorsFor("{{ $vars }}")).toHaveLength(1);
  });

  it("rejects a path hung off a workflow variable", () => {
    const errors = errorsFor("{{ $vars.config.domain }}");
    expect(errors[0]?.message).toContain("takes no further path");
  });

  it("rejects a path hung off a builtin", () => {
    const errors = errorsFor("{{ $now.iso }}");
    expect(errors[0]?.message).toContain("whole value");
  });

  it("rejects an index on the node id, which the grammar puts on segments only", () => {
    const errors = errorsFor("{{ n_items[0].id }}");
    expect(errors[0]?.message).toContain("must follow a field name");
  });

  it("rejects a second index on one segment", () => {
    const errors = errorsFor("{{ n_grid.cells[0][1] }}");
    expect(errors[0]?.message).toContain("at most one array index");
  });

  it("rejects a non-integer index", () => {
    expect(errorsFor("{{ n_http.items[first].id }}")).toHaveLength(1);
    expect(errorsFor("{{ n_http.items[-1].id }}")).toHaveLength(1);
    expect(errorsFor("{{ n_http.items[1.5].id }}")).toHaveLength(1);
  });

  it("rejects a leading zero, so one index has one source form", () => {
    expect(errorsFor("{{ n_http.items[01].id }}")).toHaveLength(1);
  });

  it("rejects an unclosed array index", () => {
    const errors = errorsFor("{{ n_http.items[0.id }}");
    expect(errors[0]?.message).toContain('Expected "]"');
  });

  it("rejects a trailing dot with nothing after it", () => {
    const errors = errorsFor("{{ n_trigger.employee. }}");
    expect(errors[0]?.message).toContain("field name");
  });

  it("rejects an identifier that starts with a digit", () => {
    expect(errorsFor("{{ 1node.field }}")).toHaveLength(1);
  });

  it("rejects a hyphenated identifier", () => {
    // The schema's identifier pattern and this grammar are the same rule, so a
    // node id that cannot be written cannot be referenced either.
    expect(errorsFor("{{ n-trigger.field }}")).toHaveLength(1);
  });

  it("collects every failure in a string rather than stopping at the first", () => {
    const errors = errorsFor("{{ bad1 }} and {{ bad2 }} and {{ $nope }}");
    expect(errors).toHaveLength(3);
  });

  it("blames only the invalid expression when a later one is fine", () => {
    const errors = errorsFor("{{ oops }} then {{ n_ok.field }}");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.details?.["expression"]).toBe("{{ oops }}");
  });
});

describe("grammar 1: positioned errors", () => {
  it("points at the offending token, not at the start of the string", () => {
    const errors = errorsFor("Hi {{ n_a.b }} and {{ $json }}");
    const detail = errors[0]?.details;
    expect(detail?.["offset"]).toBe(22);
    expect(detail?.["length"]).toBe(5);
    expect(detail?.["expression"]).toBe("{{ $json }}");
  });

  it("puts the offset and the offending expression in the message", () => {
    const errors = errorsFor("Hi {{ $json }}");
    expect(errors[0]?.message).toContain("offset 6");
    expect(errors[0]?.message).toContain('"{{ $json }}"');
  });

  it("gives a span the source can be sliced with", () => {
    const source = "{{ n_item.price * 1.08 }}";
    const detail = errorsFor(source)[0]?.details;
    const offset = detail?.["offset"] as number;
    const length = detail?.["length"] as number;
    expect(source.slice(offset, offset + length)).toBe("* 1.08");
  });

  it("always gives a span of at least one character", () => {
    for (const source of ["{{}}", "{{ n_a. }}", "{{ n_a.b[ }}", "{{ $vars. }}"]) {
      const length = errorsFor(source)[0]?.details?.["length"] as number;
      expect(length).toBeGreaterThanOrEqual(1);
    }
  });
});
