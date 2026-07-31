import { describe, expect, it } from "vitest";

import {
  FIXTURE_INTEGRATIONS,
  FIXTURE_REGISTRY_VERSION,
  fixtureSource,
  memorySourceFromFixtures,
} from "./__fixtures__/index.js";
import { RegistryError, RegistryErrorCode } from "./errors.js";
import {
  ARTIFACT_PATHS,
  FileSystemArtifactSource,
  MemoryArtifactSource,
  RegistryIntegrityError,
  RegistryLoader,
} from "./load.js";

const OTHER_VERSION = "n8n@1.63.0+overlay.1";

describe("loading the fixture build", () => {
  it("reads every artifact and joins them", async () => {
    const registry = await new RegistryLoader(fixtureSource()).load(FIXTURE_REGISTRY_VERSION);

    expect(registry.version).toBe(FIXTURE_REGISTRY_VERSION);
    expect([...registry.integrations.keys()]).toEqual([...FIXTURE_INTEGRATIONS]);
    expect(registry.capabilities.size).toBe(11);
    expect(registry.targets).toEqual(["n8n"]);
    expect(registry.index.entries).toHaveLength(11);
  });

  it("orders integrations and capabilities deterministically", async () => {
    const registry = await new RegistryLoader(fixtureSource()).load(FIXTURE_REGISTRY_VERSION);

    const integrations = [...registry.integrations.keys()];
    const capabilities = [...registry.capabilities.keys()];
    expect(integrations).toEqual([...integrations].sort());
    expect(capabilities).toEqual([...capabilities].sort());

    for (const entry of registry.integrations.values()) {
      const ids = entry.capabilities.map((capability) => capability.id);
      expect(ids).toEqual([...ids].sort());
    }
  });

  it("produces an identical registry on a second, independent load", async () => {
    const first = await new RegistryLoader(fixtureSource()).load(FIXTURE_REGISTRY_VERSION);
    const second = await new RegistryLoader(fixtureSource()).load(FIXTURE_REGISTRY_VERSION);
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });

  it("carries the binding for every capability the build declares", async () => {
    const registry = await new RegistryLoader(fixtureSource()).load(FIXTURE_REGISTRY_VERSION);
    const n8n = registry.bindings.get("n8n");
    expect([...(n8n?.keys() ?? [])]).toEqual([...registry.capabilities.keys()]);
  });
});

describe("version addressing", () => {
  it("errors on a version that is not published, never falling back", async () => {
    const loader = new RegistryLoader(fixtureSource());
    await expect(loader.load("n8n@9.9.9+overlay.0")).rejects.toMatchObject({
      code: RegistryErrorCode.VERSION_NOT_FOUND,
      version: "n8n@9.9.9+overlay.0",
    });
    expect(loader.cachedVersions).toEqual([]);
  });

  it("loads the pin with no warning when it exists", async () => {
    const loader = new RegistryLoader(fixtureSource());
    const result = await loader.loadPinned({
      pinned: FIXTURE_REGISTRY_VERSION,
      fallback: FIXTURE_REGISTRY_VERSION,
    });
    expect(result.warnings).toEqual([]);
    expect(result.registry.version).toBe(FIXTURE_REGISTRY_VERSION);
  });

  it("falls back to the default and says so", async () => {
    const loader = new RegistryLoader(fixtureSource());
    const result = await loader.loadPinned({
      pinned: "n8n@1.0.0+overlay.0",
      fallback: FIXTURE_REGISTRY_VERSION,
    });

    expect(result.registry.version).toBe(FIXTURE_REGISTRY_VERSION);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      code: "registry_version_unavailable",
      requested: "n8n@1.0.0+overlay.0",
      used: FIXTURE_REGISTRY_VERSION,
    });
    // The message is rendered to a user, so it has to say what changed and why
    // it matters, not merely that something was substituted.
    expect(result.warnings[0]?.message).toContain("may differ");
  });

  it("does not warn when nothing was pinned in the first place", async () => {
    const loader = new RegistryLoader(fixtureSource());
    const result = await loader.loadPinned({ fallback: FIXTURE_REGISTRY_VERSION });
    expect(result.warnings).toEqual([]);
  });

  it("errors when the pin is unavailable and no fallback is configured", async () => {
    const loader = new RegistryLoader(fixtureSource());
    await expect(loader.loadPinned({ pinned: "n8n@1.0.0+overlay.0" })).rejects.toBeInstanceOf(
      RegistryError,
    );
  });
});

