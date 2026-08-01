/**
 * Stage 1 owns no rules of its own. What it owns is the claim that *every*
 * stage runs, so these tests break one document per stage and assert the
 * compiler refuses it. The stage that is easiest to forget is the one that
 * lives in another package, which is exactly why stage 2 and stage 3 have cases
 * here as well as in `registry`.
 */

import { ErrorCode } from "@flowforge/ffir";
import { cloneOnboarding, onboardingExample } from "@flowforge/ffir/fixtures";
import { loadFixtureRegistry } from "@flowforge/registry/fixtures";
import { describe, expect, it } from "vitest";

import { nodeOf } from "./__fixtures__/documents.js";
import { nodeIdOf } from "./errors.js";
import { validateForCompile } from "./validate.js";

const registry = await loadFixtureRegistry();

function codes(result: { ok: boolean; errors?: readonly { code: string }[] }): string[] {
  return (result.errors ?? []).map((error) => error.code);
}

describe("a valid document", () => {
  it("passes", () => {
    const result = validateForCompile(onboardingExample, registry);
    expect(result.ok).toBe(true);
  });

  it("does not mutate what it was handed", () => {
    const before = structuredClone(onboardingExample);
    validateForCompile(onboardingExample, registry);
    expect(onboardingExample).toEqual(before);
  });
});

describe("every stage runs", () => {
  it("stage 0: rejects a document breaching a limit", () => {
    const doc = cloneOnboarding();
    doc.nodes = Array.from({ length: 300 }, (_, index) => ({
      ...nodeOf(cloneOnboarding(), "n_slack_welcome"),
      id: `n_${index}`,
    }));

    const result = validateForCompile(doc, registry);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain(ErrorCode.DOCUMENT_LIMIT_EXCEEDED);
  });

  it("stage 1: rejects a document that is not FFIR at all", () => {
    const result = validateForCompile({ hello: "world" }, registry);
    expect(result.ok).toBe(false);
    expect(codes(result).length).toBeGreaterThan(0);
  });

  it("stage 4: rejects a graph rule violation", () => {
    const doc = cloneOnboarding();
    doc.edges.push({ id: "e_cycle", from: "n_slack_welcome", to: "n_build_email" });

    const result = validateForCompile(doc, registry);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain(ErrorCode.GRAPH_CYCLE);
  });

  it("stage 2: rejects a capability the registry does not have", () => {
    // The stage that lives in another package. A compiler that composed only
    // `ffir`'s stages would pass this document straight through to resolve.
    const doc = cloneOnboarding();
    nodeOf(doc, "n_slack_welcome").capability = "slack.message.broadcast";

    const result = validateForCompile(doc, registry);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain(ErrorCode.UNKNOWN_CAPABILITY);
  });

  it("stage 3: rejects a parameter name the capability does not declare", () => {
    const doc = cloneOnboarding();
    nodeOf(doc, "n_slack_welcome").parameters = {
      channel: "#general",
      text: "hi",
      icon_emoji: ":tada:",
    };

    const result = validateForCompile(doc, registry);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain(ErrorCode.UNKNOWN_PARAMETER_NAME);
  });

  it("stage 3: rejects a parameter value its registry rule forbids", () => {
    const doc = cloneOnboarding();
    nodeOf(doc, "n_slack_welcome").parameters = { channel: "general", text: "hi" };

    const result = validateForCompile(doc, registry);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain(ErrorCode.INVALID_PARAMETER_VALUE);
  });
});

describe("the shape of a failure", () => {
  it("stamps every error with the validate stage", () => {
    const doc = cloneOnboarding();
    nodeOf(doc, "n_slack_welcome").capability = "slack.message.broadcast";

    const result = validateForCompile(doc, registry);
    if (result.ok) throw new Error("expected a failure");
    for (const error of result.errors) expect(error.stage).toBe("validate");
  });

  it("forwards ffir's error code rather than remapping it", () => {
    // Every consumer of a compile failure, the repair prompt above all, keys
    // off ffir's vocabulary. A translation table here would need keeping in
    // step with a frozen enum.
    const doc = cloneOnboarding();
    nodeOf(doc, "n_slack_welcome").parameters = { channel: "general", text: "hi" };

    const result = validateForCompile(doc, registry);
    if (result.ok) throw new Error("expected a failure");
    expect(result.errors[0]?.code).toBe(ErrorCode.INVALID_PARAMETER_VALUE);
  });

  it("lifts the node id out of the details bag so the canvas can highlight it", () => {
    const doc = cloneOnboarding();
    nodeOf(doc, "n_slack_welcome").parameters = { channel: "general", text: "hi" };

    const result = validateForCompile(doc, registry);
    if (result.ok) throw new Error("expected a failure");
    expect(result.errors[0]).toMatchObject({
      stage: "validate",
      nodeId: "n_slack_welcome",
      path: "/nodes/3/parameters/channel",
    });
  });

  it("leaves nodeId absent for a failure that is about the document", () => {
    const result = validateForCompile({ hello: "world" }, registry);
    if (result.ok) throw new Error("expected a failure");
    expect(result.errors.every((error) => nodeIdOf(error) === undefined)).toBe(true);
  });

  it("reports every failure at once, so one repair fixes them all", () => {
    const doc = cloneOnboarding();
    nodeOf(doc, "n_slack_welcome").parameters = { channel: "general", text: "hi" };
    nodeOf(doc, "n_alert_it").parameters = { channel: "it-alerts", text: "hi" };

    const result = validateForCompile(doc, registry);
    if (result.ok) throw new Error("expected a failure");
    expect(result.errors).toHaveLength(2);
  });

  it("does not run the registry stages when the shape is already wrong", () => {
    // Reading fields off a document that failed its schema is how a validator
    // starts throwing instead of reporting.
    const result = validateForCompile({ ffir_version: "1.0" }, registry);
    if (result.ok) throw new Error("expected a failure");
    expect(codes(result)).not.toContain(ErrorCode.UNKNOWN_CAPABILITY);
  });
});

describe("determinism", () => {
  it("returns the same errors in the same order every run", () => {
    const doc = cloneOnboarding();
    nodeOf(doc, "n_trigger").capability = "bamboohr.employee.hired";
    nodeOf(doc, "n_slack_welcome").parameters = { channel: "general", text: "hi" };

    const once = validateForCompile(doc, registry);
    expect(validateForCompile(doc, registry)).toEqual(once);
  });
});
