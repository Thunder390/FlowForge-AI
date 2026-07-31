import { describe, expect, it } from "vitest";

import { readFixtureArtifacts } from "./__fixtures__/index.js";
import {
  checkBindingFile,
  checkCapabilityFile,
  checkRegistryIndex,
} from "./schema.js";
import { CAPABILITY_ID_PATTERN, PARAMETER_TYPES } from "./types.js";

const artifacts = await readFixtureArtifacts();

function artifactsUnder(prefix: string): [string, unknown][] {
  return [...artifacts]
    .filter(([path]) => path.startsWith(prefix))
    .map(([path, content]) => [path, JSON.parse(content)]);
}

/** A minimal file that passes, so each rejection test changes exactly one thing. */
function capabilityFile(): Record<string, unknown> {
  return {
    integration: "acme",
    display_name: "Acme",
    description: "A test integration.",
    categories: ["testing"],
    aliases: ["acme"],
    auth: [{ id: "acme_key", type: "api_key", label: "Acme key", default: true }],
    capabilities: [
      {
        id: "acme.thing.do",
        kind: "action",
        display_name: "Do a thing",
        description: "Does the thing.",
        aliases: ["do a thing"],
        auth_required: "acme_key",
        parameters: {
          target: {
            type: "string",
            required: true,
            description: "What to do it to.",
          },
        },
      },
    ],
    source: {
      generated_from: "n8n-nodes-base@1.62.0",
      generated_at: "2026-07-31T00:00:00Z",
      overlay_version: 0,
    },
  };
}

function bindingFile(): Record<string, unknown> {
  return {
    integration: "acme",
    platform: "n8n",
    bindings: {
      "acme.thing.do": {
        node_type: "n8n-nodes-base.acme",
        type_version: 1,
        parameter_map: { target: "target" },
      },
    },
    source: {
      generated_from: "n8n-nodes-base@1.62.0",
      generated_at: "2026-07-31T00:00:00Z",
      overlay_version: 0,
    },
  };
}

/** Reaches the single capability inside a cloned file. */
function capabilityIn(file: Record<string, unknown>): Record<string, unknown> {
  return (file["capabilities"] as Record<string, unknown>[])[0] as Record<string, unknown>;
}