describe("caching", () => {
  it("reads a version once and serves the rest from memory", async () => {
    const source = await memorySourceFromFixtures([FIXTURE_REGISTRY_VERSION]);
    const loader = new RegistryLoader(source);

    const first = await loader.load(FIXTURE_REGISTRY_VERSION);
    const readsAfterFirst = source.reads.length;
    const second = await loader.load(FIXTURE_REGISTRY_VERSION);

    expect(readsAfterFirst).toBeGreaterThan(0);
    expect(source.reads).toHaveLength(readsAfterFirst);
    expect(second).toBe(first);
  });

  it("shares one load between concurrent callers", async () => {
    const source = await memorySourceFromFixtures([FIXTURE_REGISTRY_VERSION]);
    const loader = new RegistryLoader(source);

    const [a, b, c] = await Promise.all([
      loader.load(FIXTURE_REGISTRY_VERSION),
      loader.load(FIXTURE_REGISTRY_VERSION),
      loader.load(FIXTURE_REGISTRY_VERSION),
    ]);

    expect(b).toBe(a);
    expect(c).toBe(a);
    // 13 artifacts: six capability files, six bindings, and the index.
    expect(source.reads).toHaveLength(13);
  });

  it("evicts the least recently used version", async () => {
    const versions = ["v1", "v2", "v3"];
    const source = await memorySourceFromFixtures(versions);
    const loader = new RegistryLoader(source, { maxCachedVersions: 2 });

    await loader.load("v1");
    await loader.load("v2");
    expect(loader.cachedVersions).toEqual(["v1", "v2"]);

    await loader.load("v3");
    expect(loader.cachedVersions).toEqual(["v2", "v3"]);
  });

  it("counts a cache hit as a use, so the recently read version survives", async () => {
    const source = await memorySourceFromFixtures(["v1", "v2", "v3"]);
    const loader = new RegistryLoader(source, { maxCachedVersions: 2 });

    await loader.load("v1");
    await loader.load("v2");
    await loader.load("v1");
    await loader.load("v3");

    expect(loader.cachedVersions).toEqual(["v1", "v3"]);
  });

  it("holds at least one version however small the limit is asked to be", async () => {
    const source = await memorySourceFromFixtures(["v1"]);
    const loader = new RegistryLoader(source, { maxCachedVersions: 0 });
    await loader.load("v1");
    expect(loader.cachedVersions).toEqual(["v1"]);
  });

  it("does not cache a failed load", async () => {
    const source = await memorySourceFromFixtures(["v1"], (_version, path, content) =>
      path === "capabilities/slack.json" ? "{ not json" : content,
    );
    const loader = new RegistryLoader(source);

    await expect(loader.load("v1")).rejects.toBeInstanceOf(RegistryError);
    expect(loader.cachedVersions).toEqual([]);
    await expect(loader.load("v1")).rejects.toBeInstanceOf(RegistryError);
  });
});

describe("loadIndex", () => {
  it("reads index.json without touching the capability files", async () => {
    const source = await memorySourceFromFixtures([FIXTURE_REGISTRY_VERSION]);
    const loader = new RegistryLoader(source);

    const index = await loader.loadIndex(FIXTURE_REGISTRY_VERSION);

    expect(index.entries).toHaveLength(11);
    expect(source.reads).toEqual([`${FIXTURE_REGISTRY_VERSION}/${ARTIFACT_PATHS.index}`]);
  });

  it("serves the index from a cached full load", async () => {
    const source = await memorySourceFromFixtures([FIXTURE_REGISTRY_VERSION]);
    const loader = new RegistryLoader(source);

    await loader.load(FIXTURE_REGISTRY_VERSION);
    const reads = source.reads.length;
    await loader.loadIndex(FIXTURE_REGISTRY_VERSION);

    expect(source.reads).toHaveLength(reads);
  });

  it("errors on an unpublished version", async () => {
    const loader = new RegistryLoader(fixtureSource());
    await expect(loader.loadIndex(OTHER_VERSION)).rejects.toMatchObject({
      code: RegistryErrorCode.VERSION_NOT_FOUND,
    });
  });
});

