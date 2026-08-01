import { describe, expect, it } from "vitest";

import {
  TRANSFORMS,
  applyTransform,
  array_to_comma_string,
  assignments_to_set_fields,
  enum_to_camel_case,
  isKnownTransform,
  object_to_json_string,
  object_to_name_value_pairs,
  type TransformContext,
} from "./transforms.js";

const ctx: TransformContext = {
  workflowId: "wf_test",
  nodeId: "n_test",
  parameter: "assignments",
};

describe("the table", () => {
  it("holds exactly the transforms the fixture bindings name", () => {
    // A binding naming a transform that is not here is a broken registry build,
    // and this list is what makes that a failing test rather than a surprise at
    // compile time.
    expect([...TRANSFORMS.keys()].sort()).toEqual([
      "array_to_comma_string",
      "assignments_to_set_fields",
      "enum_to_camel_case",
      "object_to_json_string",
      "object_to_name_value_pairs",
    ]);
  });

  it("does not resolve inherited property names", () => {
    // The name arrives from registry data. An object lookup for "constructor"
    // returns a function rather than undefined, which is why this is a Map.
    expect(isKnownTransform("constructor")).toBe(false);
    expect(isKnownTransform("toString")).toBe(false);
  });

  it("reports an unknown name rather than passing the value through", () => {
    // Silently skipping the reshaping produces a workflow that imports cleanly
    // and behaves wrongly, which is worse than failing.
    expect(applyTransform("no_such_transform", "x", ctx)).toEqual({ ok: false });
  });

  it("applies a known name", () => {
    expect(applyTransform("enum_to_camel_case", "choose_branch", ctx)).toEqual({
      ok: true,
      value: "chooseBranch",
    });
  });
});

describe("enum_to_camel_case", () => {
  it("converts snake case", () => {
    expect(enum_to_camel_case("choose_branch", ctx)).toBe("chooseBranch");
  });

  it("handles several underscores", () => {
    expect(enum_to_camel_case("a_b_c", ctx)).toBe("aBC");
  });

  it("leaves a value with no underscore alone", () => {
    expect(enum_to_camel_case("append", ctx)).toBe("append");
  });

  it("handles a digit after the underscore", () => {
    expect(enum_to_camel_case("mode_2", ctx)).toBe("mode2");
  });

  it("passes a non-string through", () => {
    expect(enum_to_camel_case(7, ctx)).toBe(7);
  });
});

describe("array_to_comma_string", () => {
  it("joins strings", () => {
    expect(array_to_comma_string(["id", "email"], ctx)).toBe("id,email");
  });

  it("joins an empty array to an empty string", () => {
    expect(array_to_comma_string([], ctx)).toBe("");
  });

  it("stringifies non-string members rather than dropping them", () => {
    expect(array_to_comma_string([1, true], ctx)).toBe("1,true");
  });

  it("passes a non-array through", () => {
    expect(array_to_comma_string("already", ctx)).toBe("already");
  });
});

describe("assignments_to_set_fields", () => {
  it("renames the FFIR fields to n8n's and adds an id and a type", () => {
    const result = assignments_to_set_fields(
      [{ field: "email", value: "a@b.c" }],
      ctx,
    ) as Record<string, unknown>[];

    expect(result[0]).toMatchObject({ name: "email", value: "a@b.c", type: "string" });
    expect(result[0]?.["id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("mints the same id for the same assignment every time", () => {
    // Without this every re-export of an unchanged workflow is a diff.
    const once = assignments_to_set_fields([{ field: "email", value: "x" }], ctx);
    expect(assignments_to_set_fields([{ field: "email", value: "x" }], ctx)).toEqual(once);
  });

  it("gives two assignments different ids", () => {
    const result = assignments_to_set_fields(
      [
        { field: "a", value: "1" },
        { field: "b", value: "2" },
      ],
      ctx,
    ) as Record<string, unknown>[];

    expect(result[0]?.["id"]).not.toBe(result[1]?.["id"]);
  });

  it("declares the type from the value", () => {
    const types = (
      assignments_to_set_fields(
        [
          { field: "s", value: "text" },
          { field: "n", value: 1 },
          { field: "b", value: true },
          { field: "a", value: [1] },
          { field: "o", value: { k: 1 } },
        ],
        ctx,
      ) as Record<string, unknown>[]
    ).map((entry) => entry["type"]);

    expect(types).toEqual(["string", "number", "boolean", "array", "object"]);
  });

  it("calls an expression-bearing value a string", () => {
    // What it resolves to is unknowable until the workflow runs, and claiming a
    // narrower type would make n8n coerce it.
    const result = assignments_to_set_fields(
      [{ field: "x", value: "{{ $json.count }}" }],
      ctx,
    ) as Record<string, unknown>[];
    expect(result[0]?.["type"]).toBe("string");
  });

  it("survives a malformed entry rather than throwing", () => {
    const result = assignments_to_set_fields(["nonsense"], ctx) as Record<
      string,
      unknown
    >[];
    expect(result[0]).toMatchObject({ name: "", value: "" });
  });
});

describe("object_to_name_value_pairs", () => {
  it("builds n8n's fixed-collection shape", () => {
    expect(object_to_name_value_pairs({ "X-Key": "v" }, ctx)).toEqual({
      parameters: [{ name: "X-Key", value: "v" }],
    });
  });

  it("keeps key order, which stage 3 already pinned", () => {
    const result = object_to_name_value_pairs({ b: "2", a: "1" }, ctx) as {
      parameters: { name: string }[];
    };
    expect(result.parameters.map((entry) => entry.name)).toEqual(["b", "a"]);
  });

  it("serializes a non-string value", () => {
    expect(object_to_name_value_pairs({ n: 5 }, ctx)).toEqual({
      parameters: [{ name: "n", value: "5" }],
    });
  });

  it("handles an empty object", () => {
    expect(object_to_name_value_pairs({}, ctx)).toEqual({ parameters: [] });
  });
});

describe("object_to_json_string", () => {
  it("serializes an object", () => {
    expect(object_to_json_string({ a: 1 }, ctx)).toBe('{"a":1}');
  });

  it("leaves a string alone, so a body already written as JSON is not double-encoded", () => {
    expect(object_to_json_string('{"a":1}', ctx)).toBe('{"a":1}');
  });

  it("keeps expressions intact for the = prefix to find later", () => {
    expect(object_to_json_string({ name: "{{ $json.x }}" }, ctx)).toBe(
      '{"name":"{{ $json.x }}"}',
    );
  });
});
