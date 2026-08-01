import { cloneOnboarding, onboardingExample } from "@flowforge/ffir/fixtures";
import { loadFixtureRegistry } from "@flowforge/registry/fixtures";
import { describe, expect, it } from "vitest";

import { toIntegrations, type IntegrationUsage } from "./integrations.js";

const registry = await loadFixtureRegistry();
const list = toIntegrations(onboardingExample, registry);

function find(entries: IntegrationUsage[], id: string): IntegrationUsage {
  const entry = entries.find((candidate) => candidate.integration === id);
  if (entry === undefined) throw new Error(`no entry for ${id}`);
  return entry;
}

describe("the list", () => {
  it("has one entry per distinct integration, sorted", () => {
    expect(list.integrations.map((entry) => entry.integration)).toEqual([
      "bamboohr",
      "core",
      "google_workspace",
      "slack",
    ]);
  });

  it("folds two nodes on one integration into a single entry", () => {
    // The worked example posts to Slack twice. A list that showed Slack twice
    // would imply two accounts to connect.
    expect(find(list.integrations, "slack").nodeLabels).toEqual([
      "Announce in Slack",
      "Alert IT on failure",
    ]);
  });

  it("carries the capabilities used, sorted", () => {
    expect(find(list.integrations, "slack").capabilities).toEqual(["slack.message.send"]);
  });

  it("carries display name, description, docs, and categories from the registry", () => {
    expect(find(list.integrations, "bamboohr")).toMatchObject({
      displayName: "BambooHR",
      docsUrl: "https://documentation.bamboohr.com/docs",
      categories: ["hr"],
    });
  });
});

describe("auth", () => {
  it("reports what each integration needs connecting with", () => {
    expect(find(list.integrations, "slack").auth).toMatchObject({ type: "oauth2" });
    expect(find(list.integrations, "bamboohr").auth).toMatchObject({ type: "api_key" });
  });

  it("collects the scopes the workflow's own capabilities need", () => {
    expect(find(list.integrations, "slack").auth?.scopes).toEqual(["chat:write"]);
  });

  it("marks core as built in and gives it no auth", () => {
    // core is the platform-agnostic primitives. Asking a user to connect an
    // account for a Set node would be nonsense.
    const core = find(list.integrations, "core");
    expect(core.builtIn).toBe(true);
    expect(core.auth).toBeUndefined();
  });

  it("separates out the integrations that actually need connecting", () => {
    expect(list.requiringAuth.map((entry) => entry.integration)).toEqual([
      "bamboohr",
      "google_workspace",
      "slack",
    ]);
  });

  it("agrees with the number of credentials the document declares", () => {
    expect(list.requiringAuth).toHaveLength(onboardingExample.credentials.length);
  });
});

describe("the reserved namespaces", () => {
  it("reports http as an ordinary entry, because a raw HTTP call is worth seeing", () => {
    const doc = cloneOnboarding();
    doc.nodes[3]!.capability = "http.request.send";
    doc.nodes[3]!.parameters = { url: "https://example.com/hook" };
    delete doc.nodes[3]!.credential;

    const entry = find(toIntegrations(doc, registry).integrations, "http");
    expect(entry.displayName).toBe("HTTP Request");
    expect(entry.builtIn).toBe(false);
  });
});

describe("edge cases", () => {
  it("marks an integration the registry has never heard of rather than dropping it", () => {
    // Validation stage 2 rejects such a document, so seeing one means the UI is
    // showing something that skipped the pipeline. Hiding it makes that
    // invisible.
    const doc = cloneOnboarding();
    doc.nodes[3]!.capability = "pipedrive.deal.create";

    const entry = find(toIntegrations(doc, registry).integrations, "pipedrive");
    expect(entry.unknown).toBe(true);
    expect(entry.displayName).toBe("pipedrive");
    expect(entry.auth).toBeUndefined();
  });

  it("handles a capability id with no dots", () => {
    const doc = cloneOnboarding();
    doc.nodes[3]!.capability = "nonsense";

    expect(find(toIntegrations(doc, registry).integrations, "nonsense").unknown).toBe(true);
  });

  it("returns empty lists for a document with no nodes", () => {
    const doc = cloneOnboarding();
    doc.nodes = [];

    expect(toIntegrations(doc, registry)).toEqual({ integrations: [], requiringAuth: [] });
  });
});

describe("determinism", () => {
  it("produces the same list on repeated calls", () => {
    expect(toIntegrations(onboardingExample, registry)).toEqual(list);
  });

  it("sorts independently of the order the nodes are written in", () => {
    const shuffled = cloneOnboarding();
    shuffled.nodes = [...shuffled.nodes].reverse();

    expect(toIntegrations(shuffled, registry).integrations.map((e) => e.integration)).toEqual(
      list.integrations.map((entry) => entry.integration),
    );
  });

  it("does not mutate the document", () => {
    const before = structuredClone(onboardingExample);
    toIntegrations(onboardingExample, registry);
    expect(onboardingExample).toEqual(before);
  });
});
