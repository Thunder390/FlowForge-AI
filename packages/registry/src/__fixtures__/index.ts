/**
 * The hand-written M4 registry build, and helpers for loading it.
 *
 * Six integrations covering the worked example from WORKFLOW_SCHEMA.md, plus
 * the two reserved namespaces every registry must carry. They are hand-written
 * because the generator is deliberately late: it is only worth building once
 * the format has been proven by real use, and everything from validation stages
 * 2 and 3 through the n8n compiler needs a registry before then. M20 must
 * reproduce these files from `n8n-nodes-base` plus the overlay.
 *
 * Exported from the package under the `./fixtures` subpath rather than from the
 * main entry, so downstream packages can test against a real registry without
 * the fixtures becoming part of the public surface.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FileSystemArtifactSource, MemoryArtifactSource, RegistryLoader } from "../load.js";
import type { Registry } from "../types.js";

/** The version these artifacts are published under, matching the worked example's pin. */
export const FIXTURE_REGISTRY_VERSION = "n8n@1.62.0+overlay.3";

/**
 * The six integrations, pinned.
 *
 * A literal list so that quietly dropping one fails a test rather than
 * shrinking the coverage every later milestone is written against.
 */
export const FIXTURE_INTEGRATIONS = [
  "bamboohr",
  "core",
  "google_workspace",
  "http",
  "openai",
  "slack",
] as const;

/** Sibling of `build/`, because M20's generator has to diff its output against it. */
export function fixtureArtifactRoot(): string {
  return fileURLToPath(new URL("../../fixtures/", import.meta.url));
}

export function fixtureSource(): FileSystemArtifactSource {
  return new FileSystemArtifactSource(fixtureArtifactRoot());
}

let cached: Promise<Registry> | undefined;

/** The loaded fixture registry, shared across callers the way a worker shares one. */
export async function loadFixtureRegistry(): Promise<Registry> {
  cached ??= new RegistryLoader(fixtureSource()).load(FIXTURE_REGISTRY_VERSION);
  return cached;
}

/** Every fixture artifact as a path-to-content map, paths relative to the version. */
export async function readFixtureArtifacts(): Promise<Map<string, string>> {
  const root = join(fixtureArtifactRoot(), FIXTURE_REGISTRY_VERSION);
  const names = await readdir(root, { recursive: true, withFileTypes: true });
  const artifacts = new Map<string, string>();

  for (const entry of names) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const absolute = join(entry.parentPath, entry.name);
    const relative = absolute.slice(root.length + 1).split(/[\\/]/).join("/");
    artifacts.set(relative, await readFile(absolute, "utf8"));
  }

  return artifacts;
}

/**
 * Mirrors the fixture build under one or more version names, in memory.
 *
 * Lets a test exercise multi-version behaviour, and corrupt a single artifact,
 * without a second hand-written registry on disk. `index.json` carries its own
 * version string, so mirroring rewrites it: an index that disagrees with the
 * version it was published under is itself an integrity failure.
 */
export async function memorySourceFromFixtures(
  versions: readonly string[] = [FIXTURE_REGISTRY_VERSION],
  mutate?: (version: string, path: string, content: string) => string | undefined,
): Promise<MemoryArtifactSource> {
  const artifacts = await readFixtureArtifacts();
  const files: Record<string, string> = {};

  for (const version of versions) {
    for (const [path, original] of artifacts) {
      let content = original;
      if (path === "index.json") {
        const parsed = JSON.parse(content) as { version: string };
        parsed.version = version;
        content = JSON.stringify(parsed, null, 2);
      }
      const replaced = mutate?.(version, path, content);
      if (replaced === undefined) {
        files[`${version}/${path}`] = content;
        continue;
      }
      files[`${version}/${path}`] = replaced;
    }
  }

  return new MemoryArtifactSource(files);
}
