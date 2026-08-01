/**
 * Prompt drift, caught where it belongs.
 *
 * The fixture set matches by digesting the request the passes build, so a
 * prompt edit changes the digest and replay keeps working. That is the right
 * trade for a fixture, and it means prompt drift is invisible there. This file
 * is the other half: it pins the instructions that are load-bearing, so
 * deleting one fails a test about prompts rather than nothing at all.
 *
 * What is pinned is deliberately not the whole text. A prompt that could not be
 * reworded without a test failing would be a prompt nobody improves. What is
 * pinned is the set of instructions that other parts of the system depend on
 * being there: the sentinel conventions the merge reverses, the honest-HTTP
 * rule that keeps `capability_unknown` meaningful, and the expression grammar
 * the validator enforces.
 */

import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { loadPrompt, promptPath, PROMPTS, PROMPT_NAMES, PROMPT_VERSION } from "./prompts.js";

describe("prompt files", () => {
  it("exists on disk for every declared prompt", () => {
    expect(PROMPT_NAMES.length).toBeGreaterThan(0);
    for (const name of PROMPT_NAMES) {
      expect(existsSync(promptPath(name)), name).toBe(true);
    }
  });

  it("loads non-empty text and caches it", () => {
    for (const name of PROMPT_NAMES) {
      const text = loadPrompt(name);
      expect(text.length).toBeGreaterThan(200);
      // Same string instance on the second call: read once per process.
      expect(loadPrompt(name)).toBe(text);
    }
  });
});

describe("the recorded version", () => {
  it("names every prompt and its revision", () => {
    // `metadata.prompt_version` is one string and a generation uses several
    // prompts. A single counter bumped by hand drifts the first time two are
    // edited in one change.
    expect(PROMPT_VERSION).toBe("pass_a@1+pass_b@1");
  });

  it("is derived from PROMPTS, so a bump cannot be forgotten", () => {
    for (const name of PROMPT_NAMES) {
      expect(PROMPT_VERSION).toContain(`${name}@${PROMPTS[name]}`);
    }
  });
});

/**
 * Whitespace collapsed to single spaces.
 *
 * The prompts are hard-wrapped at 80 columns, so an instruction routinely
 * spans a line break and a literal substring match would fail on where the
 * wrap happens to land. These tests are about what the prompt says, not how it
 * is laid out, and reflowing a paragraph should not fail one.
 */
function said(name: Parameters<typeof loadPrompt>[0]): string {
  return loadPrompt(name).replace(/\s+/g, " ");
}

describe("pass A instructions the rest of the system depends on", () => {
  const prompt = said("pass_a");

  it("forbids inventing a capability ID and names the honest alternative", () => {
    // Without this the model produces plausible-looking IDs instead of an
    // HTTP step, and `capability_unknown` stops meaning what it says.
    expect(prompt).toContain("Do not invent a capability ID");
    expect(prompt).toContain("http.request.send");
  });

  it("explains every sentinel the merge converts back to absence", () => {
    // Each of these is a line in the merge's conversion table. A model that
    // was never told about one omits the key instead, and the closed schema
    // rejects the whole response.
    for (const sentinel of [
      "`notes`: empty string",
      '`condition_operator`: "none"',
      "`retry_attempts`: 0",
      "`port`: empty string",
    ]) {
      expect(prompt).toContain(sentinel);
    }
  });

  it("asks for readable node ids, because expressions reference them by name", () => {
    expect(prompt).toContain("n_trigger");
    expect(prompt).toContain("A later step writes expressions that");
  });

  it("states the graph rules the validator will enforce", () => {
    for (const rule of [
      "Exactly one trigger",
      "reachable from the trigger",
      'outbound edge with port "error"',
      "finite max_iterations",
    ]) {
      expect(prompt).toContain(rule);
    }
  });
});

describe("pass B instructions the rest of the system depends on", () => {
  const prompt = said("pass_b");

  it("states the expression grammar the parser actually implements", () => {
    // Grammar v1 has field access and indexing and nothing else. A model that
    // writes arithmetic produces a document that fails stage 4 every time.
    expect(prompt).toContain("no arithmetic, no function calls");
    expect(prompt).toContain("{{ $vars.variable_id }}");
  });

  it("forbids referencing a step that has not run", () => {
    expect(prompt).toContain("You may only reference a node that runs BEFORE");
  });

  it("forbids writing a credential into a parameter", () => {
    // Rule 14 rejects the document outright, so this is the difference between
    // a workflow and a failed generation.
    expect(prompt).toContain("Never write a real credential");
  });

  it("explains the empty-string sentinel the schema's required list relies on", () => {
    expect(prompt).toContain("takes an empty string");
  });
});
