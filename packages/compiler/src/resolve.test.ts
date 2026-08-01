/**
 * Stage 2's whole job is the three-way outcome and what each one produces.
 * The two degrading paths matter most: they are the ones that change what gets
 * exported, and a silent degradation is the failure mode this product can least
 * afford.
 */

import { cloneOnboarding, onboardingExample } from "@flowforge/ffir/fixtures";
import { HTTP_FALLBACK_CAPABILITY, type Binding, type Registry } from "@flowforge/registry";
import { loadFixtureRegistry } from "@flowforge/registry/fixtures";
import { describe, expect, it } from "vitest";

import { nodeOf } from "./__fixtures__/documents.js";
import { resolveNodes } from "./resolve.js";

const registry = await loadFixtureRegistry();
const TARGET = "n8n";

/** The fixture registry with one capability's binding replaced or removed. */
function withBinding(capability: string, binding: Binding | null | "absent"): Registry {
  const forTarget = new Map(registry.bindings.get(TARGET));
  if (binding === "absent") forTarget.delete(capability);
  else forTarget.set(capability, binding);

  return { ...registry, bindings: new Map([[TARGET, forTarget]]) };
}

describe("a fully bound document", () => {
  it("resolves every node with no warnings", () => {
    const result = resolveNodes(onboardingExample.nodes, registry, TARGET);
    if (!result.ok) throw new Error("expected success");

    expect(result.value.nodes).toHaveLength(5);
    expect(result.warnings).toEqual([]);
    expect(result.value.nodes.every((node) => !node.degraded)).toBe(true);
  });

  it("keeps document order and the document index", () => {
    const result = resolveNodes(onboardingExample.nodes, registry, TARGET);
    if (!result.ok) throw new Error("expected success");

    expect(result.value.nodes.map((node) => node.node.id)).toEqual([
      "n_trigger",
      "n_build_email",
      "n_create_account",
      "n_slack_welcome",
      "n_alert_it",
    ]);
    expect(result.value.nodes.map((node) => node.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("reports the capability the node asked for as the one it is bound to", () => {
    const result = resolveNodes(onboardingExample.nodes, registry, TARGET);
    if (!result.ok) throw new Error("expected success");

    const slack = result.value.byId.get("n_slack_welcome");
    expect(slack?.boundCapability).toBe("slack.message.send");
    expect(slack?.resolved.status).toBe("bound");
  });

  it("indexes by node id", () => {
    const result = resolveNodes(onboardingExample.nodes, registry, TARGET);
    if (!result.ok) throw new Error("expected success");
    expect([...result.value.byId.keys()]).toEqual(
      result.value.nodes.map((node) => node.node.id),
    );
  });
});

describe("degradation", () => {
  it("falls back to HTTP when the binding is explicitly null", () => {
    const result = resolveNodes(
      onboardingExample.nodes,
      withBinding("slack.message.send", null),
      TARGET,
    );
    if (!result.ok) throw new Error("expected success");

    const slack = result.value.byId.get("n_slack_welcome");
    expect(slack?.degraded).toBe(true);
    expect(slack?.boundCapability).toBe(HTTP_FALLBACK_CAPABILITY);
  });

  it("falls back to HTTP when the binding key is absent", () => {
    const result = resolveNodes(
      onboardingExample.nodes,
      withBinding("slack.message.send", "absent"),
      TARGET,
    );
    if (!result.ok) throw new Error("expected success");
    expect(result.value.byId.get("n_slack_welcome")?.degraded).toBe(true);
  });

  it("uses a different warning code for each, because they mean different things", () => {
    // `capability_degraded` is a fact about the platform. `capability_unknown`
    // is a fact about our registry coverage, and only the second is something
    // we can fix. Merging them would hide the size of the backlog.
    const explicit = resolveNodes(
      onboardingExample.nodes,
      withBinding("slack.message.send", null),
      TARGET,
    );
    const absent = resolveNodes(
      onboardingExample.nodes,
      withBinding("slack.message.send", "absent"),
      TARGET,
    );

    expect(explicit.warnings.map((warning) => warning.code)).toEqual([
      "capability_degraded",
      "capability_degraded",
    ]);
    expect(absent.warnings.map((warning) => warning.code)).toEqual([
      "capability_unknown",
      "capability_unknown",
    ]);
  });

  it("names the node in the warning so the canvas can badge it", () => {
    const result = resolveNodes(
      onboardingExample.nodes,
      withBinding("slack.message.send", null),
      TARGET,
    );

    expect(result.warnings[0]).toMatchObject({ nodeId: "n_slack_welcome" });
    expect(result.warnings[1]).toMatchObject({ nodeId: "n_alert_it" });
  });

  it("writes the warning for the user, not for us", () => {
    const result = resolveNodes(
      onboardingExample.nodes,
      withBinding("slack.message.send", null),
      TARGET,
    );

    const message = result.warnings[0]?.message ?? "";
    expect(message).toContain("Announce in Slack");
    expect(message).toContain("configuring by hand");
  });

  it("still remembers what the node originally asked for", () => {
    // The setup guide has to tell the user what the step was meant to do, not
    // what it fell back to.
    const result = resolveNodes(
      onboardingExample.nodes,
      withBinding("slack.message.send", null),
      TARGET,
    );
    if (!result.ok) throw new Error("expected success");

    const slack = result.value.byId.get("n_slack_welcome");
    expect(slack?.resolved.id).toBe("slack.message.send");
    expect(slack?.node.capability).toBe("slack.message.send");
    expect(slack?.boundCapability).toBe(HTTP_FALLBACK_CAPABILITY);
  });

  it("degrades several nodes independently", () => {
    const stripped = withBinding("slack.message.send", null);
    const result = resolveNodes(onboardingExample.nodes, stripped, TARGET);
    if (!result.ok) throw new Error("expected success");

    expect(result.value.nodes.filter((node) => node.degraded)).toHaveLength(2);
    expect(result.value.nodes.filter((node) => !node.degraded)).toHaveLength(3);
  });
});

describe("failures", () => {
  it("reports a capability the registry does not contain", () => {
    const doc = cloneOnboarding();
    nodeOf(doc, "n_slack_welcome").capability = "slack.message.broadcast";

    const result = resolveNodes(doc.nodes, registry, TARGET);
    if (result.ok) throw new Error("expected a failure");
    expect(result.errors[0]).toMatchObject({
      stage: "resolve",
      code: "capability_unknown",
      capability: "slack.message.broadcast",
      nodeId: "n_slack_welcome",
    });
  });

  it("reports every unresolvable node, not just the first", () => {
    const doc = cloneOnboarding();
    nodeOf(doc, "n_slack_welcome").capability = "slack.message.broadcast";
    nodeOf(doc, "n_alert_it").capability = "discord.message.send";

    const result = resolveNodes(doc.nodes, registry, TARGET);
    if (result.ok) throw new Error("expected a failure");
    expect(result.errors).toHaveLength(2);
  });

  it("fails rather than degrading when the HTTP fallback itself is unbound", () => {
    // A registry whose universal escape hatch is unbound cannot serve this
    // target. Saying so beats emitting a node with no binding and letting
    // stage 4 fail on a missing field for a reason nobody can see.
    const forTarget = new Map(registry.bindings.get(TARGET));
    forTarget.set("slack.message.send", null);
    forTarget.delete(HTTP_FALLBACK_CAPABILITY);
    const broken: Registry = { ...registry, bindings: new Map([[TARGET, forTarget]]) };

    const result = resolveNodes(onboardingExample.nodes, broken, TARGET);
    if (result.ok) throw new Error("expected a failure");
    expect(result.errors[0]).toMatchObject({
      stage: "resolve",
      capability: HTTP_FALLBACK_CAPABILITY,
    });
  });

  it("keeps the warnings it had already collected when it fails", () => {
    const doc = cloneOnboarding();
    nodeOf(doc, "n_alert_it").capability = "discord.message.send";

    const result = resolveNodes(doc.nodes, withBinding("slack.message.send", null), TARGET);
    expect(result.ok).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("edge cases", () => {
  it("treats an unknown target as a registry gap rather than throwing", () => {
    // From the compiler's point of view a target the registry has never heard
    // of is the same situation as an unmapped capability, and should degrade
    // the same way.
    const result = resolveNodes(onboardingExample.nodes, registry, "make");
    if (result.ok) throw new Error("expected a failure");
    // Nothing to degrade to either, because the fallback is unbound there too.
    expect(result.errors[0]).toMatchObject({
      stage: "resolve",
      capability: HTTP_FALLBACK_CAPABILITY,
    });
  });

  it("resolves an empty node list to an empty result", () => {
    const result = resolveNodes([], registry, TARGET);
    if (!result.ok) throw new Error("expected success");
    expect(result.value.nodes).toEqual([]);
    expect(result.value.byId.size).toBe(0);
  });

  it("resolves two nodes sharing one capability to the same binding", () => {
    const result = resolveNodes(onboardingExample.nodes, registry, TARGET);
    if (!result.ok) throw new Error("expected success");

    expect(result.value.byId.get("n_slack_welcome")?.binding).toEqual(
      result.value.byId.get("n_alert_it")?.binding,
    );
  });
});

describe("determinism", () => {
  it("produces the same result and the same warning order every run", () => {
    const stripped = withBinding("slack.message.send", null);
    const once = resolveNodes(onboardingExample.nodes, stripped, TARGET);
    expect(resolveNodes(onboardingExample.nodes, stripped, TARGET)).toEqual(once);
  });
});
