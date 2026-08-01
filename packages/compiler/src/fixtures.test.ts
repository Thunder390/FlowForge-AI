/**
 * The fixtures have to be valid before anything written against them means
 * something. A document that fails validation would make every later assertion
 * a test of the validator wearing the compiler's clothes.
 */

import { validateWithoutRegistry } from "@flowforge/ffir";
import { onboardingExample } from "@flowforge/ffir/fixtures";
import { validateAgainstRegistry } from "@flowforge/registry";
import { loadFixtureRegistry } from "@flowforge/registry/fixtures";
import { describe, expect, it } from "vitest";

import {
  duplicateLabelDocument,
  loopDocument,
  parallelDocument,
} from "./__fixtures__/documents.js";
import { fakeTarget, FULL_CAPABILITIES, LINEAR_CAPABILITIES } from "./__fixtures__/index.js";

const registry = await loadFixtureRegistry();

describe("every fixture document passes all five validation stages", () => {
  const cases: [string, () => unknown][] = [
    ["the worked example", () => onboardingExample],
    ["the loop document", loopDocument],
    ["the parallel document", parallelDocument],
    ["the duplicate-label document", duplicateLabelDocument],
  ];

  for (const [name, build] of cases) {
    it(name, () => {
      const doc = build();
      const structural = validateWithoutRegistry(doc);
      expect(structural.errors, `${name}: stages 0, 1, 4`).toEqual([]);

      const semantic = validateAgainstRegistry(doc as never, registry);
      expect(semantic.errors, `${name}: stages 2, 3`).toEqual([]);
    });
  }
});

describe("the fake target", () => {
  it("declares everything supported by default", () => {
    expect(fakeTarget().capabilities).toEqual(FULL_CAPABILITIES);
  });

  it("takes a capability override without losing the rest", () => {
    expect(fakeTarget({ capabilities: { loops: false } }).capabilities).toEqual({
      ...FULL_CAPABILITIES,
      loops: false,
    });
  });

  it("offers Zapier's shape, which is the constrained one worth testing against", () => {
    expect(LINEAR_CAPABILITIES.branching).toBe("linear_only");
    expect(LINEAR_CAPABILITIES.loops).toBe(false);
    expect(LINEAR_CAPABILITIES.errorRouting).toBe(false);
  });
});
