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
    expect(Object.keys(ai).sort()).toEqual([
      "checkParameters",
      "checkRegistry",
      "validateAgainstRegistry",
    ]);
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

describe("the dependency rule", () => {
  it("does not depend on the compiler", async () => {
    // The structural expression of the architecture's central decision. With a
    // strict node linker an import the manifest does not declare fails to
    // resolve at build time rather than at review time, so the manifest is what
    // actually enforces this and the manifest is what this reads.
    const manifest = await import("../package.json", { with: { type: "json" } });
    const dependencies = Object.keys(manifest.default.dependencies);

    expect(dependencies).not.toContain("@flowforge/compiler");
    expect(dependencies).toEqual(["@flowforge/ffir", "@flowforge/registry"]);
  });
});
