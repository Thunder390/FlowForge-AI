/**
 * Version-keyed artifact loading.
 *
 * A registry build is content-addressed, published under its version string,
 * and never modified after publication. Stored FFIR pins
 * `metadata.registry_version`, and if that version meant "whatever shipped in
 * the current deploy" then a registry bump would silently change how every
 * previously generated workflow recompiles: a user re-exports something they
 * built three months ago and gets different output, with no diff and no
 * explanation.
 *
 * So the loader is built around three rules.
 *
 * **Versions are addressed explicitly.** Loading a version that does not exist
 * is an error, never a silent fallback to current. `loadPinned` can fall back,
 * and it returns a warning saying so, because the failure mode this prevents is
 * silence rather than substitution.
 *
 * **Artifacts come from a source, not from the bundle.** Builds are published
 * to object storage under `registry/<version>/`, not baked into a deploy, which
 * is what lets one process serve several versions at once. `ArtifactSource` is
 * that seam; the filesystem implementation is what tests and local development
 * use.
 *
 * **A version is loaded once per process.** Registry data is large and
 * immutable, which makes it ideal for an LRU across versions. Concurrent
 * requests for the same version share one load rather than racing.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  RegistryArtifactError,
  RegistryError,
  RegistryErrorCode,
} from "./errors.js";
import { checkIntegrity, type IntegrityIssue } from "./integrity.js";
import {
  checkBindingFile,
  checkCapabilityFile,
  checkRegistryIndex,
} from "./schema.js";
import { compareStrings } from "./types.js";
import type {
  Binding,
  BindingFile,
  Capability,
  CapabilityFile,
  IntegrationEntry,
  Registry,
  RegistryIndex,
} from "./types.js";

/** Where each artifact kind lives inside a version. */
export const ARTIFACT_PATHS = {
  capabilities: "capabilities",
  bindings: "bindings",
  index: "index.json",
} as const;

const JSON_SUFFIX = ".json";

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export interface ArtifactEntry {
  name: string;
  kind: "file" | "directory";
}

/**
 * Where published artifacts are read from.
 *
 * Deliberately small. Object storage, a filesystem, and a test fixture can all
 * satisfy it, and none of the loader's caching or joining logic changes when the
 * source does. Paths are POSIX-style and relative to the version directory.
 */
export interface ArtifactSource {
  /** Identifies the source in error messages. */
  readonly id: string;
  hasVersion(version: string): Promise<boolean>;
  read(version: string, path: string): Promise<string>;
  /** Non-recursive. A directory that does not exist lists as empty. */
  list(version: string, directory: string): Promise<ArtifactEntry[]>;
}

/** Reads a build laid out on disk, one directory per version. */
export class FileSystemArtifactSource implements ArtifactSource {
  readonly id: string;
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
    this.id = `file:${root}`;
  }

  async hasVersion(version: string): Promise<boolean> {
    try {
      const info = await stat(join(this.#root, version));
      return info.isDirectory();
    } catch {
      return false;
    }
  }

  async read(version: string, path: string): Promise<string> {
    return readFile(join(this.#root, version, ...path.split("/")), "utf8");
  }

  async list(version: string, directory: string): Promise<ArtifactEntry[]> {
    let entries;
    try {
      entries = await readdir(join(this.#root, version, ...directory.split("/")), {
        withFileTypes: true,
      });
    } catch {
      return [];
    }
    return entries.map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? "directory" : "file",
    }));
  }
}

/**
 * Serves a build from an in-memory path-to-content map.
 *
 * Keys are `<version>/<path>`. Exists so a test can construct a deliberately
 * broken registry without writing one to disk, which is the only practical way
 * to cover the failure branches: the shipped fixtures are meant to be correct.
 */
export class MemoryArtifactSource implements ArtifactSource {
  readonly id = "memory";
  readonly #files: Map<string, string>;
  /** Counts reads so a test can prove the cache and the index path do less work. */
  readonly reads: string[] = [];

