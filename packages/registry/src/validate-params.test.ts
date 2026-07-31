import type { ParameterValue } from "@flowforge/ffir";
import { describe, expect, it } from "vitest";

import { loadFixtureRegistry } from "./__fixtures__/index.js";
import { resolve } from "./resolve.js";
import type { Capability, ConditionSpec, ParameterDefinition } from "./types.js";
import {
  PARAMETER_FAILURES,
  sameParameterValue,
  validateParameters,
  type ParameterCheck,
} from "./validate-params.js";

const registry = await loadFixtureRegistry();

/** A capability with exactly the parameters a test needs, and nothing else. */
function capability(
  parameters: Record<string, ParameterDefinition>,
  overrides: Partial<Capability> = {},
): Capability {
  return {
    id: "acme.thing.do",
    kind: "action",
    display_name: "Do a thing",
    description: "Does the thing.",
    aliases: ["do a thing"],
    parameters,
    ...overrides,
  };
}

function check(
  parameters: Record<string, ParameterDefinition>,
  supplied: Record<string, ParameterValue>,
): ParameterCheck {
  return validateParameters(capability(parameters), supplied);
}

function failures(
  parameters: Record<string, ParameterDefinition>,
  supplied: Record<string, ParameterValue>,
): string[] {
  return check(parameters, supplied).issues.map((issue) => issue.failure);
}

const text: ParameterDefinition = {
  type: "string",
  required: true,
  description: "Some text.",
};

const optionalText: ParameterDefinition = {
  type: "string",
  required: false,
  description: "Some optional text.",
};

function fixtureCapability(id: string): Capability {
  const resolved = resolve(registry, id);
  if (resolved === undefined) throw new Error(`no fixture capability ${id}`);
  return resolved.capability;
}

describe("presence", () => {
  it("reports a required parameter that was not supplied", () => {
    const result = check({ body: text }, {});
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      failure: "param_missing",
      parameter: "body",
      pointer: "/body",
    });
    expect(result.issues[0]?.message).toContain("Some text.");
  });

  it("does not report an empty string as missing", () => {
    // Pass B is instructed to emit an empty string when a required parameter
    // does not apply, so treating one as missing would reject exactly the
    // document the prompt asked for. A parameter that truly cannot be blank
    // says so with not_empty.
    expect(failures({ body: text }, { body: "" })).toEqual([]);
    expect(failures({ body: { ...text, validation: { not_empty: true } } }, { body: "" })).toEqual([
      "param_out_of_range",
    ]);
  });

  it("treats an explicit null as a wrong type rather than an absence", () => {
    expect(failures({ body: text }, { body: null })).toEqual(["param_type_mismatch"]);
  });

  it("accepts an absent optional parameter", () => {
    expect(failures({ body: optionalText }, {})).toEqual([]);
  });

  it("accepts an absent parameter that has a default", () => {
    expect(
      failures({ body: { ...optionalText, default: "hello" } }, {}),
    ).toEqual([]);
  });
});

describe("types", () => {
  it.each([
    ["string", "hello", 42],
    ["number", 42, "42"],
    ["boolean", true, "true"],
    ["array", [1, 2], { 0: 1 }],
    ["object", { a: 1 }, [1]],
    ["datetime", "2026-07-31T00:00:00Z", "31/07/2026"],
  ] as const)("checks %s", (type, good, bad) => {
    const definition: ParameterDefinition = {
      type,
      required: true,
      description: "A value.",
    };
    expect(failures({ value: definition }, { value: good as ParameterValue })).toEqual([]);
    expect(failures({ value: definition }, { value: bad as ParameterValue })).toEqual([
      "param_type_mismatch",
    ]);
  });

  it("rejects a non-finite number, which JSON cannot round-trip anyway", () => {
    const definition: ParameterDefinition = {
      type: "number",
      required: true,
      description: "A value.",
    };
    expect(failures({ value: definition }, { value: Number.NaN })).toEqual([
      "param_type_mismatch",
    ]);
  });

  it("does not treat an array as an object", () => {
    const definition: ParameterDefinition = {
      type: "object",
      required: true,
      description: "A value.",
    };
    expect(failures({ value: definition }, { value: [] })).toEqual([
      "param_type_mismatch",
    ]);
  });

  it.each(["2026-07-31", "2026-07-31T09:30:00Z", "2026-07-31T09:30:00.123+05:30"])(
    "accepts ISO 8601 form %s",
    (value) => {
      const definition: ParameterDefinition = {
        type: "datetime",
        required: true,
        description: "When.",
      };
      expect(failures({ when: definition }, { when: value })).toEqual([]);
    },
  );

  it("stops after a type mismatch rather than piling on rules that cannot apply", () => {
    const definition: ParameterDefinition = {
      type: "number",
      required: true,
      description: "A value.",
      validation: { min: 10, max: 20 },
    };
    expect(failures({ value: definition }, { value: "nope" })).toEqual([
      "param_type_mismatch",
    ]);
  });
});

