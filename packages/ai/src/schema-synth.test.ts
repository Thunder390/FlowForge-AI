/**
 * The closed schema is the single largest reduction in hallucination surface in
 * the product, and every property that makes it work is easy to lose by
 * accident. An `additionalProperties` dropped from one nested level, a
 * `required` entry the registry never asked for, or a parameter type mapped to
 * something structured outputs rejects would each keep the tests green if the
 * tests only checked the top level.
 */

import { loadFixtureRegistry } from "@flowforge/registry/fixtures";
import type { ParameterDefinition, Registry } from "@flowforge/registry";
import { beforeAll, describe, expect, it } from "vitest";

import type { JsonSchema } from "./provider/types.js";
import {
  emptyStringIsLegal,
  isRequiredInSchema,
  synthesizeParameterSchema,
} from "./schema-synth.js";

let registry: Registry;
beforeAll(async () => {
  registry = await loadFixtureRegistry();
});

function nodeSchema(schema: JsonSchema, id: string): JsonSchema {
  const found = schema.properties?.[id];
  if (found === undefined) throw new Error(`no property for ${id}`);
  return found;
}

/** Every object anywhere in the schema, so a nested level cannot be forgotten. */
function everyObject(schema: JsonSchema, found: JsonSchema[] = []): JsonSchema[] {
  if (schema.type === "object") found.push(schema);
  for (const property of Object.values(schema.properties ?? {})) everyObject(property, found);
  if (schema.items !== undefined) everyObject(schema.items, found);
  return found;
}

describe("the shape of the synthesized schema", () => {
  it("has one property per node id and requires every one of them", () => {
    const result = synthesizeParameterSchema(
      [
        { id: "n_trigger", capability: "bamboohr.employee.created" },
        { id: "n_slack", capability: "slack.message.send" },
      ],
      registry,
    );

    expect(result.ok).toBe(true);
    expect(Object.keys(result.schema.properties ?? {})).toEqual(["n_trigger", "n_slack"]);
    expect(result.schema.required).toEqual(["n_trigger", "n_slack"]);
  });

  it("closes every object at every level, which is the whole guarantee", () => {
    // `core.transform.map` nests: an array of objects with declared fields. If
    // `additionalProperties: false` were only on the outermost object the model
    // could invent a field inside an assignment and nothing would stop it.
    const result = synthesizeParameterSchema(
      [{ id: "n_map", capability: "core.transform.map" }],
      registry,
    );

    const objects = everyObject(result.schema);
    expect(objects.length).toBeGreaterThanOrEqual(3);
    for (const object of objects) {
      expect(object.additionalProperties).toBe(false);
    }
  });

  it("carries the registry's descriptions, which are prompt text", () => {
    const result = synthesizeParameterSchema(
      [{ id: "n_slack", capability: "slack.message.send" }],
      registry,
    );
    const channel = nodeSchema(result.schema, "n_slack").properties?.["channel"];
    expect(channel?.description).toContain("Channel name");
  });

  it("carries none of the keywords structured outputs rejects", () => {
    // `slack.message.send.channel` has a pattern and `core.loop.for_each` has
    // numeric ranges. Both are enforced by validation stage 3 instead; a schema
    // carrying them would be rejected by the API.
    const result = synthesizeParameterSchema(
      [
        { id: "n_slack", capability: "slack.message.send" },
        { id: "n_loop", capability: "core.loop.for_each" },
      ],
      registry,
    );

    const serialized = JSON.stringify(result.schema);
    for (const banned of ["pattern", "minLength", "maxLength", "minimum", "maximum", "format"]) {
      expect(serialized).not.toContain(`"${banned}"`);
    }
  });

  it("is deterministic, because the schema is part of the prompt cache key", () => {
    const nodes = [
      { id: "n_a", capability: "slack.message.send" },
      { id: "n_b", capability: "core.transform.map" },
    ];
    expect(JSON.stringify(synthesizeParameterSchema(nodes, registry).schema)).toBe(
      JSON.stringify(synthesizeParameterSchema(nodes, registry).schema),
    );
  });
});