  constructor(files: Readonly<Record<string, string>>) {
    this.#files = new Map(Object.entries(files));
  }

  async hasVersion(version: string): Promise<boolean> {
    const prefix = `${version}/`;
    for (const key of this.#files.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  async read(version: string, path: string): Promise<string> {
    const key = `${version}/${path}`;
    this.reads.push(key);
    const content = this.#files.get(key);
    if (content === undefined) {
      throw new Error(`No such artifact: ${key}`);
    }
    return content;
  }

  async list(version: string, directory: string): Promise<ArtifactEntry[]> {
    const prefix = directory === "" ? `${version}/` : `${version}/${directory}/`;
    const seen = new Map<string, ArtifactEntry>();
    for (const key of this.#files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const remainder = key.slice(prefix.length);
      const slash = remainder.indexOf("/");
      const name = slash === -1 ? remainder : remainder.slice(0, slash);
      if (name.length === 0) continue;
      seen.set(name, { name, kind: slash === -1 ? "file" : "directory" });
    }
    return [...seen.values()];
  }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export interface LoaderOptions {
  /**
   * How many versions to hold in memory. Default 3: the current default, the
   * one being rolled out, and whatever an old stored workflow just asked for.
   */
  maxCachedVersions?: number;
  /**
   * Run whole-build integrity checks on load. Default true.
   *
   * Off is for a caller that has already gated the artifacts at publish time
   * and is loading them on a hot path. It is not a way to load a registry known
   * to be broken.
   */
  checkIntegrity?: boolean;
}

export interface RegistryWarning {
  code: "registry_version_unavailable";
  message: string;
  requested: string;
  used: string;
}

export interface PinnedLoad {
  registry: Registry;
  warnings: RegistryWarning[];
}

/** Thrown when the artifacts are well-formed individually but do not join. */
export class RegistryIntegrityError extends RegistryError {
  readonly issues: readonly IntegrityIssue[];

  constructor(version: string, issues: readonly IntegrityIssue[]) {
    super(
      RegistryErrorCode.INTEGRITY_FAILED,
      version,
      `Registry ${version} failed ${issues.length} integrity check${issues.length === 1 ? "" : "s"}:\n` +
        issues.map((issue) => `  [${issue.code}] ${issue.artifact}: ${issue.message}`).join("\n"),
    );
    this.name = "RegistryIntegrityError";
    this.issues = issues;
  }
}

export class RegistryLoader {
  readonly #source: ArtifactSource;
  readonly #maxCachedVersions: number;
  readonly #checkIntegrity: boolean;
  /** Insertion-ordered, so the first key is the least recently used. */
  readonly #cache = new Map<string, Registry>();
  readonly #inFlight = new Map<string, Promise<Registry>>();

  constructor(source: ArtifactSource, options: LoaderOptions = {}) {
    this.#source = source;
    this.#maxCachedVersions = Math.max(1, options.maxCachedVersions ?? 3);
    this.#checkIntegrity = options.checkIntegrity ?? true;
  }

  /** Versions currently held, least recently used first. Exposed for tests and metrics. */
  get cachedVersions(): string[] {
    return [...this.#cache.keys()];
  }

  /**
   * Loads one version, or returns the cached copy.
   *
   * Two callers asking for the same uncached version share a single load: the
   * second awaits the first rather than reading every artifact again.
   */
  async load(version: string): Promise<Registry> {
    const cached = this.#cache.get(version);
    if (cached !== undefined) {
      // Re-insert to mark it most recently used.
      this.#cache.delete(version);
      this.#cache.set(version, cached);
      return cached;
    }

    const pending = this.#inFlight.get(version);
    if (pending !== undefined) return pending;

    const load = this.#read(version).finally(() => {
      this.#inFlight.delete(version);
    });
    this.#inFlight.set(version, load);

    const registry = await load;
    this.#remember(version, registry);
    return registry;
  }

  /**
   * Loads `index.json` on its own.
   *
   * Pass A needs to know what exists, not what anything takes, and the whole
   * point of publishing the index as a separate artifact is that answering that
   * question does not mean reading every capability file.
   */
  async loadIndex(version: string): Promise<RegistryIndex> {
    const cached = this.#cache.get(version);
    if (cached !== undefined) return cached.index;

    await this.#requireVersion(version);
    return this.#readIndex(version);
  }

  /**
   * Resolution order for a compile: the document's pinned version, then the
   * current default if that pin is unavailable, with a warning attached.
   *
   * The warning is the load-bearing part. Falling back is acceptable; falling
   * back quietly is what turns "this workflow compiles differently now" into an
   * unreproducible support ticket.
   */
  async loadPinned(request: {
    pinned?: string | undefined;
    fallback?: string | undefined;
  }): Promise<PinnedLoad> {
    const { pinned, fallback } = request;

    if (pinned !== undefined && (await this.#source.hasVersion(pinned))) {
      return { registry: await this.load(pinned), warnings: [] };
    }

    if (fallback === undefined) {
      throw new RegistryError(
        RegistryErrorCode.VERSION_NOT_FOUND,
        pinned ?? "(unspecified)",
        pinned === undefined
          ? `No registry version was requested and no fallback was configured.`
          : `Registry version "${pinned}" is not published in ${this.#source.id}, and no fallback was configured.`,
      );
    }

    const registry = await this.load(fallback);
    if (pinned === undefined) return { registry, warnings: [] };

    return {
      registry,
      warnings: [
        {
          code: "registry_version_unavailable",
          message: `This workflow pins registry version "${pinned}", which is no longer published. It was compiled against "${fallback}" instead, so the output may differ from the original export.`,
          requested: pinned,
          used: fallback,
        },
      ],
    };
  }

  // -------------------------------------------------------------------------

  async #read(version: string): Promise<Registry> {
    await this.#requireVersion(version);

    const index = await this.#readIndex(version);
    const capabilityFiles = await this.#readCapabilityFiles(version);
    const bindingFiles = await this.#readBindingFiles(version);

    if (this.#checkIntegrity) {
      const issues = checkIntegrity({ version, capabilityFiles, bindingFiles, index });
      if (issues.length > 0) throw new RegistryIntegrityError(version, issues);
    }

    return build(version, capabilityFiles, bindingFiles, index);
  }

  async #requireVersion(version: string): Promise<void> {
    if (await this.#source.hasVersion(version)) return;
    throw new RegistryError(
      RegistryErrorCode.VERSION_NOT_FOUND,
      version,
      `Registry version "${version}" is not published in ${this.#source.id}. A missing version is an error rather than a fallback to current, because a workflow that pins a version and silently compiles against another is worse than one that fails to compile.`,
    );
  }

  async #readIndex(version: string): Promise<RegistryIndex> {
    const raw = await this.#readArtifact(version, ARTIFACT_PATHS.index);
    const result = checkRegistryIndex(raw);
    if (!result.ok || result.value === undefined) {
      throw new RegistryArtifactError(version, ARTIFACT_PATHS.index, result.violations);
    }
    return result.value;
  }