describe("enums", () => {
  const mode: ParameterDefinition = {
    type: "enum",
    required: true,
    description: "How to combine.",
    values: ["append", "combine", "choose_branch"],
  };

  it("accepts a declared value", () => {
    expect(failures({ mode }, { mode: "append" })).toEqual([]);
  });

  it("rejects one outside the closed list", () => {
    const result = check({ mode }, { mode: "outer_join" });
    expect(result.issues[0]).toMatchObject({ failure: "param_not_in_enum" });
    expect(result.issues[0]?.message).toContain("append");
  });

  it("rejects a value of the wrong type as not in the enum", () => {
    expect(failures({ mode }, { mode: 3 })).toEqual(["param_not_in_enum"]);
  });
});

describe("validation rules", () => {
  it("checks a pattern and quotes the description back", () => {
    const channel: ParameterDefinition = {
      type: "string",
      required: true,
      description: "Channel name with #, user with @, or a channel ID.",
      validation: { pattern: "^([#@][a-z0-9._-]+|[CDG][A-Z0-9]{8,})$" },
    };
    expect(failures({ channel }, { channel: "#general" })).toEqual([]);
    expect(failures({ channel }, { channel: "C01234567AB" })).toEqual([]);

    const result = check({ channel }, { channel: "general" });
    expect(result.issues[0]).toMatchObject({ failure: "param_pattern_failed" });
    expect(result.issues[0]?.message).toContain("Channel name with #");
    expect(result.issues[0]?.details).toMatchObject({ value: "general" });
  });

  it("checks numeric bounds", () => {
    const count: ParameterDefinition = {
      type: "number",
      required: true,
      description: "How many.",
      validation: { min: 5, max: 10 },
    };
    expect(failures({ count }, { count: 5 })).toEqual([]);
    expect(failures({ count }, { count: 10 })).toEqual([]);
    expect(failures({ count }, { count: 4 })).toEqual(["param_out_of_range"]);
    expect(failures({ count }, { count: 11 })).toEqual(["param_out_of_range"]);
  });

  it("checks length on strings and on arrays", () => {
    const bounded: ParameterDefinition = {
      type: "string",
      required: true,
      description: "Bounded text.",
      validation: { min_length: 2, max_length: 4 },
    };
    expect(failures({ value: bounded }, { value: "abc" })).toEqual([]);
    expect(failures({ value: bounded }, { value: "a" })).toEqual(["param_out_of_range"]);
    expect(failures({ value: bounded }, { value: "abcde" })).toEqual(["param_out_of_range"]);

    const list: ParameterDefinition = {
      type: "array",
      required: true,
      description: "A short list.",
      validation: { max_length: 2 },
    };
    expect(failures({ value: list }, { value: [1, 2] })).toEqual([]);
    expect(failures({ value: list }, { value: [1, 2, 3] })).toEqual(["param_out_of_range"]);
  });

  it("checks one_of on any type", () => {
    const value: ParameterDefinition = {
      type: "number",
      required: true,
      description: "A supported version.",
      validation: { one_of: [1, 2, 3] },
    };
    expect(failures({ value }, { value: 2 })).toEqual([]);
    expect(failures({ value }, { value: 4 })).toEqual(["param_not_in_enum"]);
  });

  it("checks not_empty across the shapes that can be empty", () => {
    const definitions: [ParameterDefinition, ParameterValue][] = [
      [{ type: "string", required: true, description: "x", validation: { not_empty: true } }, ""],
      [{ type: "array", required: true, description: "x", validation: { not_empty: true } }, []],
      [{ type: "object", required: true, description: "x", validation: { not_empty: true } }, {}],
    ];
    for (const [definition, empty] of definitions) {
      expect(failures({ value: definition }, { value: empty })).toEqual([
        "param_out_of_range",
      ]);
    }
  });

  it("skips a pattern that will not compile rather than throwing", () => {
    // Registry load rejects a build carrying one, so this is only reachable
    // through a hand-built capability. A fault in our own data should not take
    // down a request that is otherwise fine.
    const value: ParameterDefinition = {
      type: "string",
      required: true,
      description: "Broken rule.",
      validation: { pattern: "^([#@", min_length: 4 },
    };
    expect(() => failures({ value }, { value: "ab" })).not.toThrow();
    expect(failures({ value }, { value: "ab" })).toEqual(["param_out_of_range"]);
  });

  it("reports every rule a single value breaks", () => {
    const value: ParameterDefinition = {
      type: "string",
      required: true,
      description: "Constrained.",
      validation: { pattern: "^[a-z]+$", min_length: 5 },
    };
    expect(failures({ value }, { value: "A1" })).toEqual([
      "param_pattern_failed",
      "param_out_of_range",
    ]);
  });

  it("produces every documented failure code across the suite", () => {
    // NODE_REGISTRY.md promises six codes the repair prompt can consume. A code
    // nothing can produce is a promise the repair prompt cannot rely on.
    const produced = new Set<string>([
      ...failures({ v: text }, {}),
      ...failures({ v: { type: "number", required: true, description: "x" } }, { v: "no" }),
      ...failures(
        { v: { ...text, validation: { pattern: "^a$" } } },
        { v: "b" },
      ),
      ...failures(
        { v: { type: "enum", required: true, description: "x", values: ["a"] } },
        { v: "b" },
      ),
      ...failures({ v: { ...text, validation: { min_length: 3 } } }, { v: "a" }),
      ...failures(
        {
          a: optionalText,
          v: { ...optionalText, conditional_required: { when: { a: { is_empty: true } } } },
        },
        {},
      ),
    ]);
    expect([...produced].sort()).toEqual([...PARAMETER_FAILURES].sort());
  });
});

