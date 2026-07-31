import { describe, expect, it } from "vitest";

import {
  FIXTURE_REGISTRY_VERSION,
  loadFixtureRegistry,
  readFixtureArtifacts,
} from "./__fixtures__/index.js";
import {
  buildIndex,
  entriesForIntegration,
  searchCapabilities,
  searchIntegrations,
  serializeIndex,
} from "./index.js";
import type { CapabilityFile, RegistryIndex } from "./types.js";

const artifacts = await readFixtureArtifacts();
const registry = await loadFixtureRegistry();
const index = registry.index;

const capabilityFiles: CapabilityFile[] = [...artifacts]
  .filter(([path]) => path.startsWith("capabilities/"))
  .map(([, content]) => JSON.parse(content) as CapabilityFile);

describe("buildIndex", () => {
  it("reproduces the shipped index.json exactly", () => {
    // The index is derived, so the only way it can be wrong is by being stale.
    // Deriving it in the test and comparing is what makes staleness impossible
    // rather than merely unlikely.
    const built = buildIndex(capabilityFiles, FIXTURE_REGISTRY_VERSION);
    const shipped = JSON.parse(artifacts.get("index.json") ?? "") as RegistryIndex;
    expect(built).toEqual(shipped);
  });

  it("reproduces the shipped file's formatting, not only its content", () => {
    const built = serializeIndex(buildIndex(capabilityFiles, FIXTURE_REGISTRY_VERSION));
    const shipped = (artifacts.get("index.json") ?? "").replace(/\r\n/g, "\n");
    expect(built).toBe(shipped);
  });

  it("sorts entries by capability ID and integrations by integration ID", () => {
    const built = buildIndex(capabilityFiles, FIXTURE_REGISTRY_VERSION);
    const ids = built.entries.map((entry) => entry.capability_id);
    const integrations = built.integrations.map((entry) => entry.integration);
    expect(ids).toEqual([...ids].sort());
    expect(integrations).toEqual([...integrations].sort());
  });

  it("does not depend on the order the capability files arrived in", () => {
    const forwards = buildIndex(capabilityFiles, FIXTURE_REGISTRY_VERSION);
    const backwards = buildIndex([...capabilityFiles].reverse(), FIXTURE_REGISTRY_VERSION);
    expect(backwards).toEqual(forwards);
  });

  it("holds integration aliases once rather than on every entry", () => {
    const slack = index.integrations.find((entry) => entry.integration === "slack");
    expect(slack?.aliases).toContain("slack workspace");
    for (const entry of entriesForIntegration(index, "slack")) {
      expect(entry.aliases).not.toContain("slack workspace");
    }
  });
});

