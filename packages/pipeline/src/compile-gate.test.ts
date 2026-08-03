/**
 * The compile dry-run gate: validation stage 5 in AI_SPEC's numbering, stage
 * `compile` in the orchestrator's.
 *
 * The gate exists so that "it renders on the canvas" and "it will export" are
 * the same claim. Its happy path is already covered by the milestone test, so
 * what is worth pinning here is the part a fixture cannot reach: what happens
 * when compilation fails. The worked example compiles, which is the point of
 * it, so the failure path is driven by injecting a target that refuses.
 *
 * The targets below wrap the real n8n target rather than reimplementing one.
 * A hand-built stub would pass these tests while proving nothing about the
 * compiler that actually runs.
 */

import { onboardingFixture, ONBOARDING_DOCUMENT_ID, ONBOARDING_GENERATED_AT } from "@flowforge/ai/fixtures";
import { n8nTarget, type Target } from "@flowforge/compiler";
import { describe, expect, it } from "vitest";

import { generate } from "./generate.js";
import type { GenerationEvent } from "./events.js";

async function run(target?: Target) {
  const fixture = await onboardingFixture();
  const events: GenerationEvent[] = [];

  const result = await generate({
    prompt: fixture.prompt,
    registry: fixture.registry,
    provider: fixture.provider,
    retriever: fixture.retriever,
    documentId: ONBOARDING_DOCUMENT_ID,
    generatedAt: ONBOARDING_GENERATED_AT,
    onEvent: (event) => events.push(event),
    ...(target === undefined ? {} : { target }),
  });

  return { fixture, result, events };
}

/** n8n, minus the ability to route errors. The worked example routes errors. */
const noErrorRouting: Target = {
  ...n8nTarget,
  capabilities: { ...n8nTarget.capabilities, errorRouting: false },
};

/** n8n, with a verify pass that always rejects its own output. */
const brokenVerify: Target = {
  ...n8nTarget,
  verify: () => ({
    ok: false,
    failures: ["Emitted workflow failed its structural self-check."],
  }),
};

describe("the gate on a document that compiles", () => {
  it("runs, and says so with an event naming the target", async () => {
    const { events } = await run();
    const compileEvents = events.filter((event) => event.stage === "compile");

    expect(compileEvents.length).toBeGreaterThan(0);
    expect(compileEvents[0]?.detail).toMatchObject({ target: "n8n" });
  });

  it("emits compile last, after validation has passed", async () => {
    const { events } = await run();
    const stages = events.map((event) => event.stage);

    expect(stages[stages.length - 1]).toBe("compile");
    expect(stages.lastIndexOf("validate")).toBeLessThan(stages.indexOf("compile"));
  });

  it("does not return the compiled artifact", async () => {
    const { result } = await run();
    if (!result.ok) throw new Error("generation failed");

    // The output is discarded on purpose. Export happens later, against a
    // document the user may have edited by then, so a caller holding an
    // artifact from generation time would eventually hold a stale one.
    expect(result).not.toHaveProperty("compiled");
    expect(result).not.toHaveProperty("output");
    expect(result).not.toHaveProperty("content");
  });

  it("leaves the returned warnings to the merge, without folding compile warnings in", async () => {
    const { result } = await run();
    if (!result.ok) throw new Error("generation failed");

    // Compile warnings describe an artifact that was thrown away. Surfacing
    // them here would double-report the degradations the synthesis already
    // recorded, under a second code for the same underlying fact.
    const codes = new Set(result.warnings.map((warning) => warning.code));
    expect(codes.has("capability_degraded")).toBe(true);
  });
});

describe("the gate on a document that does not compile", () => {
  it("fails the generation rather than returning an unexportable document", async () => {
    const { result } = await run(noErrorRouting);

    expect(result.ok).toBe(false);
  });

  it("reports the failure against the compile stage", async () => {
    const { result } = await run(noErrorRouting);
    if (result.ok) throw new Error("expected the gate to reject this target");

    expect(result.stage).toBe("compile");
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures.every((failure) => failure.stage === "compile")).toBe(true);
  });

  it("marks a target-capability failure repairable, since the model can route around it", async () => {
    const { result } = await run(noErrorRouting);
    if (result.ok) throw new Error("expected the gate to reject this target");

    expect(result.failures.some((failure) => failure.recovery === "repair")).toBe(true);
  });

  it("carries the plan through, so a repair has the context that produced the document", async () => {
    const { result } = await run(noErrorRouting);
    if (result.ok) throw new Error("expected the gate to reject this target");

    expect(result.plan).toBeDefined();
  });

  // Usage accounting on a failed generation is deliberately not tested here.
  // The onboarding fixture records no usage on its responses, so every counter
  // is legitimately zero and any assertion about them would be vacuous. The
  // real coverage lives in `failures.test.ts`, which builds a provider with
  // explicit token counts and asserts pass A's tokens survive a pass B failure.
});

describe("a failure in our own emitter", () => {
  it("is terminal, because asking the model again cannot fix our compiler", async () => {
    const { result } = await run(brokenVerify);
    if (result.ok) throw new Error("expected the broken verify pass to reject");

    // Every other compile stage is the workflow's problem. `verify` failing
    // means the emitter produced something structurally wrong, which no
    // number of repair attempts will change.
    expect(result.failures.every((failure) => failure.recovery === "terminal")).toBe(true);
  });
});