describe("conditional requirements", () => {
  const blocks: ParameterDefinition = {
    type: "array",
    required: false,
    description: "Rich layout.",
    conditional_required: { when: { text: { is_empty: true } } },
  };

  it("fires when the sibling is in the named state", () => {
    const result = check({ text: optionalText, blocks }, {});
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ failure: "param_conditional_missing" });
    expect(result.issues[0]?.message).toContain("text is empty");
  });

  it("does not fire when the sibling is filled in", () => {
    expect(failures({ text: optionalText, blocks }, { text: "hello" })).toEqual([]);
  });

  it("does not fire when the parameter itself was supplied", () => {
    expect(failures({ text: optionalText, blocks }, { blocks: [] })).toEqual([]);
  });

  it("reads through a sibling's default", () => {
    // The sibling will have a value at run time even though the document does
    // not carry one, so the condition has to be judged on the effective value.
    const withDefault: ParameterDefinition = { ...optionalText, default: "hello" };
    expect(failures({ text: withDefault, blocks }, {})).toEqual([]);
  });

  it.each<[ConditionSpec, Record<string, ParameterValue>, boolean]>([
    [{ is_empty: true }, {}, true],
    [{ is_empty: true }, { a: "x" }, false],
    [{ is_empty: false }, { a: "x" }, true],
    [{ is_not_empty: true }, { a: "x" }, true],
    [{ is_not_empty: true }, {}, false],
    [{ equals: "combine" }, { a: "combine" }, true],
    [{ equals: "combine" }, { a: "append" }, false],
    [{ one_of: ["a", "b"] }, { a: "b" }, true],
    [{ one_of: ["a", "b"] }, { a: "c" }, false],
  ])("evaluates %j against %j as %s", (spec, supplied, expected) => {
    const result = failures(
      {
        a: optionalText,
        v: { ...optionalText, conditional_required: { when: { a: spec } } },
      },
      supplied as Record<string, ParameterValue>,
    );
    expect(result).toEqual(expected ? ["param_conditional_missing"] : []);
  });

  it("requires every entry in `when` to hold, so a second one narrows it", () => {
    const definition: ParameterDefinition = {
      ...optionalText,
      conditional_required: {
        when: { a: { is_empty: true }, b: { equals: "yes" } },
      },
    };
    const declared = { a: optionalText, b: optionalText, v: definition };
    expect(failures(declared, { b: "yes" })).toEqual(["param_conditional_missing"]);
    expect(failures(declared, { b: "no" })).toEqual([]);
    expect(failures(declared, { a: "x", b: "yes" })).toEqual([]);
  });
});