describe("the shipped artifacts", () => {
  const capabilityFiles = artifactsUnder("capabilities/");
  const bindingFiles = artifactsUnder("bindings/");

  it("include a capability file per integration and a binding file to match", () => {
    expect(capabilityFiles).toHaveLength(6);
    expect(bindingFiles).toHaveLength(6);
  });

  it.each(capabilityFiles)("capability file %s matches its schema", (_path, content) => {
    const result = checkCapabilityFile(content);
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it.each(bindingFiles)("binding file %s matches its schema", (_path, content) => {
    const result = checkBindingFile(content);
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("index.json matches its schema", () => {
    const result = checkRegistryIndex(JSON.parse(artifacts.get("index.json") ?? ""));
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("capability file schema", () => {
  it("accepts the minimal valid file", () => {
    expect(checkCapabilityFile(capabilityFile()).ok).toBe(true);
  });

  it("rejects an unknown top-level property, because artifacts are closed", () => {
    const file = { ...capabilityFile(), notes: "an extension point" };
    const result = checkCapabilityFile(file);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.keyword)).toContain("additionalProperties");
    expect(result.violations[0]?.message).toContain("notes");
  });

  it("rejects a missing required property", () => {
    const file = capabilityFile();
    delete file["display_name"];
    const result = checkCapabilityFile(file);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.message).toContain("display_name");
  });

  it.each([
    ["Slack.message.send", "an uppercase segment"],
    ["slack.message", "two segments"],
    ["slack.message.send.now", "four segments"],
    ["slack-message.send.now", "a hyphen"],
    ["slack..send", "an empty segment"],
  ])("rejects capability ID %s (%s)", (id) => {
    const file = capabilityFile();
    capabilityIn(file)["id"] = id;
    expect(checkCapabilityFile(file).ok).toBe(false);
    expect(CAPABILITY_ID_PATTERN.test(id)).toBe(false);
  });

  it("pins the ID pattern to the one the type declares", () => {
    // Both the schema and CAPABILITY_ID_PATTERN encode build validation rule 1.
    // If one is edited the other has to move with it.
    const file = capabilityFile();
    capabilityIn(file)["id"] = "a1.b_2.c3";
    expect(checkCapabilityFile(file).ok).toBe(true);
    expect(CAPABILITY_ID_PATTERN.test("a1.b_2.c3")).toBe(true);
  });

  it("rejects a parameter type outside the closed set", () => {
    const file = capabilityFile();
    const parameters = capabilityIn(file)["parameters"] as Record<string, Record<string, unknown>>;
    parameters["target"] = { type: "uuid", required: true, description: "x" };
    expect(checkCapabilityFile(file).ok).toBe(false);
  });

  it.each(PARAMETER_TYPES)("accepts parameter type %s", (type) => {
    const file = capabilityFile();
    const parameters = capabilityIn(file)["parameters"] as Record<string, unknown>;
    parameters["target"] = {
      type,
      required: true,
      description: "A parameter.",
      ...(type === "enum" ? { values: ["a", "b"] } : {}),
    };
    expect(checkCapabilityFile(file).ok).toBe(true);
  });

  it("rejects an enum parameter with no values, which would close over nothing", () => {
    const file = capabilityFile();
    const parameters = capabilityIn(file)["parameters"] as Record<string, unknown>;
    parameters["target"] = { type: "enum", required: true, description: "Pick one." };
    expect(checkCapabilityFile(file).ok).toBe(false);
  });

  it("rejects a parameter with no description, because the description is prompt text", () => {
    const file = capabilityFile();
    const parameters = capabilityIn(file)["parameters"] as Record<string, unknown>;
    parameters["target"] = { type: "string", required: true };
    expect(checkCapabilityFile(file).ok).toBe(false);
  });

  it("rejects an upper-case parameter name", () => {
    const file = capabilityFile();
    capabilityIn(file)["parameters"] = {
      Target: { type: "string", required: true, description: "x" },
    };
    expect(checkCapabilityFile(file).ok).toBe(false);
  });

  it("requires a trigger block on a trigger capability", () => {
    const file = capabilityFile();
    capabilityIn(file)["kind"] = "trigger";
    const result = checkCapabilityFile(file);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.message.includes("trigger"))).toBe(true);
  });

  it("forbids a trigger block on anything else, and says which rule was broken", () => {
    const file = capabilityFile();
    capabilityIn(file)["trigger"] = { mechanism: "webhook" };
    const result = checkCapabilityFile(file);

    expect(result.ok).toBe(false);
    // Ajv's own text here is "boolean schema is false", which tells a curator
    // editing a capability file nothing at all.
    const violation = result.violations.find((v) => v.path === "/capabilities/0/trigger");
    expect(violation?.message).toContain('kind "trigger"');
  });

  it("accepts a trigger capability that carries its block", () => {
    const file = capabilityFile();
    const capability = capabilityIn(file);
    capability["kind"] = "trigger";
    capability["trigger"] = {
      mechanism: "polling",
      poll_interval_minutes: { default: 15, min: 5 },
      fallback: "webhook",
    };
    expect(checkCapabilityFile(file).ok).toBe(true);
  });

  it("requires a deprecated capability to point somewhere", () => {
    const file = capabilityFile();
    capabilityIn(file)["deprecated"] = true;
    expect(checkCapabilityFile(file).ok).toBe(false);

    capabilityIn(file)["replaced_by"] = "acme.thing.do_v2";
    expect(checkCapabilityFile(file).ok).toBe(true);
  });

  it("rejects a condition spec carrying more than one key", () => {
    const file = capabilityFile();
    const parameters = capabilityIn(file)["parameters"] as Record<string, unknown>;
    parameters["target"] = {
      type: "string",
      required: false,
      description: "x",
      conditional_required: { when: { other: { is_empty: true, equals: "y" } } },
    };
    expect(checkCapabilityFile(file).ok).toBe(false);
  });

  it("accepts each of the four condition specs", () => {
    for (const spec of [
      { is_empty: true },
      { is_not_empty: true },
      { equals: "combine" },
      { one_of: ["a", "b"] },
    ]) {
      const file = capabilityFile();
      const parameters = capabilityIn(file)["parameters"] as Record<string, unknown>;
      parameters["extra"] = {
        type: "string",
        required: false,
        description: "x",
        conditional_required: { when: { target: spec } },
      };
      expect(checkCapabilityFile(file).ok).toBe(true);
    }
  });

  it("rejects an empty validation block, which reads as a rule and is not one", () => {
    const file = capabilityFile();
    const parameters = capabilityIn(file)["parameters"] as Record<string, unknown>;
    parameters["target"] = {
      type: "string",
      required: true,
      description: "x",
      validation: {},
    };
    expect(checkCapabilityFile(file).ok).toBe(false);
  });

  it("rejects a file declaring no capabilities", () => {
    const file = capabilityFile();
    file["capabilities"] = [];
    expect(checkCapabilityFile(file).ok).toBe(false);
  });

  it("collects every violation rather than stopping at the first", () => {
    const file = capabilityFile();
    delete file["display_name"];
    delete file["description"];
    capabilityIn(file)["id"] = "NOPE";
    expect(checkCapabilityFile(file).violations.length).toBeGreaterThanOrEqual(3);
  });
});

describe("binding file schema", () => {
  it("accepts the minimal valid file", () => {
    expect(checkBindingFile(bindingFile()).ok).toBe(true);
  });

  it("accepts an explicit null, which is how a platform says it cannot", () => {
    const file = bindingFile();
    file["bindings"] = { "acme.thing.do": null };
    expect(checkBindingFile(file).ok).toBe(true);
  });

  it("accepts a Make binding and a Zapier binding", () => {
    for (const [platform, binding] of [
      ["make", { module: "acme:DoThing", parameter_map: { target: "target" } }],
      ["zapier", { app: "acme", action: "do_thing" }],
    ] as const) {
      const file = bindingFile();
      file["platform"] = platform;
      file["bindings"] = { "acme.thing.do": binding };
      expect(checkBindingFile(file).ok).toBe(true);
    }
  });

  it("rejects a binding that is neither one platform's shape nor another's", () => {
    const file = bindingFile();
    file["bindings"] = { "acme.thing.do": { node_type: "x", module: "y" } };
    const result = checkBindingFile(file);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.keyword === "oneOf")).toBe(true);
  });

  it("rejects an n8n binding with no pinned type version", () => {
    const file = bindingFile();
    file["bindings"] = { "acme.thing.do": { node_type: "n8n-nodes-base.acme" } };
    expect(checkBindingFile(file).ok).toBe(false);
  });

  it("rejects a binding keyed by something that is not a capability ID", () => {
    const file = bindingFile();
    file["bindings"] = { acme_thing_do: { node_type: "x", type_version: 1 } };
    expect(checkBindingFile(file).ok).toBe(false);
  });

  it("rejects a transform naming anything other than a plain function name", () => {
    const file = bindingFile();
    file["bindings"] = {
      "acme.thing.do": {
        node_type: "x",
        type_version: 1,
        transform: { target: "() => 1" },
      },
    };
    expect(checkBindingFile(file).ok).toBe(false);
  });
});

describe("index schema", () => {
  it("rejects an entry missing its description, which pass A needs", () => {
    const index = {
      version: "test@1",
      integrations: [],
      entries: [
        {
          capability_id: "acme.thing.do",
          integration: "acme",
          kind: "action",
          display_name: "Do a thing",
          aliases: [],
          categories: [],
        },
      ],
    };
    expect(checkRegistryIndex(index).ok).toBe(false);
  });

  it("rejects an unknown node kind", () => {
    const index = {
      version: "test@1",
      integrations: [],
      entries: [
        {
          capability_id: "acme.thing.do",
          integration: "acme",
          kind: "webhook",
          display_name: "Do a thing",
          description: "Does it.",
          aliases: [],
          categories: [],
        },
      ],
    };
    expect(checkRegistryIndex(index).ok).toBe(false);
  });
});