  async #readCapabilityFiles(version: string): Promise<CapabilityFile[]> {
    const names = await this.#listJson(version, ARTIFACT_PATHS.capabilities);
    const files: CapabilityFile[] = [];

    for (const name of names) {
      const path = `${ARTIFACT_PATHS.capabilities}/${name}`;
      const result = checkCapabilityFile(await this.#readArtifact(version, path));
      if (!result.ok || result.value === undefined) {
        throw new RegistryArtifactError(version, path, result.violations);
      }
      files.push(result.value);
    }

    return files;
  }

  async #readBindingFiles(version: string): Promise<Map<string, BindingFile[]>> {
    const platforms = (await this.#source.list(version, ARTIFACT_PATHS.bindings))
      .filter((entry) => entry.kind === "directory")
      .map((entry) => entry.name)
      .sort(compareStrings);

    const byPlatform = new Map<string, BindingFile[]>();

    for (const platform of platforms) {
      const directory = `${ARTIFACT_PATHS.bindings}/${platform}`;
      const files: BindingFile[] = [];

      for (const name of await this.#listJson(version, directory)) {
        const path = `${directory}/${name}`;
        const result = checkBindingFile(await this.#readArtifact(version, path));
        if (!result.ok || result.value === undefined) {
          throw new RegistryArtifactError(version, path, result.violations);
        }
        files.push(result.value);
      }

      byPlatform.set(platform, files);
    }

    return byPlatform;
  }

  /** Sorted, so the order artifacts are read in does not depend on the filesystem. */
  async #listJson(version: string, directory: string): Promise<string[]> {
    return (await this.#source.list(version, directory))
      .filter((entry) => entry.kind === "file" && entry.name.endsWith(JSON_SUFFIX))
      .map((entry) => entry.name)
      .sort(compareStrings);
  }

  async #readArtifact(version: string, path: string): Promise<unknown> {
    let text: string;
    try {
      text = await this.#source.read(version, path);
    } catch (cause) {
      throw new RegistryError(
        RegistryErrorCode.ARTIFACT_UNREADABLE,
        version,
        `Could not read ${path} from ${this.#source.id} at version ${version}.`,
        { artifact: path, cause },
      );
    }

    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new RegistryError(
        RegistryErrorCode.ARTIFACT_INVALID,
        version,
        `Artifact ${path} in ${version} is not valid JSON.`,
        { artifact: path, cause },
      );
    }
  }

  #remember(version: string, registry: Registry): void {
    this.#cache.delete(version);
    this.#cache.set(version, registry);
    while (this.#cache.size > this.#maxCachedVersions) {
      const oldest = this.#cache.keys().next();
      if (oldest.done === true) break;
      this.#cache.delete(oldest.value);
    }
  }
}

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

