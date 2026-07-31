import { describe, expect, it } from "vitest";

import {
  FIXTURE_REGISTRY_VERSION,
  readFixtureArtifacts,
} from "./__fixtures__/index.js";
import { buildIndex } from "./index.js";
import { checkIntegrity, IntegrityCode } from "./integrity.js";
import type { BindingFile, CapabilityFile, RegistryIndex } from "./types.js";

const artifacts = await readFixtureArtifacts();

function parse<T>(path: string): T {
  return JSON.parse(artifacts.get(path) ?? "") as T;
}

/**
 * A mutable view of `IntegrityInput`. The real type is readonly, which is right
 * for callers and useless for a test whose whole job is to break one thing.
 */
interface MutableInput {
  version: string;
  capabilityFiles: CapabilityFile[];
  bindingFiles: Map<string, BindingFile[]>;
  index: RegistryIndex;
}

/** The shipped build, deep-cloned, so each test can break exactly one thing. */
function shipped(): MutableInput {
  const capabilityFiles = [...artifacts]
    .filter(([path]) => path.startsWith("capabilities/"))
    .map(([path]) => structuredClone(parse<CapabilityFile>(path)));
  const bindingFiles = [...artifacts]
    .filter(([path]) => path.startsWith("bindings/n8n/"))
    .map(([path]) => structuredClone(parse<BindingFile>(path)));

  return {
    version: FIXTURE_REGISTRY_VERSION,
    capabilityFiles,
    bindingFiles: new Map([["n8n", bindingFiles]]),
    index: buildIndex(capabilityFiles, FIXTURE_REGISTRY_VERSION),
  };
}

function fileFor(input: MutableInput, integration: string): CapabilityFile {
  const file = input.capabilityFiles.find((entry) => entry.integration === integration);
  if (file === undefined) throw new Error(`no fixture for ${integration}`);
  return file;
}

function bindingFor(input: MutableInput, integration: string): BindingFile {
  const file = (input.bindingFiles.get("n8n") ?? []).find(
    (entry) => entry.integration === integration,
  );
  if (file === undefined) throw new Error(`no n8n binding fixture for ${integration}`);
  return file;
}

function codes(input: MutableInput): string[] {
  return checkIntegrity(input).map((issue) => issue.code);
}

describe("the shipped build", () => {
  it("passes every integrity check", () => {
    expect(checkIntegrity(shipped())).toEqual([]);
  });
});

describe("capability identity", () => {
  it("rejects a malformed capability ID", () => {
    const input = shipped();
    const capability = fileFor(input, "slack").capabilities[0];
    if (capability !== undefined) capability.id = "Slack.Message.Send";
    expect(codes(input)).toContain(IntegrityCode.CAPABILITY_ID_MALFORMED);
  });

  it("rejects a capability filed under the wrong integration", () => {
    const input = shipped();
    const capability = fileFor(input, "slack").capabilities[0];
    if (capability !== undefined) capability.id = "discord.message.send";
    expect(codes(input)).toContain(IntegrityCode.CAPABILITY_INTEGRATION_MISMATCH);
  });

  it("rejects the same ID defined twice, which would shadow one silently", () => {
    const input = shipped();
    const slack = fileFor(input, "slack");
    const first = slack.capabilities[0];
    if (first !== undefined) slack.capabilities.push(structuredClone(first));
    expect(codes(input)).toContain(IntegrityCode.DUPLICATE_CAPABILITY_ID);
  });

  it("rejects two files claiming one integration", () => {
    const input = shipped();
    input.capabilityFiles.push(structuredClone(fileFor(input, "slack")));
    expect(codes(input)).toContain(IntegrityCode.DUPLICATE_INTEGRATION);
  });
});

describe("aliases", () => {
  it("rejects an alias claimed by two capabilities", () => {
    const input = shipped();
    fileFor(input, "http").capabilities[0]?.aliases.push("post to slack");
    expect(codes(input)).toContain(IntegrityCode.ALIAS_COLLISION);
  });

  it("compares aliases on meaning rather than on punctuation", () => {
    const input = shipped();
    fileFor(input, "http").capabilities[0]?.aliases.push("Post To Slack!");
    expect(codes(input)).toContain(IntegrityCode.ALIAS_COLLISION);
  });

  it("rejects an alias claimed by two integrations", () => {
    const input = shipped();
    fileFor(input, "openai").aliases.push("slack workspace");
    expect(codes(input)).toContain(IntegrityCode.ALIAS_COLLISION);
  });

  it("allows an integration and a capability to share a phrase", () => {
    // Different namespaces answer different questions, so overlap between them
    // is normal rather than ambiguous.
    const input = shipped();
    fileFor(input, "openai").aliases.push("generate text");
    fileFor(input, "openai").capabilities[0]?.aliases.push("generate text");
    expect(codes(input)).not.toContain(IntegrityCode.ALIAS_COLLISION);
  });
});