describe("parameter types", () => {
  it("maps each registry type to something structured outputs accepts", () => {
    const result = synthesizeParameterSchema(
      [
        { id: "n_slack", capability: "slack.message.send" },
        { id: "n_trigger", capability: "bamboohr.employee.created" },
        { id: "n_map", capability: "core.transform.map" },
        { id: "n_merge", capability: "core.merge.collect" },
      ],
      registry,
    );

    expect(nodeSchema(result.schema, "n_slack").properties?.["channel"]?.type).toBe("string");
    expect(
      nodeSchema(result.schema, "n_trigger").properties?.["poll_interval_minutes"]?.type,
    ).toBe("number");
    expect(nodeSchema(result.schema, "n_map").properties?.["include_other_fields"]?.type).toBe(
      "boolean",
    );
    expect(nodeSchema(result.schema, "n_map").properties?.["assignments"]?.type).toBe("array");
  });

  it("narrows an enum to its value type and lists the closed set", () => {
    const result = synthesizeParameterSchema(
      [{ id: "n_merge", capability: "core.merge.collect" }],
      registry,
    );
    const mode = nodeSchema(result.schema, "n_merge").properties?.["mode"];
    expect(mode?.type).toBe("string");
    expect(mode?.enum).toEqual(["append", "combine", "choose_branch"]);
  });

  it("describes an array through its item schema", () => {
    const result = synthesizeParameterSchema(
      [{ id: "n_map", capability: "core.transform.map" }],
      registry,
    );
    const assignments = nodeSchema(result.schema, "n_map").properties?.["assignments"];
    expect(assignments?.items?.type).toBe("object");
    expect(Object.keys(assignments?.items?.properties ?? {})).toEqual(["field", "value"]);
    expect(assignments?.items?.required).toEqual(["field", "value"]);
  });
});

describe("which parameters are required", () => {
  it("requires everything the registry marks required", () => {
    const result = synthesizeParameterSchema(
      [{ id: "n_gw", capability: "google_workspace.user.create" }],
      registry,
    );
    const required = nodeSchema(result.schema, "n_gw").required ?? [];
    expect(required).toContain("primary_email");
    expect(required).toContain("given_name");
    expect(required).toContain("family_name");
    expect(required).toContain("password");
  });

  it("does not require an optional parameter that has a default", () => {
    // The compiler applies the default, so forcing the model to restate it
    // wastes tokens and invites it to pick something worse.
    const result = synthesizeParameterSchema(
      [{ id: "n_gw", capability: "google_workspace.user.create" }],
      registry,
    );
    const required = nodeSchema(result.schema, "n_gw").required ?? [];
    expect(required).not.toContain("change_password_at_next_login");
    expect(required).not.toContain("org_unit_path");
    // Still offered, so the model may set it deliberately.
    expect(nodeSchema(result.schema, "n_gw").properties?.["org_unit_path"]).toBeDefined();
  });

  it("requires an optional string with no default, where the empty sentinel is legal", () => {
    const result = synthesizeParameterSchema(
      [{ id: "n_slack", capability: "slack.message.send" }],
      registry,
    );
    expect(nodeSchema(result.schema, "n_slack").required).toContain("thread_ts");
  });

  it("does not require a parameter the empty string could never satisfy", () => {
    // This is the deviation from AI_SPEC's stated rule, and the reason for it:
    // `""` is not a legal number, so requiring the key would manufacture a
    // stage 3 type failure on every generation and no repair could fix it,
    // because the fix is a key the schema demands.
    const number: ParameterDefinition = {
      type: "number",
      required: false,
      description: "how many",
    };
    expect(isRequiredInSchema(number)).toBe(false);

    const patterned: ParameterDefinition = {
      type: "string",
      required: false,
      description: "a channel",
      validation: { pattern: "^#" },
    };
    expect(isRequiredInSchema(patterned)).toBe(false);
  });

  it("knows exactly when the empty string is legal", () => {
    const plain: ParameterDefinition = { type: "string", required: false, description: "" };
    expect(emptyStringIsLegal(plain)).toBe(true);
    expect(emptyStringIsLegal({ ...plain, validation: { not_empty: true } })).toBe(false);
    expect(emptyStringIsLegal({ ...plain, validation: { min_length: 1 } })).toBe(false);
    expect(emptyStringIsLegal({ ...plain, validation: { min_length: 0 } })).toBe(true);
    expect(emptyStringIsLegal({ ...plain, validation: { pattern: "^x" } })).toBe(false);
    expect(emptyStringIsLegal({ ...plain, validation: { one_of: ["a"] } })).toBe(false);
    expect(emptyStringIsLegal({ ...plain, validation: { one_of: ["", "a"] } })).toBe(true);
    expect(emptyStringIsLegal({ type: "array", required: false, description: "" })).toBe(false);
  });

  it("closes the name set regardless of what is required", () => {
    // The central guarantee rests on `additionalProperties`, not on `required`,
    // so the rule above cannot weaken it.
    const result = synthesizeParameterSchema(
      [{ id: "n_gw", capability: "google_workspace.user.create" }],
      registry,
    );
    expect(nodeSchema(result.schema, "n_gw").additionalProperties).toBe(false);
  });
});