/**
 * Joins the artifacts into the in-memory model.
 *
 * Everything is sorted on the way in, so iterating a `Registry` produces the
 * same order on every machine and in every process. That is what makes a
 * downstream golden file meaningful.
 */
function build(
  version: string,
  capabilityFiles: readonly CapabilityFile[],
  bindingFiles: ReadonlyMap<string, readonly BindingFile[]>,
  index: RegistryIndex,
): Registry {
  const integrations = new Map<string, IntegrationEntry>();
  const capabilities = new Map<string, Capability>();

  const sortedFiles = [...capabilityFiles].sort((a, b) =>
    compareStrings(a.integration, b.integration),
  );

  for (const file of sortedFiles) {
    const sorted = [...file.capabilities].sort((a, b) => compareStrings(a.id, b.id));
    integrations.set(file.integration, {
      integration: file.integration,
      display_name: file.display_name,
      description: file.description,
      categories: [...file.categories],
      aliases: [...file.aliases],
      ...(file.docs_url === undefined ? {} : { docs_url: file.docs_url }),
      auth: [...file.auth],
      capabilities: sorted,
      source: file.source,
    });
  }

  const everyCapability = sortedFiles
    .flatMap((file) => file.capabilities)
    .sort((a, b) => compareStrings(a.id, b.id));
  for (const capability of everyCapability) {
    capabilities.set(capability.id, capability);
  }

  const bindings = new Map<string, ReadonlyMap<string, Binding | null>>();
  for (const platform of [...bindingFiles.keys()].sort(compareStrings)) {
    const merged = new Map<string, Binding | null>();
    const files = bindingFiles.get(platform) ?? [];
    const pairs = files
      .flatMap((file) => Object.entries(file.bindings))
      .sort(([a], [b]) => compareStrings(a, b));
    for (const [capabilityId, binding] of pairs) {
      merged.set(capabilityId, binding);
    }
    bindings.set(platform, merged);
  }

  return Object.freeze({
    version,
    integrations,
    capabilities,
    bindings,
    targets: [...bindings.keys()],
    index,
  });
}

