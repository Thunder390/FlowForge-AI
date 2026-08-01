/**
 * One error vocabulary across four layers.
 *
 * The property worth testing is that reconciling does not renumber: each
 * failure keeps the code its own specification uses, because that code is what
 * is printed in the repair prompt and searched for in a log. What the
 * reconciliation adds is the stage and the recovery, and getting a recovery
 * wrong is how a bug becomes an infinite retry.
 */

import { OutputError, ProviderError } from "@flowforge/ai";
import type { CompileError } from "@flowforge/compiler";
import { ErrorCode, type ValidationError } from "@flowforge/ffir";
import { describe, expect, it } from "vitest";

import { fromCompileError, fromThrown, fromValidationError, isTerminal } from "./errors.js";

describe("validation failures", () => {
  it("keeps the FFIR code and the pointer unchanged", () => {
    const error: ValidationError = {
      code: ErrorCode.UNKNOWN_PARAMETER_NAME,
      path: "/nodes/2/parameters/channell",
      message: '"channell" is not a parameter of this capability.',
      details: { node_id: "n_slack", parameter: "channell" },
    };

    expect(fromValidationError("validate", error)).toEqual({
      stage: "validate",
      code: "unknown_parameter_name",
      message: '"channell" is not a parameter of this capability.',
      recovery: "repair",
      nodeId: "n_slack",
      path: "/nodes/2/parameters/channell",
      details: { node_id: "n_slack", parameter: "channell" },
    });
  });

  it("marks a terminal code terminal, so no retry is attempted", () => {
    // A document over a resource limit is not going to become smaller because
    // we asked again.
    const failure = fromValidationError("validate", {
      code: ErrorCode.DOCUMENT_LIMIT_EXCEEDED,
      path: "",
      message: "too big",
    });
    expect(failure.recovery).toBe("terminal");
    expect(failure).not.toHaveProperty("path");
  });

  it("treats a prompt-signal failure as repairable, keeping the code visible", () => {
    // `repairable_prompt_signal` is a different thing to *track*, not a
    // different thing to *do*, so it maps to repair and stays distinguishable
    // through the code.
    const failure = fromValidationError("validate", {
      code: ErrorCode.SECRET_IN_PARAMETER,
      path: "/nodes/0/parameters/token",
      message: "looks like a live key",
    });
    expect(failure.recovery).toBe("repair");
    expect(failure.code).toBe("secret_in_parameter");
  });
});

describe("compile failures", () => {
  it("maps a lower failure to a repair against the named node", () => {
    const error: CompileError = {
      stage: "lower",
      code: "unsupported_feature",
      feature: "branching",
      nodeId: "n_branch",
      message: "This target cannot branch.",
    };

    expect(fromCompileError(error)).toEqual({
      stage: "compile",
      code: "unsupported_feature",
      message: "This target cannot branch.",
      recovery: "repair",
      nodeId: "n_branch",
      details: { compileStage: "lower" },
    });
  });

  it("treats a verify failure as terminal, because it is our bug", () => {
    // The compiler's own output failed its structural self-check. Asking the
    // model to try again cannot fix our emitter.
    const failure = fromCompileError({
      stage: "verify",
      code: "internal_inconsistency",
      detail: "dangling connection",
    });
    expect(failure.recovery).toBe("terminal");
    expect(failure.message).toContain("bug in FlowForge");
  });
});

describe("thrown failures", () => {
  it("sends a refusal to the fallback rung rather than to repair", () => {
    // A refusal is not a mistake in the output, so there is nothing to repair.
    const failure = fromThrown("plan", new ProviderError("refusal", "declined", { a: 1 }));
    expect(failure.recovery).toBe("fallback");
    expect(failure.code).toBe("refusal");
    expect(failure.details).toEqual({ a: 1 });
  });

  it("sends truncation and transport failures to retry", () => {
    expect(fromThrown("plan", new ProviderError("max_tokens", "cut off")).recovery).toBe("retry");
    expect(fromThrown("plan", new ProviderError("transport", "429")).recovery).toBe("retry");
  });

  it("treats missing credentials and a missing fixture as terminal", () => {
    expect(fromThrown("plan", new ProviderError("credentials_missing", "none")).recovery).toBe(
      "terminal",
    );
    expect(fromThrown("plan", new ProviderError("no_fixture", "none")).recovery).toBe("terminal");
  });

  it("sends malformed output to repair, carrying the issue list", () => {
    const failure = fromThrown(
      "parameters",
      new OutputError("schema_violation", "workflow_parameters", ["missing count"]),
    );
    expect(failure.recovery).toBe("repair");
    expect(failure.details).toEqual({
      schema: "workflow_parameters",
      issues: ["missing count"],
    });
  });

  it("treats an unexpected throw as terminal rather than retrying a bug", () => {
    const failure = fromThrown("merge", new TypeError("cannot read x of undefined"));
    expect(failure.code).toBe("unexpected_error");
    expect(failure.recovery).toBe("terminal");
    expect(failure.stage).toBe("merge");
  });

  it("survives something that is not an Error at all", () => {
    expect(fromThrown("merge", "just a string").message).toBe("just a string");
  });

  it("omits empty details rather than emitting an empty object", () => {
    expect(fromThrown("plan", new ProviderError("transport", "x"))).not.toHaveProperty("details");
  });
});

describe("deciding whether to give up", () => {
  it("is terminal only when nothing on the list could be recovered", () => {
    const terminal = fromThrown("plan", new ProviderError("no_message", "x"));
    const repairable = fromThrown("plan", new OutputError("malformed_json", "plan", ["bad"]));

    expect(isTerminal([terminal])).toBe(true);
    expect(isTerminal([terminal, repairable])).toBe(false);
    // An empty list is not a terminal failure, it is a success.
    expect(isTerminal([])).toBe(false);
  });
});