describe("parameters a closed schema cannot describe", () => {
  it("drops an optional open object and says so", () => {
    // `slack.message.send.blocks` is an array of objects with no declared
    // fields. `additionalProperties` may only be `false`, so there is no way
    // to express one.
    const result = synthesizeParameterSchema(
      [{ id: "n_slack", capability: "slack.message.send" }],
      registry,
    );

    expect(result.ok).toBe(true);
    expect(nodeSchema(result.schema, "n_slack").properties?.["blocks"]).toBeUndefined();

    const issue = result.issues.find((candidate) => candidate.parameter === "blocks");
    expect(issue?.severity).toBe("warning");
    expect(issue?.code).toBe("open_object_parameter");
    expect(issue?.nodeId).toBe("n_slack");
  });

  it("drops http.request.send's opaque header, query, and body parameters", () => {
    const result = synthesizeParameterSchema(
      [{ id: "n_http", capability: "http.request.send" }],
      registry,
    );

    // All three are optional, so this degrades rather than failing.
    expect(result.ok).toBe(true);
    const properties = nodeSchema(result.schema, "n_http").properties ?? {};
    expect(properties["headers"]).toBeUndefined();
    expect(properties["query"]).toBeUndefined();
    expect(properties["body"]).toBeUndefined();
    // The parameters that can be described still are.
    expect(properties["url"]?.type).toBe("string");
    expect(properties["method"]?.enum).toContain("POST");
  });

  it("treats a required open object as an error, not a warning", () => {
    // Dropping it would leave pass B unable to produce a document that
    // validates, and no repair can add a key the schema forbids.
    const doctored: Registry = {
      ...registry,
      capabilities: new Map([
        ...registry.capabilities,
        [
          "test.opaque.thing",
          {
            id: "test.opaque.thing",
            kind: "action",
            display_name: "Opaque",
            description: "",
            aliases: [],
            parameters: {
              payload: { type: "object", required: true, description: "anything" },
            },
          },
        ],
      ]),
      integrations: new Map([
        ...registry.integrations,
        [
          "test",
          {
            integration: "test",
            display_name: "Test",
            description: "",
            categories: [],
            aliases: [],
            auth: [],
            capabilities: [],
            source: {
              generated_from: "test",
              generated_at: "2026-01-01T00:00:00Z",
              overlay_version: 0,
            },
          },
        ],
      ]),
    };

    const result = synthesizeParameterSchema(
      [{ id: "n_opaque", capability: "test.opaque.thing" }],
      doctored,
    );

    expect(result.ok).toBe(false);
    const issue = result.issues[0];
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("required");
  });
});

describe("plans the schema cannot be built for", () => {
  it("reports an unknown capability rather than emitting an empty shape for it", () => {
    const result = synthesizeParameterSchema(
      [{ id: "n_missing", capability: "nope.does.not_exist" }],
      registry,
    );

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("unknown_capability");
    expect(result.schema.properties?.["n_missing"]).toBeUndefined();
    // Nothing is required that has no shape, so the schema itself stays valid.
    expect(result.schema.required).toEqual([]);
  });

  it("reports a duplicate node id, which one property cannot serve", () => {
    const result = synthesizeParameterSchema(
      [
        { id: "n_a", capability: "slack.message.send" },
        { id: "n_a", capability: "core.transform.map" },
      ],
      registry,
    );

    expect(result.ok).toBe(false);
    // Found by code rather than by position: `slack.message.send` also raises
    // a warning about `blocks`, and asserting on `issues[0]` would be
    // asserting on the order two unrelated findings happen to come out in.
    const duplicate = result.issues.find((issue) => issue.code === "duplicate_node_id");
    expect(duplicate?.severity).toBe("error");
    expect(duplicate?.nodeId).toBe("n_a");
    expect(result.schema.required).toEqual(["n_a"]);
  });

  it("keeps going after one bad node, so a plan comes back with every problem", () => {
    const result = synthesizeParameterSchema(
      [
        { id: "n_missing", capability: "nope.does.not_exist" },
        { id: "n_also_missing", capability: "still.not.here" },
        { id: "n_fine", capability: "slack.message.send" },
      ],
      registry,
    );

    expect(result.issues.filter((issue) => issue.code === "unknown_capability")).toHaveLength(2);
    expect(result.schema.properties?.["n_fine"]).toBeDefined();
  });
});
