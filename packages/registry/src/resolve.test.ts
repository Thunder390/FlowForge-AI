import { describe, expect, it } from "vitest";

import { loadFixtureRegistry } from "./__fixtures__/index.js";
import {
  capabilitiesOfIntegration,
  integrationOf,
  isCoreCapability,
  resolve,
  resolveAuth,
  resolveBinding,
  resolveForTarget,
} from "./resolve.js";
import { DEFAULT_TARGET, isN8nBinding, type Binding, type Registry } from "./types.js";

const registry = await loadFixtureRegistry();

/** A registry with hand-placed bindings, for the cases the shipped fixtures should not fake. */
function syntheticRegistry(bindings: Record<string, Binding | null>): Registry {
  return {
    ...registry,
    bindings: new Map([["make", new Map(Object.entries(bindings))]]),
    targets: ["make"],
  };
}

describe("resolve", () => {
  it("returns the entry for a capability the registry has", () => {
    const resolved = resolve(registry, "slack.message.send");

    expect(resolved?.id).toBe("slack.message.send");
    expect(resolved?.capability.display_name).toBe("Send a message");
    expect(resolved?.capability.kind).toBe("action");
    expect(Object.keys(resolved?.capability.parameters ?? {})).toEqual([
      "channel",
      "text",
      "thread_ts",
      "blocks",
    ]);
    expect(resolved?.integration.integration).toBe("slack");
    expect(resolved?.integration.display_name).toBe("Slack");
  });

  it("resolves the auth definition the capability names", () => {
    const resolved = resolve(registry, "slack.message.send");
    expect(resolved?.auth?.id).toBe("slack_oauth2");
    expect(resolved?.auth?.type).toBe("oauth2");
    expect(resolved?.auth?.setup_notes).toContain("Slack app");
  });

  it("resolves no auth for a core primitive, which needs none", () => {
    const resolved = resolve(registry, "core.transform.map");
    expect(resolved?.auth).toBeUndefined();
    expect(resolved?.capability.auth_required).toBeUndefined();
  });

  it("returns undefined for a capability the registry does not have", () => {
    expect(resolve(registry, "pipedrive.deal.create")).toBeUndefined();
    expect(resolve(registry, "slack.message.unsend")).toBeUndefined();
  });

  it("returns undefined rather than throwing on a malformed ID", () => {
    expect(resolve(registry, "")).toBeUndefined();
    expect(resolve(registry, "slack")).toBeUndefined();
  });

  it("resolves the trigger capability with its mechanism intact", () => {
    const resolved = resolve(registry, "bamboohr.employee.created");
    expect(resolved?.capability.kind).toBe("trigger");
    expect(resolved?.capability.trigger).toEqual({
      mechanism: "polling",
      poll_interval_minutes: { default: 15, min: 5 },
      fallback: "webhook",
    });
  });

  it("carries the nested output shape the worked example's expressions read", () => {
    const employee = resolve(registry, "bamboohr.employee.created")?.capability.output?.[
      "employee"
    ];
    expect(employee?.type).toBe("object");
    expect(Object.keys(employee?.fields ?? {})).toContain("first_name");
    expect(Object.keys(employee?.fields ?? {})).toContain("last_name");
  });
});

describe("resolveForTarget", () => {
  it("joins the capability to its n8n binding", () => {
    const resolved = resolveForTarget(registry, "slack.message.send", DEFAULT_TARGET);

    expect(resolved?.status).toBe("bound");
    expect(resolved?.target).toBe("n8n");
    expect(resolved?.capability.display_name).toBe("Send a message");

    const binding = resolved?.binding;
    expect(binding !== undefined && isN8nBinding(binding)).toBe(true);
    expect(binding).toMatchObject({
      node_type: "n8n-nodes-base.slack",
      type_version: 2.2,
      static_parameters: { resource: "message", operation: "post" },
      credential_key: "slackOAuth2Api",
    });
    expect(binding?.parameter_map?.["thread_ts"]).toBe("otherOptions.thread_ts");
  });

  it("keeps platform vocabulary out of the capability half", () => {
    // The AI layer calls resolve, never resolveForTarget. If a node type could
    // reach it through the capability, the claim that adding a platform needs
    // no prompt change would stop being true.
    const serialized = JSON.stringify(resolve(registry, "slack.message.send")?.capability);
    expect(serialized).not.toContain("n8n");
    expect(serialized).not.toContain("node_type");
  });

  it("returns undefined for an unknown capability whatever the target", () => {
    expect(resolveForTarget(registry, "pipedrive.deal.create", "n8n")).toBeUndefined();
  });

  it("reports a whole unknown target as missing rather than throwing", () => {
    const resolved = resolveForTarget(registry, "slack.message.send", "node-red");
    expect(resolved?.status).toBe("missing");
    expect(resolved?.binding).toBeUndefined();
  });
});