describe("malformed artifacts", () => {
  it("rejects an artifact that is not valid JSON", async () => {
    const source = await memorySourceFromFixtures(["v1"], (_version, path, content) =>
      path === "index.json" ? "{" : content,
    );
    await expect(new RegistryLoader(source).load("v1")).rejects.toMatchObject({
      code: RegistryErrorCode.ARTIFACT_INVALID,
      artifact: "index.json",
    });
  });

  it("rejects an artifact that does not match its schema, listing every violation", async () => {
    const source = await memorySourceFromFixtures(["v1"], (_version, path, content) => {
      if (path !== "capabilities/openai.json") return content;
      const parsed = JSON.parse(content) as Record<string, unknown>;
      delete parsed["display_name"];
      delete parsed["categories"];
      return JSON.stringify(parsed);
    });

    const error = await new RegistryLoader(source)
      .load("v1")
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: RegistryErrorCode.ARTIFACT_INVALID,
      artifact: "capabilities/openai.json",
    });
    expect((error as { violations: unknown[] }).violations).toHaveLength(2);
  });

  it("reports an unreadable artifact separately from an invalid one", async () => {
    const source = new MemoryArtifactSource({
      "v1/capabilities/core.json": "{}",
    });
    // `hasVersion` passes on the prefix, then index.json is not there to read.
    await expect(new RegistryLoader(source).load("v1")).rejects.toMatchObject({
      code: RegistryErrorCode.ARTIFACT_UNREADABLE,
      artifact: "index.json",
    });
  });

  it("fails the load when the artifacts do not join", async () => {
    const source = await memorySourceFromFixtures(["v1"], (_version, path, content) => {
      if (path !== "bindings/n8n/slack.json") return content;
      const parsed = JSON.parse(content) as { bindings: Record<string, unknown> };
      parsed.bindings["slack.reaction.add"] = { node_type: "x", type_version: 1 };
      return JSON.stringify(parsed);
    });

    const error = await new RegistryLoader(source)
      .load("v1")
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(RegistryIntegrityError);
    expect((error as RegistryIntegrityError).issues.map((issue) => issue.code)).toEqual([
      "binding_without_capability",
    ]);
  });

  it("can be told to skip integrity checks, and then does", async () => {
    const source = await memorySourceFromFixtures(["v1"], (_version, path, content) => {
      if (path !== "bindings/n8n/slack.json") return content;
      const parsed = JSON.parse(content) as { bindings: Record<string, unknown> };
      parsed.bindings["slack.reaction.add"] = { node_type: "x", type_version: 1 };
      return JSON.stringify(parsed);
    });

    const registry = await new RegistryLoader(source, { checkIntegrity: false }).load("v1");
    expect(registry.bindings.get("n8n")?.has("slack.reaction.add")).toBe(true);
  });
});

describe("artifact sources", () => {
  it("reports a missing directory as empty rather than throwing", async () => {
    const source = new FileSystemArtifactSource("D:/no/such/registry/root");
    expect(await source.hasVersion("v1")).toBe(false);
    expect(await source.list("v1", "capabilities")).toEqual([]);
  });

  it("distinguishes files from directories, which is how targets are discovered", async () => {
    const source = fixtureSource();
    const top = await source.list(FIXTURE_REGISTRY_VERSION, "");
    expect(top).toContainEqual({ name: "index.json", kind: "file" });
    expect(top).toContainEqual({ name: "capabilities", kind: "directory" });

    const platforms = await source.list(FIXTURE_REGISTRY_VERSION, ARTIFACT_PATHS.bindings);
    expect(platforms).toEqual([{ name: "n8n", kind: "directory" }]);
  });

  it("in-memory and on-disk sources produce the same registry", async () => {
    const fromDisk = await new RegistryLoader(fixtureSource()).load(FIXTURE_REGISTRY_VERSION);
    const inMemory = await new RegistryLoader(
      await memorySourceFromFixtures([FIXTURE_REGISTRY_VERSION]),
    ).load(FIXTURE_REGISTRY_VERSION);
    expect(inMemory).toEqual(fromDisk);
  });
});