describe("unknown names, rule 13", () => {
  it("rejects a key the capability does not declare", () => {
    const result = check({ body: text }, { body: "hi", icon_emoji: ":tada:" });
    expect(result.issues).toEqual([]);
    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0]).toMatchObject({
      parameter: "icon_emoji",
      pointer: "/icon_emoji",
      declared: ["body"],
    });
  });

  it("lists the legal names, which is what a repair needs", () => {
    const result = check({ body: text, subject: optionalText }, { nope: 1 });
    expect(result.unknown[0]?.message).toContain("body, subject");
  });

  it("suggests a declared name one edit away", () => {
    const result = check({ channel: text }, { channe: "x" });
    expect(result.unknown[0]?.suggestion).toBe("channel");
    expect(result.unknown[0]?.message).toContain('Did you mean "channel"?');
  });

  it("suggests nothing when the guess would be ambiguous", () => {
    // "mix" is one substitution from both. A confident wrong suggestion sends
    // the repair prompt at the wrong parameter, which is worse than none.
    const number: ParameterDefinition = {
      type: "number",
      required: false,
      description: "A bound.",
    };
    const result = check({ min: number, max: number }, { mix: 1 });
    expect(result.unknown[0]?.suggestion).toBeUndefined();
    expect(result.unknown[0]?.message).not.toContain("Did you mean");
  });

  it("suggests nothing for a name that resembles none of them", () => {
    expect(check({ channel: text }, { completely_different: 1 }).unknown[0]?.suggestion)
      .toBeUndefined();
  });

  it("does not mistake an inherited property for a declared parameter", () => {
    // Parameter names arrive from an untrusted document, and `"constructor" in
    // declared` is true for every object in JavaScript.
    const result = check({ body: text }, { body: "hi", constructor: "x", toString: "y" });
    expect(result.unknown.map((issue) => issue.parameter).sort()).toEqual([
      "constructor",
      "toString",
    ]);
  });

  it("reports names and values independently of each other", () => {
    const result = check({ body: text }, { icon: "x" });
    expect(result.issues.map((issue) => issue.failure)).toEqual(["param_missing"]);
    expect(result.unknown.map((issue) => issue.parameter)).toEqual(["icon"]);
  });
});