describe("parameter rules", () => {
  it("rejects a validation pattern that is not a valid regular expression", () => {
    const input = shipped();
    const parameter = fileFor(input, "slack").capabilities[1]?.parameters["channel"];
    if (parameter !== undefined) parameter.validation = { pattern: "^([#@" };
    expect(codes(input)).toContain(IntegrityCode.PATTERN_UNCOMPILABLE);
  });

  it("rejects an enum defaulting outside its own values", () => {
    const input = shipped();
    const parameter = fileFor(input, "core").capabilities[2]?.parameters["mode"];
    if (parameter !== undefined) parameter.default = "outer_join";
    expect(codes(input)).toContain(IntegrityCode.ENUM_DEFAULT_NOT_IN_VALUES);
  });

  it("rejects a conditional requirement on a parameter that does not exist", () => {
    const input = shipped();
    const parameter = fileFor(input, "slack").capabilities[1]?.parameters["blocks"];
    if (parameter !== undefined) {
      parameter.conditional_required = { when: { attachments: { is_empty: true } } };
    }
    expect(codes(input)).toContain(IntegrityCode.CONDITIONAL_REQUIRED_UNKNOWN_PARAMETER);
  });
});

describe("auth", () => {
  it("rejects an auth_required naming no definition", () => {
    const input = shipped();
    const capability = fileFor(input, "slack").capabilities[1];
    if (capability !== undefined) capability.auth_required = "slack_magic";
    expect(codes(input)).toContain(IntegrityCode.AUTH_REQUIRED_MISSING);
  });

  it("rejects a required scope the auth definition does not offer", () => {
    const input = shipped();
    const capability = fileFor(input, "slack").capabilities[1];
    if (capability !== undefined) capability.required_scopes = ["chat:write", "admin"];
    expect(codes(input)).toContain(IntegrityCode.AUTH_SCOPE_UNDECLARED);
  });
});

describe("deprecation", () => {
  it("rejects a replacement pointer to nothing", () => {
    const input = shipped();
    const capability = fileFor(input, "slack").capabilities[1];
    if (capability !== undefined) {
      capability.deprecated = true;
      capability.replaced_by = "slack.message.post";
    }
    expect(codes(input)).toContain(IntegrityCode.REPLACED_BY_UNKNOWN);
  });

  it("accepts a replacement pointer to a capability that exists", () => {
    const input = shipped();
    const capability = fileFor(input, "slack").capabilities[1];
    if (capability !== undefined) {
      capability.deprecated = true;
      capability.replaced_by = "slack.channel.create";
    }
    expect(codes(input)).not.toContain(IntegrityCode.REPLACED_BY_UNKNOWN);
  });
});

describe("core coverage", () => {
  it("rejects a build missing a core capability FFIR depends on", () => {
    const input = shipped();
    const core = fileFor(input, "core");
    core.capabilities = core.capabilities.filter(
      (capability) => capability.id !== "core.branch.if",
    );
    input.index = buildIndex(input.capabilityFiles, input.version);
    expect(codes(input)).toContain(IntegrityCode.CORE_CAPABILITY_MISSING);
  });

  it("rejects a target that cannot express a core capability", () => {
    const input = shipped();
    const core = bindingFor(input, "core");
    core.bindings["core.branch.if"] = null;
    expect(codes(input)).toContain(IntegrityCode.CORE_CAPABILITY_UNBOUND);
  });

  it("rejects a target that has simply not mapped a core capability yet", () => {
    const input = shipped();
    delete bindingFor(input, "core").bindings["core.merge.collect"];
    expect(codes(input)).toContain(IntegrityCode.CORE_CAPABILITY_UNBOUND);
  });
});

