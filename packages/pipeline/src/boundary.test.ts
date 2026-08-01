/**
 * The workspace dependency graph, read from the manifests.
 *
 * PROJECT_STRUCTURE draws this graph and calls it the most important thing in
 * the document. A rule in a document is a suggestion, so this reads every
 * package's manifest and asserts the real graph matches the drawn one:
 *
 * ```
 *                     ffir          (depends on nothing)
 *                    ╱   ╲
 *            registry     renderers
 *              │  ╲          │
 *              │   ╲         │
 *             ai    compiler │
 *              ╲       │    ╱
 *               ╲      │   ╱
 *                pipeline          (imports all of the above)
 * ```
 *
 * This is the check review checkpoint 1 asks for, minus the parts that need
 * infrastructure the workspace does not have: ESLint `no-restricted-imports`
 * needs a lint setup, and a CI check needs CI. Both catch the same fault
 * earlier and explain it better; neither catches anything this does not.
 */

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const PACKAGES_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const WORKSPACE_PREFIX = "@flowforge/";

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * What each package is allowed to depend on at runtime.
 *
 * An allowance rather than an exact list, because a package may legitimately
 * not need everything it is permitted: `pipeline` has no use for `renderers`
 * until M14 builds the results view, and adding the dependency now to satisfy a
 * test would be adding an unused dependency to satisfy a test.
 */
const ALLOWED: Record<string, readonly string[]> = {
  "@flowforge/config": [],
  "@flowforge/ffir": [],
  "@flowforge/registry": ["@flowforge/ffir"],
  "@flowforge/renderers": ["@flowforge/ffir", "@flowforge/registry"],
  "@flowforge/compiler": ["@flowforge/ffir", "@flowforge/registry"],
  "@flowforge/ai": ["@flowforge/ffir", "@flowforge/registry"],
  "@flowforge/pipeline": [
    "@flowforge/ffir",
    "@flowforge/registry",
    "@flowforge/ai",
    "@flowforge/compiler",
    "@flowforge/renderers",
  ],
};

async function manifests(): Promise<Manifest[]> {
  const entries = await readdir(PACKAGES_ROOT, { withFileTypes: true });
  const found: Manifest[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const text = await readFile(`${PACKAGES_ROOT}${entry.name}/package.json`, "utf8").catch(
      () => undefined,
    );
    if (text !== undefined) found.push(JSON.parse(text) as Manifest);
  }
  return found;
}

function workspaceDeps(manifest: Manifest): string[] {
  return Object.keys(manifest.dependencies ?? {})
    .filter((name) => name.startsWith(WORKSPACE_PREFIX))
    .sort();
}

describe("the workspace dependency graph", () => {
  it("finds every package the diagram names", async () => {
    // A package missing from `ALLOWED` would otherwise pass every check below
    // by not being looked at.
    const names = (await manifests()).map((manifest) => manifest.name).sort();
    expect(names).toEqual(Object.keys(ALLOWED).sort());
  });

  it("gives no package a dependency the diagram does not allow", async () => {
    for (const manifest of await manifests()) {
      const allowed = ALLOWED[manifest.name] ?? [];
      for (const dependency of workspaceDeps(manifest)) {
        expect(allowed, `${manifest.name} -> ${dependency}`).toContain(dependency);
      }
    }
  });

  it("keeps ffir depending on nothing in the workspace", async () => {
    // Everything else is downstream of it, so a dependency here would make the
    // graph cyclic no matter what else is true.
    const ffir = (await manifests()).find((manifest) => manifest.name === "@flowforge/ffir");
    expect(workspaceDeps(ffir!)).toEqual([]);
  });

  it("keeps the AI layer and the compiler as siblings", async () => {
    // The rule the whole architecture rests on. Neither may import the other,
    // in either direction: a compiler that could reach the AI layer would be
    // just as broken, because a target could then influence generation.
    const all = await manifests();
    const ai = all.find((manifest) => manifest.name === "@flowforge/ai");
    const compiler = all.find((manifest) => manifest.name === "@flowforge/compiler");

    expect(workspaceDeps(ai!)).not.toContain("@flowforge/compiler");
    expect(workspaceDeps(compiler!)).not.toContain("@flowforge/ai");
  });

  it("makes the orchestrator the only package that depends on both", async () => {
    // This is why `packages/pipeline` exists. If a second package ever
    // qualifies, the import rule has stopped being enforceable.
    const both = (await manifests())
      .filter((manifest) => {
        const deps = workspaceDeps(manifest);
        return deps.includes("@flowforge/ai") && deps.includes("@flowforge/compiler");
      })
      .map((manifest) => manifest.name);

    expect(both).toEqual(["@flowforge/pipeline"]);
  });

  it("has no cycles", async () => {
    const all = await manifests();
    const graph = new Map(all.map((manifest) => [manifest.name, workspaceDeps(manifest)]));

    const state = new Map<string, "visiting" | "done">();
    const walk = (name: string, trail: string[]): void => {
      if (state.get(name) === "done") return;
      if (state.get(name) === "visiting") {
        throw new Error(`dependency cycle: ${[...trail, name].join(" -> ")}`);
      }
      state.set(name, "visiting");
      for (const next of graph.get(name) ?? []) walk(next, [...trail, name]);
      state.set(name, "done");
    };

    expect(() => {
      for (const name of graph.keys()) walk(name, []);
    }).not.toThrow();
  });

  it("keeps n8n-nodes-base out of every runtime manifest", async () => {
    // `tools/registry-gen` will take it as a devDependency in M20, and it must
    // appear nowhere else, which is what keeps it out of the runtime bundle.
    for (const manifest of await manifests()) {
      expect(Object.keys(manifest.dependencies ?? {}), manifest.name).not.toContain(
        "n8n-nodes-base",
      );
    }
  });
});

describe("the orchestrator's own imports", () => {
  it("actually imports both sides, so the reason it exists is real", async () => {
    // A pipeline that only imported the AI layer would be an empty seam: the
    // rule would be unenforced and nothing would notice.
    const root = fileURLToPath(new URL(".", import.meta.url));
    const entries = await readdir(root, { recursive: true, withFileTypes: true });

    let sources = "";
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      sources += await readFile(`${entry.parentPath}/${entry.name}`, "utf8");
    }

    expect(sources).toContain('from "@flowforge/ai"');
    expect(sources).toContain('from "@flowforge/compiler"');
  });
});