describe("nested values", () => {
  const assignments: ParameterDefinition = {
    type: "array",
    required: true,
    description: "Field assignments.",
    validation: { not_empty: true },
    items: {
      type: "object",
      required: true,
      description: "One assignment.",
      fields: {
        field: { type: "string", required: true, description: "Field name." },
        value: { type: "string", required: true, description: "Field value." },
      },
    },
  };

  it("validates each element against the item schema", () => {
    const result = check(
      { assignments },
      { assignments: [{ field: "email", value: "x" }, { field: 7, value: "y" }] },
    );
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      failure: "param_type_mismatch",
      parameter: "assignments[1].field",
      pointer: "/assignments/1/field",
    });
  });

  it("reports a missing nested field", () => {
    const result = check({ assignments }, { assignments: [{ field: "email" }] });
    expect(result.issues[0]).toMatchObject({
      failure: "param_missing",
      parameter: "assignments[0].value",
    });
  });

  it("rejects an unknown key inside a declared object, at every level", () => {
    // The synthesized pass B schema is closed at every level, so the
    // independent check has to be too, or the two disagree about what a legal
    // document is.
    const result = check(
      { assignments },
      { assignments: [{ field: "a", value: "b", transform: "upper" }] },
    );
    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0]).toMatchObject({
      parameter: "assignments[0].transform",
      pointer: "/assignments/0/transform",
    });
  });

  it("leaves an object with no declared fields open", () => {
    // HTTP headers and a Block Kit payload have no fixed key set. Inventing one
    // would reject legitimate values.
    const headers: ParameterDefinition = {
      type: "object",
      required: false,
      description: "Request headers.",
    };
    const result = check({ headers }, { headers: { Authorization: "Bearer x", "X-Any": "y" } });
    expect(result.unknown).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it("reports the outermost unknown key before anything nested", () => {
    const result = check(
      { assignments },
      { assignments: [{ field: "a", value: "b", extra: 1 }], stray: true },
    );
    expect(result.unknown.map((issue) => issue.parameter)).toEqual([
      "stray",
      "assignments[0].extra",
    ]);
  });

  it("reports a nested failure at its full path, not at the bare field name", () => {
    const result = check({ assignments }, { assignments: [{ field: "a" }] });
    expect(result.issues[0]?.parameter).toBe("assignments[0].value");
    expect(result.issues[0]?.details).not.toHaveProperty("parameter");
  });

  it("escapes a parameter name that would otherwise break the pointer", () => {
    const odd: ParameterDefinition = {
      type: "object",
      required: false,
      description: "Odd.",
      fields: { "a/b": { type: "string", required: true, description: "Slashy." } },
    };
    const result = check({ odd }, { odd: {} });
    expect(result.issues[0]?.pointer).toBe("/odd/a~1b");
  });
});

describe("expressions", () => {
  const channel: ParameterDefinition = {
    type: "string",
    required: true,
    description: "Channel name.",
    validation: { pattern: "^#[a-z]+$", max_length: 8 },
  };

  it("exempts a value carrying an expression from its shape rules", () => {
    // What "{{ $vars.channel }}" resolves to is unknowable until the workflow
    // runs, so checking it against a pattern would reject most real workflows.
    expect(failures({ channel }, { channel: "{{ $vars.channel }}" })).toEqual([]);
    expect(failures({ channel }, { channel: "#{{ $vars.suffix }}" })).toEqual([]);
  });

  it("still checks a value with no expression in it", () => {
    expect(failures({ channel }, { channel: "general" })).toEqual([
      "param_pattern_failed",
    ]);
  });

  it("exempts an expression from the type check too", () => {
    const count: ParameterDefinition = {
      type: "number",
      required: true,
      description: "How many.",
      validation: { min: 1 },
    };
    expect(failures({ count }, { count: "{{ n_prev.total }}" })).toEqual([]);
    expect(failures({ count }, { count: "12" })).toEqual(["param_type_mismatch"]);
  });

  it("exempts an expression from an enum", () => {
    const mode: ParameterDefinition = {
      type: "enum",
      required: true,
      description: "Mode.",
      values: ["a", "b"],
    };
    expect(failures({ mode }, { mode: "{{ $vars.mode }}" })).toEqual([]);
  });

  it("exempts a nested expression", () => {
    const list: ParameterDefinition = {
      type: "array",
      required: true,
      description: "Values.",
      items: { type: "number", required: true, description: "One value." },
    };
    expect(failures({ list }, { list: ["{{ n_prev.n }}", 2] })).toEqual([]);
  });

  it("does not exempt a name check", () => {
    expect(check({ channel }, { nope: "{{ $vars.x }}" }).unknown).toHaveLength(1);
  });

  it("treats a broken expression as an expression, leaving stage 4 to report it", () => {
    // Grammar v1 has no escape for a literal "{{", so an unclosed pair is a
    // parse error rather than text. Reporting it here as a pattern failure
    // would send the repair prompt after the wrong problem.
    expect(failures({ channel }, { channel: "{{ oops" })).toEqual([]);
  });
});

