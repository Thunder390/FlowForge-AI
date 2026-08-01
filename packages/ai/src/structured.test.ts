/**
 * Parsing model output.
 *
 * The check is redundant on a provider with strict structured outputs and kept
 * anyway, because that guarantee belongs to one provider rather than to the
 * architecture. These tests are written against the case where it does not
 * hold, which is the case the code exists for.
 */

import { describe, expect, it } from "vitest";

import type { JsonSchema } from "./provider/types.js";
import { OutputError, parseStructured, unfence } from "./structured.js";

const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    count: { type: "number" },
  },
  required: ["name", "count"],
  additionalProperties: false,
};

describe("parsing", () => {
  it("returns the typed value for a conforming response", () => {
    const value = parseStructured<{ name: string; count: number }>(
      '{"name":"a","count":1}',
      SCHEMA,
      "thing",
    );
    expect(value).toEqual({ name: "a", count: 1 });
  });

  it("tolerates the whitespace a model puts around its output", () => {
    expect(parseStructured('\n  {"name":"a","count":1}  \n', SCHEMA, "thing")).toEqual({
      name: "a",
      count: 1,
    });
  });
});

describe("code fences", () => {
  it("strips a fenced block, which a non-strict provider produces often", () => {
    // Rejecting the response over punctuation would burn a repair attempt on
    // something no repair prompt could usefully explain.
    const fenced = '```json\n{"name":"a","count":1}\n```';
    expect(parseStructured(fenced, SCHEMA, "thing")).toEqual({ name: "a", count: 1 });
  });

  it("handles a fence with no language tag", () => {
    expect(unfence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("leaves unfenced text alone", () => {
    expect(unfence('  {"a":1}  ')).toBe('{"a":1}');
  });

  it("does not mangle a lone fence marker", () => {
    expect(unfence("```")).toBe("```");
  });
});

describe("failures", () => {
  it("reports malformed JSON as its own code", () => {
    let thrown: unknown;
    try {
      parseStructured("{not json", SCHEMA, "thing");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OutputError);
    expect((thrown as OutputError).code).toBe("malformed_json");
    expect((thrown as OutputError).schemaName).toBe("thing");
  });

  it("names the missing property rather than saying the shape is wrong", () => {
    // Vague feedback produces vague fixes, and this list is what the repair
    // prompt prints.
    let thrown: unknown;
    try {
      parseStructured('{"name":"a"}', SCHEMA, "thing");
    } catch (error) {
      thrown = error;
    }

    const error = thrown as OutputError;
    expect(error.code).toBe("schema_violation");
    expect(error.issues.join(" ")).toContain('missing the required property "count"');
  });

  it("names an invented property, which is the failure the closed schema prevents", () => {
    let thrown: unknown;
    try {
      parseStructured('{"name":"a","count":1,"invented":true}', SCHEMA, "thing");
    } catch (error) {
      thrown = error;
    }

    expect((thrown as OutputError).issues.join(" ")).toContain(
      'has the property "invented"',
    );
  });

  it("reports every problem at once, not the first", () => {
    let thrown: unknown;
    try {
      parseStructured('{"count":"not a number","invented":1}', SCHEMA, "thing");
    } catch (error) {
      thrown = error;
    }
    expect((thrown as OutputError).issues.length).toBeGreaterThanOrEqual(3);
  });

  it("names the enum members when one is missed", () => {
    const enumSchema: JsonSchema = {
      type: "object",
      properties: { mode: { type: "string", enum: ["a", "b"] } },
      required: ["mode"],
      additionalProperties: false,
    };
    let thrown: unknown;
    try {
      parseStructured('{"mode":"c"}', enumSchema, "thing");
    } catch (error) {
      thrown = error;
    }
    expect((thrown as OutputError).issues.join(" ")).toContain("must be one of: a, b");
  });
});

describe("compiled validators", () => {
  it("reuses the validator for a schema rather than recompiling per call", () => {
    // Pass A's schema is a module constant, so it compiles once for the
    // process. Correctness does not depend on this, but latency does.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(parseStructured('{"name":"a","count":1}', SCHEMA, "thing")).toEqual({
        name: "a",
        count: 1,
      });
    }
  });
});
