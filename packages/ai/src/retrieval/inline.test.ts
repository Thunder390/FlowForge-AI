/**
 * The catalog's most important property is that it does not change.
 *
 * It sits inline in pass A's cached prefix, so a single reordered key
 * invalidates the whole prefix and the cache hit rate silently drops to zero.
 * Nothing breaks, every test still passes, and every request costs about ten
 * times what it should. That failure is invisible from the output, so it has to
 * be caught here.
 */

import { loadFixtureRegistry } from "@flowforge/registry/fixtures";
import type { OutputField, Registry } from "@flowforge/registry";
import { beforeAll, describe, expect, it } from "vitest";

import { flattenOutputs, InlineRetriever, renderBundle, renderCatalog } from "./inline.js";

let registry: Registry;
beforeAll(async () => {
  registry = await loadFixtureRegistry();
});

describe("the capability catalog", () => {
  it("is byte-identical across renders", () => {
    expect(renderCatalog(registry)).toBe(renderCatalog(registry));
  });

  it("contains no clock, no build id, and nothing else that varies", () => {
    const catalog = renderCatalog(registry);
    // The registry version is allowed and is the only thing here that ever
    // changes, because it changes only on a registry bump, which is exactly
    // when the prefix should be invalidated.
    expect(catalog).toContain("n8n@1.62.0+overlay.3");
    expect(catalog).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("lists every capability the registry holds", () => {
    // "The model can only choose from things that exist" is true by
    // construction only if everything that exists is actually in the prompt.
    const catalog = renderCatalog(registry);
    for (const entry of registry.index.entries) {
      expect(catalog).toContain(entry.capability_id);
    }
  });

  it("carries the four fields AI_SPEC names and no parameter schemas", () => {
    const catalog = renderCatalog(registry);
    expect(catalog).toContain("slack.message.send | action | Send a message | Posts a message");
    expect(catalog).toContain("aka: send slack message, post to slack");
    // Parameter schemas are pass B's job. Roughly two hundred thousand tokens
    // of them in every pass A request is what the two-pass split exists to
    // avoid.
    expect(catalog).not.toContain("Channel name with #");
  });

  it("states integration vocabulary once rather than per capability", () => {
    // Duplicating "slack workspace" across every Slack capability is paid for
    // on every request that misses the cache.
    const catalog = renderCatalog(registry);
    expect(catalog.split("slack workspace")).toHaveLength(2);
  });

  it("orders integrations and capabilities the way the registry index does", () => {
    const catalog = renderCatalog(registry);
    const positions = registry.index.entries.map((entry) =>
      catalog.indexOf(`\n${entry.capability_id} |`),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    // Sorted ascending means the rendering walked the index in its own order,
    // which is sorted at build time.
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe("the schema bundle", () => {
  it("carries only the capabilities asked for", () => {
    const bundle = renderBundle(registry, ["slack.message.send"]);
    expect(bundle.resolved).toEqual(["slack.message.send"]);
    expect(bundle.text).toContain("slack.message.send");
    expect(bundle.text).not.toContain("google_workspace.user.create");
  });

  it("de-duplicates and sorts, so node order cannot change the prompt", () => {
    const one = renderBundle(registry, [
      "slack.message.send",
      "core.transform.map",
      "slack.message.send",
    ]);
    const other = renderBundle(registry, ["core.transform.map", "slack.message.send"]);
    expect(one.text).toBe(other.text);
    expect(one.resolved).toEqual(["core.transform.map", "slack.message.send"]);
  });

  it("states the constraints the closed schema cannot carry", () => {
    // A pattern cannot go in a structured-output schema, so the only way the
    // model learns about it before failing validation is here.
    const bundle = renderBundle(registry, ["slack.message.send"]);
    expect(bundle.text).toContain("must match ^([#@][a-z0-9._-]+|[CDG][A-Z0-9]{8,})$");
    expect(bundle.text).toContain('e.g. "#general"');
  });

  it("states output shapes, which is what stops invented field names", () => {
    // The reason pass B can write `{{ n_trigger.employee.first_name }}` rather
    // than something plausible-sounding.
    const bundle = renderBundle(registry, ["bamboohr.employee.created"]);
    expect(bundle.text).toContain("employee.first_name: string");
    expect(bundle.text).toContain("employee.hire_date: datetime");
  });

  it("says plainly when a capability emits nothing referenceable", () => {
    const bundle = renderBundle(registry, ["core.transform.map"]);
    expect(bundle.text).toContain("Emits: nothing referenceable");
  });

  it("names the credential and the scopes a capability needs", () => {
    const bundle = renderBundle(registry, ["slack.message.send"]);
    expect(bundle.text).toContain("Credential: Slack OAuth2 (oauth2, scopes chat:write).");
  });

  it("reports an unknown id instead of silently dropping it", () => {
    // The unknown-capability ladder owns what happens next. Deciding it here
    // would put a retry policy inside a lookup.
    const bundle = renderBundle(registry, ["slack.message.send", "nope.not.real"]);
    expect(bundle.unknown).toEqual(["nope.not.real"]);
    expect(bundle.resolved).toEqual(["slack.message.send"]);
  });

  it("is stable across renders", () => {
    const ids = ["slack.message.send", "google_workspace.user.create"];
    expect(renderBundle(registry, ids).text).toBe(renderBundle(registry, ids).text);
  });
});

describe("flattening output shapes", () => {
  it("renders nested fields as the dotted paths an expression is written with", () => {
    const shape: Record<string, OutputField> = {
      employee: {
        type: "object",
        fields: {
          id: { type: "string" },
          name: { type: "object", fields: { first: { type: "string" } } },
        },
      },
    };
    expect(flattenOutputs(shape)).toEqual([
      "employee.id: string",
      "employee.name.first: string",
    ]);
  });

  it("marks arrays, and descends into arrays of objects", () => {
    const shape: Record<string, OutputField> = {
      tags: { type: "array", items: { type: "string" } },
      rows: { type: "array", items: { type: "object", fields: { id: { type: "string" } } } },
    };
    expect(flattenOutputs(shape)).toEqual(["tags[]: string", "rows[].id: string"]);
  });

  it("carries descriptions through and tolerates no shape at all", () => {
    expect(flattenOutputs({ ts: { type: "string", description: "Use for threading." } })).toEqual([
      "ts: string — Use for threading.",
    ]);
    expect(flattenOutputs(undefined)).toEqual([]);
  });
});

describe("the retriever", () => {
  it("is the inline strategy, named so a generation can record which ran", () => {
    const retriever = new InlineRetriever();
    expect(retriever.key).toBe("inline");
    expect(retriever.catalog(registry)).toBe(renderCatalog(registry));
    expect(retriever.bundle(registry, ["slack.message.send"]).text).toBe(
      renderBundle(registry, ["slack.message.send"]).text,
    );
  });
});