describe("determinism", () => {
  const declared: Record<string, ParameterDefinition> = {
    alpha: text,
    beta: { type: "number", required: true, description: "A number." },
    gamma: { ...optionalText, validation: { pattern: "^z$" } },
  };

  it("orders value issues by the registry's declaration order", () => {
    const result = check(declared, { gamma: "q" });
    expect(result.issues.map((issue) => issue.parameter)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("returns the same lists on repeated calls", () => {
    const once = check(declared, { gamma: "q", stray: 1, other: 2 });
    const twice = check(declared, { gamma: "q", stray: 1, other: 2 });
    expect(twice).toEqual(once);
  });
});

describe("against the shipped registry", () => {
  it("accepts the parameters the worked example supplies to Slack", () => {
    const result = validateParameters(fixtureCapability("slack.message.send"), {
      channel: "#general",
      text: "Welcome {{ n_trigger.employee.first_name }} to the team.",
    });
    expect(result).toEqual({ unknown: [], issues: [] });
  });

  it("rejects a Slack channel that is missing its sigil", () => {
    const result = validateParameters(fixtureCapability("slack.message.send"), {
      channel: "general",
      text: "hi",
    });
    expect(result.issues.map((issue) => issue.failure)).toEqual(["param_pattern_failed"]);
  });

  it("rejects a poll interval below the registry's floor", () => {
    const result = validateParameters(fixtureCapability("bamboohr.employee.created"), {
      poll_interval_minutes: 1,
    });
    expect(result.issues[0]).toMatchObject({
      failure: "param_out_of_range",
      parameter: "poll_interval_minutes",
    });
  });

  it("accepts the worked example's transform node", () => {
    const result = validateParameters(fixtureCapability("core.transform.map"), {
      assignments: [{ field: "email", value: "{{ n_trigger.employee.first_name }}" }],
    });
    expect(result).toEqual({ unknown: [], issues: [] });
  });

  it("rejects a transform that assigns nothing", () => {
    const result = validateParameters(fixtureCapability("core.transform.map"), {
      assignments: [],
    });
    expect(result.issues.map((issue) => issue.failure)).toEqual(["param_out_of_range"]);
  });

  it("requires combine_by_fields only when the merge mode is combine", () => {
    const merge = fixtureCapability("core.merge.collect");
    expect(validateParameters(merge, { mode: "append" }).issues).toEqual([]);
    expect(validateParameters(merge, { mode: "combine" }).issues[0]).toMatchObject({
      failure: "param_conditional_missing",
      parameter: "combine_by_fields",
    });
    expect(
      validateParameters(merge, { mode: "combine", combine_by_fields: ["id"] }).issues,
    ).toEqual([]);
  });

  it("accepts a capability whose parameters are all optional and absent", () => {
    expect(validateParameters(fixtureCapability("core.branch.if"), {})).toEqual({
      unknown: [],
      issues: [],
    });
  });
});

describe("sameParameterValue", () => {
  it.each([
    [1, 1, true],
    ["a", "a", true],
    [null, null, true],
    [[1, 2], [1, 2], true],
    [[1, 2], [2, 1], false],
    [{ a: 1, b: 2 }, { b: 2, a: 1 }, true],
    [{ a: 1 }, { a: 1, b: 2 }, false],
    [{ a: 1 }, { a: 2 }, false],
    [1, "1", false],
    [null, undefined, false],
    [0, false, false],
  ])("compares %j and %j as %s", (a, b, expected) => {
    expect(sameParameterValue(a, b)).toBe(expected);
  });

  it("does not depend on key order, which JSON stringify comparison would", () => {
    expect(sameParameterValue({ x: [1, { y: 2 }], z: 3 }, { z: 3, x: [1, { y: 2 }] })).toBe(
      true,
    );
  });
});
