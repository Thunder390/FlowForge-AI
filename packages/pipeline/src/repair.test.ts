/**
 * The repair prompt is a contract with the model, so these tests pin the parts
 * other behaviour depends on: that only repairable failures are sent, that a
 * node and parameter are named, and that the do-not-redesign instruction is
 * present. A prompt change that drops any of them should fail here rather than
 * show up as a rising repair rate weeks later.
 */

import { describe, expect, it } from "vitest";

import type { GenerationFailure } from "./errors.js";
import { buildRepairPrompt, repairable } from "./repair.js";

function failure(over: Partial<GenerationFailure> = {}): GenerationFailure {
  return {
    stage: "validate",
    code: "param_pattern_failed",
    message: "A channel name must start with # or @, or be a channel ID.",
    recovery: "repair",
    ...over,
  };
}

describe("which failures reach the model", () => {
  it("keeps only the repairable ones", () => {
    const failures = [
      failure({ code: "a" }),
      failure({ code: "b", recovery: "terminal" }),
      failure({ code: "c", recovery: "retry" }),
      failure({ code: "d", recovery: "fallback" }),
    ];

    expect(repairable(failures).map((f) => f.code)).toEqual(["a"]);
  });

  it("returns no prompt when nothing is repairable, so an empty complaint cannot be sent", () => {
    const failures = [failure({ recovery: "terminal" }), failure({ recovery: "retry" })];

    expect(buildRepairPrompt(failures)).toBeUndefined();
  });

  it("returns no prompt for an empty failure list", () => {
    expect(buildRepairPrompt([])).toBeUndefined();
  });

  it("omits a terminal failure from a mixed list rather than dropping the whole prompt", () => {
    const prompt = buildRepairPrompt([
      failure({ code: "param_pattern_failed" }),
      failure({ code: "emitter_broken", recovery: "terminal" }),
    ]);

    expect(prompt).toContain("param_pattern_failed");
    expect(prompt).not.toContain("emitter_broken");
  });
});

describe("locating a failure", () => {
  it("names the node and the parameter when both are known", () => {
    const prompt = buildRepairPrompt([
      failure({ nodeId: "n_slack_welcome", details: { parameter: "channel" } }),
    ]);

    expect(prompt).toContain('node "n_slack_welcome", parameter "channel"');
  });

  it("reads the node id out of details when it was not promoted onto the failure", () => {
    const prompt = buildRepairPrompt([failure({ details: { node_id: "n_create" } })]);

    expect(prompt).toContain('node "n_create"');
  });

  it("falls back to the JSON pointer when there is no node", () => {
    const prompt = buildRepairPrompt([failure({ path: "/nodes/2/parameters" })]);

    expect(prompt).toContain("at /nodes/2/parameters");
  });

  it("says document rather than inventing a location", () => {
    const prompt = buildRepairPrompt([failure({ path: "" })]);

    expect(prompt).toContain("document");
  });
});

describe("the body of each item", () => {
  it("prints the code and the validator's own message", () => {
    const prompt = buildRepairPrompt([
      failure({ code: "expression_forward_reference", message: "References a node that does not run before this one." }),
    ]);

    expect(prompt).toContain("Code: expression_forward_reference");
    expect(prompt).toContain("References a node that does not run before this one.");
  });

  it("prints a value only when the failure carries one", () => {
    const withValue = buildRepairPrompt([failure({ details: { value: "general" } })]);
    const without = buildRepairPrompt([failure()]);

    expect(withValue).toContain('Value: "general"');
    expect(without).not.toContain("Value:");
  });

  it("JSON-encodes the value so an empty string is visible", () => {
    const prompt = buildRepairPrompt([failure({ details: { value: "" } })]);

    // A bare empty string would render as `Value: ` and read as a formatting
    // bug rather than as the actual offending value.
    expect(prompt).toContain('Value: ""');
  });

  it("distinguishes the number 3 from the string \"3\"", () => {
    const asNumber = buildRepairPrompt([failure({ details: { value: 3 } })]);
    const asText = buildRepairPrompt([failure({ details: { value: "3" } })]);

    expect(asNumber).toContain("Value: 3");
    expect(asText).toContain('Value: "3"');
  });

  it("numbers items from one, in order", () => {
    const prompt = buildRepairPrompt([
      failure({ code: "first" }),
      failure({ code: "second" }),
      failure({ code: "third" }),
    ]);

    expect(prompt).toContain("[1] ");
    expect(prompt).toContain("[2] ");
    expect(prompt).toContain("[3] ");
    expect(prompt?.indexOf("[1]")).toBeLessThan(prompt?.indexOf("[2]") ?? 0);
  });
});

describe("instructions the model depends on", () => {
  it("forbids changing anything that was not flagged", () => {
    // Without this line the model redesigns, which loses correct work. It is
    // the single most load-bearing sentence in the prompt.
    const prompt = buildRepairPrompt([failure()]);

    expect(prompt).toContain("Do not change anything that was not flagged.");
  });

  it("asks for the complete workflow rather than a diff", () => {
    const prompt = buildRepairPrompt([failure()]);

    expect(prompt).toContain("Return the complete corrected workflow");
  });
});

describe("compile failures", () => {
  it("formats a compile failure the same way, since the model cannot act on a different shape", () => {
    const prompt = buildRepairPrompt([
      {
        stage: "compile",
        code: "unsupported_node_kind",
        message: "The n8n target has no lowering for this node kind.",
        recovery: "repair",
        nodeId: "n_loop",
        details: { compileStage: "lower" },
      },
    ]);

    expect(prompt).toContain('node "n_loop"');
    expect(prompt).toContain("Code: unsupported_node_kind");
    expect(prompt).toContain("The n8n target has no lowering for this node kind.");
  });
});
