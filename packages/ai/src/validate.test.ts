/**
 * The behaviour of stages 2 and 3 is tested in `registry`, beside the
 * implementation. What is tested here is the thing moving it could have broken:
 * that this package still presents them, and still presents the same functions
 * rather than lookalikes.
 *
 * Identity assertions rather than behavioural ones on purpose. A re-export that
 * has quietly become a wrapper is the failure this guards against, and only
 * reference equality catches it.
 */

import { onboardingExample } from "@flowforge/ffir/fixtures";
import * as registry from "@flowforge/registry";
import { loadFixtureRegistry } from "@flowforge/registry/fixtures";
import { describe, expect, it } from "vitest";

import * as ai from "./index.js";
import { checkParameters, checkRegistry, validateAgainstRegistry } from "./validate.js";

const fixtureRegistry = await loadFixtureRegistry();

describe("the AI layer's validation surface", () => {
  it("exports the three functions AI_SPEC's stage table assigns to it", () => {
    // Presence rather than an exact key list. Until M8 these three were the
    // whole package and pinning the list was a useful thing to say; now the
    // package has a provider layer and two passes, and a test that failed
    // every time it grew would be re-baselined without being read.
    for (const name of ["checkRegistry", "checkParameters", "validateAgainstRegistry"]) {
      expect(Object.keys(ai)).toContain(name);
    }
  });

  it("re-exports registry's implementations rather than wrapping them", () => {
    expect(checkRegistry).toBe(registry.checkRegistry);
    expect(checkParameters).toBe(registry.checkParameters);
    expect(validateAgainstRegistry).toBe(registry.validateAgainstRegistry);
  });

  it("reaches the same verdict through this package's entry point", () => {
    expect(ai.validateAgainstRegistry(onboardingExample, fixtureRegistry)).toEqual({
      ok: true,
      errors: [],
    });
  });
});
