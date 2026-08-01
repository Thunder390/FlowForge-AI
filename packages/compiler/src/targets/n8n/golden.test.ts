/**
 * Golden-file tests.
 *
 * Each case in `test/golden/` holds an `input.ffir.json` and the
 * `expected.n8n.json` it must compile to. The test compiles and diffs. Any
 * intentional change to the output shows up as a reviewable diff on a file
 * somebody has to look at, which is the whole point: a compiler's bugs are
 * silent, and a workflow that imports cleanly and then does the wrong thing at
 * run time is the worst failure this product has. Determinism is what makes it
 * work, so there are no random ids and no timestamps anywhere in the output.
 *
 * Regenerate with `UPDATE_GOLDEN=1 pnpm test`. Read the diff before committing
 * it. A golden file updated without being read is worse than no golden file,
 * because it converts a failing test into a rubber stamp.
 *
 * The cases cover every one of the nine FFIR node kinds between them:
 *
 * | Case | Kinds |
 * | --- | --- |
 * | `onboarding` | trigger, transform, action, error_handler |
 * | `branch-if` | branch, two outputs |
 * | `branch-switch` | branch, three named cases |
 * | `merge` | merge |
 * | `loop` | loop |
 * | `ai-and-wait` | ai, wait |
 * | `http-request` | the escape hatch, and three of the five transforms |
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFixtureRegistry } from "@flowforge/registry/fixtures";
import { describe, expect, it } from "vitest";

import { compile } from "../../compile.js";
import { n8nTarget } from "./index.js";

const registry = await loadFixtureRegistry();
const goldenRoot = fileURLToPath(new URL("../../../test/golden/", import.meta.url));
const updating = process.env["UPDATE_GOLDEN"] === "1";

const cases = (await readdir(goldenRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/** Every node kind has to appear in at least one case, or the suite has a hole. */
const REQUIRED_KINDS = [
  "trigger",
  "action",
  "transform",
  "branch",
  "merge",
  "loop",
  "ai",
  "wait",
  "error_handler",
] as const;

describe("golden cases", () => {
  it("found some", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const name of cases) {
    it(name, async () => {
      const input = JSON.parse(
        await readFile(join(goldenRoot, name, "input.ffir.json"), "utf8"),
      ) as unknown;

      const result = compile(input, registry, n8nTarget);
      if (!result.ok) {
        throw new Error(
          `${name} did not compile: ${JSON.stringify(result.errors, null, 2)}`,
        );
      }

      const expectedPath = join(goldenRoot, name, "expected.n8n.json");
      if (updating) {
        await writeFile(expectedPath, result.value.content, "utf8");
        return;
      }

      const expected = await readFile(expectedPath, "utf8");
      expect(result.value.content).toBe(expected);
    });
  }
});

describe("coverage", () => {
  it("has a case for every FFIR node kind", async () => {
    const kinds = new Set<string>();

    for (const name of cases) {
      const doc = JSON.parse(
        await readFile(join(goldenRoot, name, "input.ffir.json"), "utf8"),
      ) as { nodes: { kind: string }[] };
      for (const node of doc.nodes) kinds.add(node.kind);
    }

    expect([...REQUIRED_KINDS].filter((kind) => !kinds.has(kind))).toEqual([]);
  });
});

describe("determinism", () => {
  for (const name of cases) {
    it(`${name} compiles to identical bytes twice`, async () => {
      const input = JSON.parse(
        await readFile(join(goldenRoot, name, "input.ffir.json"), "utf8"),
      ) as unknown;

      const first = compile(input, registry, n8nTarget);
      const second = compile(input, registry, n8nTarget);
      if (!first.ok || !second.ok) throw new Error(`${name} did not compile`);

      expect(first.value.content).toBe(second.value.content);
    });
  }
});
