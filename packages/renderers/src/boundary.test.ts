/**
 * Renderers are siblings of the compiler, not targets of it.
 *
 * The distinction is real rather than organizational: a compiler target
 * produces something executable on another platform and must satisfy that
 * platform's semantics, while a renderer produces something a person reads.
 * The roadmap's dependency table gives this package `ffir` and `registry` only.
 *
 * The temptation this guards against is specific and will come up: `react-flow`
 * needs canvas positions, the compiler has a layout algorithm, and importing it
 * would be one line. Doing so would make the renderers depend on a platform
 * target for a value the pipeline already publishes through `metadata.layout`.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function sourceFile(name: string): string {
  return fileURLToPath(new URL(name, import.meta.url));
}

/** Comments stripped, so a guard fires on what the code does, not what it says. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const SOURCE_FILES = [
  "index.ts",
  "order.ts",
  "mermaid.ts",
  "setup-guide.ts",
  "integrations.ts",
  "react-flow.ts",
];

describe("the dependency rule", () => {
  it("does not depend on the compiler", async () => {
    const manifest = await import("../package.json", { with: { type: "json" } });
    expect(Object.keys(manifest.default.dependencies)).toEqual([
      "@flowforge/ffir",
      "@flowforge/registry",
    ]);
  });

  it("imports neither the compiler nor the AI layer in any source file", async () => {
    const banned = /(?:from|import|require)\s*\(?\s*["']@flowforge\/(compiler|ai)["']/;

    for (const name of SOURCE_FILES) {
      const source = code(await readFile(sourceFile(name), "utf8"));
      expect(banned.test(source), name).toBe(false);
    }
  });

  it("names no platform, because a renderer renders FFIR", async () => {
    // FFIR contains zero platform vocabulary and so do its renderers. A mermaid
    // diagram that said "Slack node" rather than the node's own label would be
    // describing the export instead of the workflow.
    for (const name of SOURCE_FILES) {
      const source = code(await readFile(sourceFile(name), "utf8"));
      expect(source.includes("n8n-nodes-base"), name).toBe(false);
    }
  });
});

describe("purity", () => {
  it("reaches for no clock, no randomness, and no filesystem", async () => {
    const banned = [
      /\bDate\s*\./,
      /\bnew\s+Date\b/,
      /\bMath\s*\.\s*random\b/,
      /\brandomUUID\b/,
      /\bprocess\s*\.\s*env\b/,
      /from\s+"node:fs/,
    ];

    for (const name of SOURCE_FILES) {
      const source = code(await readFile(sourceFile(name), "utf8"));
      for (const pattern of banned) {
        expect(pattern.test(source), `${name} matches ${pattern}`).toBe(false);
      }
    }
  });
});
