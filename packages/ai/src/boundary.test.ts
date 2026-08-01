/**
 * `packages/ai` must not import `packages/compiler`.
 *
 * This is the most important rule in PROJECT_STRUCTURE, and it is the
 * structural expression of the architecture's central decision: the AI layer
 * produces FFIR and knows nothing about any target platform. The moment this
 * package can import the compiler, someone reaches for a platform detail from
 * inside a prompt, and the claim that adding Make.com requires no AI change
 * becomes false.
 *
 * Three mechanisms are supposed to enforce it. The manifest is the one that
 * actually works, because a strict node linker makes an undeclared import fail
 * to resolve at build time. ESLint `no-restricted-imports` and the CI
 * dependency check catch it earlier and explain why, and neither exists yet:
 * there is no lint infrastructure in the workspace. This file is the interim
 * standing in for both, and it reads the same two things they would.
 */

import { readdir, readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SOURCE_ROOT = fileURLToPath(new URL(".", import.meta.url));

/**
 * Every source file in the package, tests and fixtures included, except this
 * one.
 *
 * The exclusion is not a convenience: this file necessarily contains the exact
 * strings it is searching for, so scanning itself would fail the guard by
 * quoting it. Everything else in the package is fair game, which is the point
 * of walking the directory rather than keeping a hand-maintained list that a
 * new file can quietly miss.
 */
async function sourceFiles(): Promise<string[]> {
  // Resolved on both sides: `parentPath` carries the platform separator and a
  // trailing one, so a string comparison against `import.meta.url`'s path
  // silently never matches on Windows and the exclusion does nothing.
  const self = resolvePath(fileURLToPath(import.meta.url));
  const entries = await readdir(SOURCE_ROOT, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => resolvePath(entry.parentPath, entry.name))
    .filter((path) => path !== self);
}

/** Comments stripped, so a guard fires on what the code does, not what it says. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the dependency rule", () => {
  it("does not declare the compiler, or any target, as a dependency", async () => {
    const manifest = await import("../package.json", { with: { type: "json" } });
    const dependencies = Object.keys(manifest.default.dependencies);

    expect(dependencies).not.toContain("@flowforge/compiler");
    expect(dependencies).not.toContain("@flowforge/pipeline");
    // Only two workspace packages, and they are the two the diagram allows.
    expect(dependencies.filter((name) => name.startsWith("@flowforge/"))).toEqual([
      "@flowforge/ffir",
      "@flowforge/registry",
    ]);
  });

  it("imports the compiler in no source file", async () => {
    const banned = /(?:from|import|require)\s*\(?\s*["']@flowforge\/(compiler|pipeline)["']/;

    for (const file of await sourceFiles()) {
      const source = code(await readFile(file, "utf8"));
      expect(banned.test(source), file).toBe(false);
    }
  });

  it("names no platform, because a prompt that did would not be portable", async () => {
    // The concrete temptation: a prompt saying "this becomes an n8n Slack
    // node" would improve one target's output and silently make the layer
    // platform-specific. FFIR contains zero platform vocabulary and so does
    // everything that produces it.
    for (const file of await sourceFiles()) {
      const source = code(await readFile(file, "utf8"));
      expect(source.includes("n8n-nodes-base"), file).toBe(false);
    }
  });

  it("keeps platform vocabulary out of the prompts as well", async () => {
    // The prompts are not TypeScript, so the source scan above does not see
    // them, and they are exactly where a platform detail would be most
    // tempting and most invisible.
    const promptRoot = fileURLToPath(new URL("../prompts/", import.meta.url));
    const entries = await readdir(promptRoot, { recursive: true, withFileTypes: true });

    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);

    for (const entry of files) {
      const text = await readFile(`${entry.parentPath}/${entry.name}`, "utf8");
      for (const platform of ["n8n", "make.com", "zapier"]) {
        expect(text.toLowerCase().includes(platform), entry.name).toBe(false);
      }
    }
  });
});