describe("searchCapabilities", () => {
  it('finds slack.message.send from "post to slack"', () => {
    const hits = searchCapabilities(index, "post to slack");
    expect(hits[0]?.capability_id).toBe("slack.message.send");
    expect(hits[0]?.matched_on).toBe("alias");
    expect(hits[0]?.score).toBe(1);
  });

  it.each([
    ["send a slack message", "slack.message.send"],
    ["notify the team in slack when it is done", "slack.message.send"],
    ["announce in slack", "slack.message.send"],
    ["create a slack channel", "slack.channel.create"],
    ["create a google account", "google_workspace.user.create"],
    ["provision an email address for the new hire", "google_workspace.user.create"],
    ["when a new hire is added", "bamboohr.employee.created"],
    ["call a rest api", "http.request.send"],
    ["summarise with ai", "openai.chat.complete"],
    ["for each item", "core.loop.for_each"],
    ["pause the workflow", "core.wait.delay"],
    ["check a condition", "core.branch.if"],
  ])("resolves %j to %s", (query, expected) => {
    expect(searchCapabilities(index, query)[0]?.capability_id).toBe(expected);
  });

  it("scores an exact capability ID at 1", () => {
    const hits = searchCapabilities(index, "slack.message.send");
    expect(hits[0]?.capability_id).toBe("slack.message.send");
    expect(hits[0]?.matched_on).toBe("capability_id");
    expect(hits[0]?.score).toBe(1);
  });

  it("reports the string that scored, so a substitution can be logged with its evidence", () => {
    const hits = searchCapabilities(index, "slack alert");
    expect(hits[0]?.matched_value).toBe("slack alert");
  });

  it("returns nothing for a query nothing matches", () => {
    expect(searchCapabilities(index, "reticulate the splines")).toEqual([]);
  });

  it("returns nothing for an empty query rather than everything", () => {
    expect(searchCapabilities(index, "")).toEqual([]);
    expect(searchCapabilities(index, "   ")).toEqual([]);
  });

  it("does not let a bare integration name pick a capability on its own", () => {
    // "slack" identifies an integration, not one of its capabilities. Returning
    // an arbitrary Slack capability here would be a confident wrong answer, and
    // rung 2 of the ladder exists precisely for this case.
    expect(searchCapabilities(index, "slack")).toEqual([]);
    expect(searchIntegrations(index, "slack")[0]?.integration).toBe("slack");
  });

  it("filters by node kind", () => {
    const triggers = searchCapabilities(index, "new employee", { kind: "trigger" });
    expect(triggers.map((hit) => hit.capability_id)).toEqual(["bamboohr.employee.created"]);
    expect(searchCapabilities(index, "new employee", { kind: "merge" })).toEqual([]);
  });

  it("filters by integration, which is how rung 2 narrows the search", () => {
    const hits = searchCapabilities(index, "create", {
      integration: "slack",
      minScore: 0.1,
    });
    expect(hits.every((hit) => hit.integration === "slack")).toBe(true);
    expect(hits.map((hit) => hit.capability_id)).toContain("slack.channel.create");
  });

  it("honours the limit", () => {
    const hits = searchCapabilities(index, "slack message", { limit: 1, minScore: 0.1 });
    expect(hits).toHaveLength(1);
  });

  it("honours the score floor", () => {
    const loose = searchCapabilities(index, "slack", { minScore: 0 });
    expect(loose.length).toBeGreaterThan(0);
    expect(searchCapabilities(index, "slack", { minScore: 0.99 })).toEqual([]);
  });

  it("returns hits in descending score order", () => {
    const hits = searchCapabilities(index, "send a message to slack", { minScore: 0 });
    const scores = hits.map((hit) => hit.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("is deterministic across repeated calls", () => {
    const once = searchCapabilities(index, "notify the team", { minScore: 0 });
    const twice = searchCapabilities(index, "notify the team", { minScore: 0 });
    expect(twice).toEqual(once);
  });

  it("prefers the alias that covered more of the sentence", () => {
    // This query contains two aliases outright: "provision an email address"
    // and "new hire". Both match as whole phrases and score identically, so
    // only specificity separates them, and the longer one is what the sentence
    // is actually about.
    const hits = searchCapabilities(index, "provision an email address for the new hire");
    expect(hits[0]?.capability_id).toBe("google_workspace.user.create");
    expect(hits[0]?.matched_value).toBe("provision an email address");
    expect(hits[1]?.capability_id).toBe("bamboohr.employee.created");
    expect(hits[1]?.score).toBe(hits[0]?.score);
  });

  it("breaks ties on capability ID rather than on load order", () => {
    // Every core capability scores identically against a query that matches
    // only the integration, so the tie-break is the only thing ordering them.
    const hits = searchCapabilities(index, "core primitive", {
      minScore: 0,
      integration: "core",
    });
    const ids = hits.map((hit) => hit.capability_id);
    expect(new Set(hits.map((hit) => hit.score)).size).toBe(1);
    expect(ids).toEqual([...ids].sort());
  });

  it("ignores case and punctuation", () => {
    const plain = searchCapabilities(index, "post to slack");
    expect(searchCapabilities(index, "POST TO SLACK!")).toEqual(plain);
    expect(searchCapabilities(index, "  post   to   slack  ")).toEqual(plain);
  });

  it("finds an alias sitting inside a longer sentence", () => {
    const hits = searchCapabilities(
      index,
      "when the deploy finishes please post to slack and then stop",
    );
    expect(hits[0]?.capability_id).toBe("slack.message.send");
    expect(hits[0]?.score).toBe(0.9);
  });

  it("returns an empty array rather than throwing on a non-positive limit", () => {
    expect(searchCapabilities(index, "post to slack", { limit: 0 })).toEqual([]);
  });
});

describe("searchIntegrations", () => {
  it.each([
    ["slack workspace", "slack"],
    ["gsuite", "google_workspace"],
    ["bamboo hr", "bamboohr"],
    ["chatgpt", "openai"],
    ["our hr system", "bamboohr"],
  ])("resolves %j to %s", (query, expected) => {
    expect(searchIntegrations(index, query)[0]?.integration).toBe(expected);
  });

  it("returns nothing for an unknown app", () => {
    expect(searchIntegrations(index, "pipedrive")).toEqual([]);
  });

  it("reports an integration-name match as one, not as a capability ID match", () => {
    expect(searchIntegrations(index, "slack")[0]).toMatchObject({
      integration: "slack",
      score: 1,
      matched_on: "integration",
      matched_value: "slack",
    });
  });

  it("does not discount an integration's own vocabulary the way capability search does", () => {
    // The same string scores 0.45 as a weak signal in searchCapabilities and 1
    // here, because it is the whole answer to this question and a hint to the
    // other one.
    expect(searchIntegrations(index, "openai")[0]?.score).toBe(1);
    expect(searchCapabilities(index, "openai", { minScore: 0 })[0]?.score).toBe(0.45);
  });

  it("is deterministic", () => {
    const once = searchIntegrations(index, "google", { minScore: 0 });
    expect(searchIntegrations(index, "google", { minScore: 0 })).toEqual(once);
  });
});

describe("entriesForIntegration", () => {
  it("returns every capability of one integration, sorted", () => {
    const ids = entriesForIntegration(index, "core").map((entry) => entry.capability_id);
    expect(ids).toEqual([
      "core.branch.if",
      "core.loop.for_each",
      "core.merge.collect",
      "core.transform.map",
      "core.wait.delay",
    ]);
  });

  it("returns nothing for an integration the registry does not have", () => {
    expect(entriesForIntegration(index, "pipedrive")).toEqual([]);
  });
});