describe("resolveBinding", () => {
  it("distinguishes cannot from not yet", () => {
    // The shipped fixtures bind everything to n8n, and faking a null there
    // would be dishonest registry data. The distinction is real and the
    // compiler acts on it, so it is proved against a purpose-built registry.
    const synthetic = syntheticRegistry({
      "slack.message.send": { module: "slack:CreateMessage" },
      "core.branch.if": null,
    });

    expect(resolveBinding(synthetic, "slack.message.send", "make")).toEqual({
      status: "bound",
      binding: { module: "slack:CreateMessage" },
    });
    expect(resolveBinding(synthetic, "core.branch.if", "make")).toEqual({
      status: "unsupported",
    });
    expect(resolveBinding(synthetic, "core.wait.delay", "make")).toEqual({
      status: "missing",
    });
  });

  it("reports missing for a target the registry has never heard of", () => {
    expect(resolveBinding(registry, "slack.message.send", "zapier")).toEqual({
      status: "missing",
    });
  });

  it("binds every capability the fixture build declares", () => {
    for (const id of registry.capabilities.keys()) {
      expect(resolveBinding(registry, id, DEFAULT_TARGET).status).toBe("bound");
    }
  });
});

describe("the capability and binding join", () => {
  it("maps only parameters the capability declares", () => {
    for (const [id, binding] of registry.bindings.get(DEFAULT_TARGET) ?? []) {
      if (binding === null) continue;
      const declared = Object.keys(resolve(registry, id)?.capability.parameters ?? {});
      for (const mapped of Object.keys(binding.parameter_map ?? {})) {
        expect(declared).toContain(mapped);
      }
      for (const transformed of Object.keys(binding.transform ?? {})) {
        expect(declared).toContain(transformed);
      }
    }
  });

  it("names no capability the capability files do not define", () => {
    for (const id of registry.bindings.get(DEFAULT_TARGET)?.keys() ?? []) {
      expect(registry.capabilities.has(id)).toBe(true);
    }
  });

  it("lowers the BambooHR trigger to a webhook, which is a visible degradation", () => {
    // BambooHR has no first-class n8n trigger node. The capability still
    // declares polling as its mechanism, so the compiler can see the mismatch
    // and warn rather than silently shipping something else.
    const resolved = resolveForTarget(registry, "bamboohr.employee.created", DEFAULT_TARGET);
    const binding = resolved?.binding;

    expect(resolved?.capability.trigger?.mechanism).toBe("polling");
    expect(resolved?.capability.trigger?.fallback).toBe("webhook");
    expect(binding !== undefined && isN8nBinding(binding) ? binding.node_type : undefined).toBe(
      "n8n-nodes-base.webhook",
    );
  });
});

describe("resolveAuth", () => {
  it("returns the named definition", () => {
    expect(resolveAuth(registry, "google_workspace.user.create")?.id).toBe(
      "google_workspace_oauth2",
    );
  });

  it("returns undefined when the capability needs none", () => {
    expect(resolveAuth(registry, "core.wait.delay")).toBeUndefined();
    expect(resolveAuth(registry, "http.request.send")).toBeUndefined();
  });

  it("returns undefined for an unknown capability", () => {
    expect(resolveAuth(registry, "pipedrive.deal.create")).toBeUndefined();
  });
});

describe("integration lookup", () => {
  it("lists an integration's capabilities, sorted, for the same-integration retry", () => {
    expect(capabilitiesOfIntegration(registry, "slack").map((c) => c.id)).toEqual([
      "slack.channel.create",
      "slack.message.send",
    ]);
  });

  it("returns an empty list for an unknown integration", () => {
    expect(capabilitiesOfIntegration(registry, "pipedrive")).toEqual([]);
    expect(integrationOf(registry, "pipedrive")).toBeUndefined();
  });

  it("identifies the reserved core namespace", () => {
    expect(isCoreCapability("core.branch.if")).toBe(true);
    expect(isCoreCapability("slack.message.send")).toBe(false);
    expect(isCoreCapability("http.request.send")).toBe(false);
  });
});