describe("bindings", () => {
  it("rejects a binding for a capability nothing defines", () => {
    const input = shipped();
    bindingFor(input, "slack").bindings["slack.reaction.add"] = {
      node_type: "n8n-nodes-base.slack",
      type_version: 2.2,
    };
    expect(codes(input)).toContain(IntegrityCode.BINDING_WITHOUT_CAPABILITY);
  });

  it("rejects a parameter_map naming a parameter the capability does not declare", () => {
    const input = shipped();
    const binding = bindingFor(input, "slack").bindings["slack.message.send"];
    if (binding !== null && binding !== undefined) {
      binding.parameter_map = { ...binding.parameter_map, icon_emoji: "otherOptions.icon" };
    }
    expect(codes(input)).toContain(IntegrityCode.PARAMETER_MAP_UNKNOWN_PARAMETER);
  });

  it("rejects a transform naming a parameter the capability does not declare", () => {
    const input = shipped();
    const binding = bindingFor(input, "http").bindings["http.request.send"];
    if (binding !== null && binding !== undefined) {
      binding.transform = { ...binding.transform, payload: "object_to_json_string" };
    }
    expect(codes(input)).toContain(IntegrityCode.TRANSFORM_UNKNOWN_PARAMETER);
  });

  it("rejects a binding file sitting in the wrong platform directory", () => {
    const input = shipped();
    bindingFor(input, "slack").platform = "make";
    expect(codes(input)).toContain(IntegrityCode.BINDING_FILE_PLATFORM_MISMATCH);
  });

  it("accepts an explicit null on a non-core capability as a deliberate statement", () => {
    const input = shipped();
    bindingFor(input, "slack").bindings["slack.channel.create"] = null;
    expect(checkIntegrity(input)).toEqual([]);
  });
});

describe("the index", () => {
  it("rejects an index published under a different version", () => {
    const input = shipped();
    input.index = buildIndex(input.capabilityFiles, "n8n@1.0.0+overlay.0");
    expect(codes(input)).toContain(IntegrityCode.INDEX_VERSION_MISMATCH);
  });

  it("rejects a capability with no index entry, which pass A could never pick", () => {
    const input = shipped();
    input.index.entries = input.index.entries.filter(
      (entry) => entry.capability_id !== "slack.message.send",
    );
    expect(codes(input)).toContain(IntegrityCode.INDEX_ENTRY_MISSING);
  });

  it("rejects an index entry for a capability nothing defines", () => {
    const input = shipped();
    const first = input.index.entries[0];
    if (first !== undefined) {
      input.index.entries.push({ ...structuredClone(first), capability_id: "ghost.thing.do" });
    }
    expect(codes(input)).toContain(IntegrityCode.INDEX_ENTRY_WITHOUT_CAPABILITY);
  });

  it("rejects an entry that has drifted from its capability", () => {
    const input = shipped();
    const entry = input.index.entries.find((e) => e.capability_id === "slack.message.send");
    if (entry !== undefined) entry.description = "Sends a carrier pigeon.";
    expect(codes(input)).toContain(IntegrityCode.INDEX_ENTRY_STALE);
  });

  it("notices a dropped alias, which silently shrinks retrieval", () => {
    const input = shipped();
    const entry = input.index.entries.find((e) => e.capability_id === "slack.message.send");
    if (entry !== undefined) entry.aliases = entry.aliases.slice(1);
    expect(codes(input)).toContain(IntegrityCode.INDEX_ENTRY_STALE);
  });
});

describe("reporting", () => {
  it("collects every failure rather than stopping at the first", () => {
    const input = shipped();
    fileFor(input, "http").capabilities[0]?.aliases.push("post to slack");
    bindingFor(input, "slack").bindings["slack.reaction.add"] = {
      node_type: "x",
      type_version: 1,
    };
    bindingFor(input, "slack").platform = "make";

    const found = codes(input);
    expect(found).toContain(IntegrityCode.ALIAS_COLLISION);
    expect(found).toContain(IntegrityCode.BINDING_WITHOUT_CAPABILITY);
    expect(found).toContain(IntegrityCode.BINDING_FILE_PLATFORM_MISMATCH);
  });

  it("attributes each failure to the artifact that has to be edited", () => {
    const input = shipped();
    bindingFor(input, "slack").bindings["slack.reaction.add"] = {
      node_type: "x",
      type_version: 1,
    };
    const issue = checkIntegrity(input)[0];
    expect(issue?.artifact).toBe("bindings/n8n/slack.json");
    expect(issue?.details).toMatchObject({ capability_id: "slack.reaction.add" });
  });
});
