/**
 * The pre-lowering check is what turns "this target cannot do that" from a
 * silent mangling into a sentence the user can act on. Every rejection here is
 * tested for the message as well as the code, because a correct refusal with an
 * unreadable reason sends the user to support instead of to the fix.
 */

import { onboardingExample } from "@flowforge/ffir/fixtures";
import { describe, expect, it } from "vitest";

import {
  duplicateLabelDocument,
  loopDocument,
  nodeOf,
  parallelDocument,
} from "./__fixtures__/documents.js";
import { fakeTarget, LINEAR_CAPABILITIES } from "./__fixtures__/index.js";
import {
  checkTargetCapabilities,
  requiredCapabilities,
  supportsDocument,
} from "./capabilities.js";
import { nodeIdOf } from "./errors.js";

const permissive = fakeTarget();
const linear = fakeTarget({
  key: "linear",
  displayName: "Linear Platform",
  capabilities: LINEAR_CAPABILITIES,
});

function features(doc: Parameters<typeof checkTargetCapabilities>[0], target = linear) {
  return checkTargetCapabilities(doc, target).errors.map((error) =>
    error.stage === "lower" ? error.feature : error.code,
  );
}

describe("a target that supports everything", () => {
  it("accepts the worked example", () => {
    expect(checkTargetCapabilities(onboardingExample, permissive)).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it("accepts a loop", () => {
    expect(supportsDocument(loopDocument(), permissive)).toBe(true);
  });

  it("accepts parallel branches", () => {
    expect(supportsDocument(parallelDocument(), permissive)).toBe(true);
  });
});

describe("branching", () => {
  it("rejects a branch node against a linear target", () => {
    const doc = parallelDocument();
    nodeOf(doc, "n_left").kind = "branch";

    const errors = checkTargetCapabilities(doc, linear).errors;
    expect(errors[0]).toMatchObject({
      stage: "lower",
      code: "unsupported_feature",
      feature: "branching",
      nodeId: "n_left",
    });
  });

  it("names the node and says what to do instead", () => {
    const doc = parallelDocument();
    nodeOf(doc, "n_left").kind = "branch";

    expect(checkTargetCapabilities(doc, linear).errors[0]?.message).toBe(
      'Cannot compile to Linear Platform: this workflow uses conditional branching (node "n_left", kind "branch"), and Linear Platform workflows are linear. Remove the branch, or export to a target that supports branching.',
    );
  });

  it("accepts a branch against a router target, which is what Make does", () => {
    const doc = parallelDocument();
    nodeOf(doc, "n_left").kind = "branch";
    const router = fakeTarget({ capabilities: { branching: "router" } });

    expect(features(doc, router)).not.toContain("branching");
  });
});

describe("loops", () => {
  it("rejects a loop node against a target without iteration", () => {
    expect(features(loopDocument())).toContain("loops");
  });

  it("names the loop node", () => {
    const error = checkTargetCapabilities(loopDocument(), linear).errors.find(
      (candidate) => candidate.stage === "lower" && candidate.feature === "loops",
    );
    expect(error).toMatchObject({ nodeId: "n_loop" });
  });
});

describe("error routing", () => {
  it("rejects an edge on the error port", () => {
    // The worked example routes a Google Workspace failure to a Slack alert.
    expect(features(onboardingExample)).toContain("error_routing");
  });

  it("rejects a node whose policy routes on error", () => {
    const errors = checkTargetCapabilities(onboardingExample, linear).errors.filter(
      (error) => error.stage === "lower" && error.feature === "error_routing",
    );
    // One for the policy on n_create_account, one for the edge leaving it.
    expect(errors).toHaveLength(2);
    expect(errors.every((error) => nodeIdOf(error) === "n_create_account")).toBe(true);
  });

  it("accepts both against a target that routes errors", () => {
    expect(features(onboardingExample, fakeTarget())).not.toContain("error_routing");
  });
});

describe("parallel branches", () => {
  it("rejects a node fanning out on the main port", () => {
    expect(features(parallelDocument())).toContain("parallel_branches");
  });

  it("says how many steps it fans out to", () => {
    const error = checkTargetCapabilities(parallelDocument(), linear).errors.find(
      (candidate) => candidate.stage === "lower" && candidate.feature === "parallel_branches",
    );
    expect(error?.message).toContain("2 steps at once");
  });

  it("does not count an error-port edge as a parallel branch", () => {
    // The worked example's n_create_account has one main edge and one error
    // edge. That is not fan-out; it is a failure path.
    const errorRouting = fakeTarget({
      capabilities: { errorRouting: true, parallelBranches: false },
    });
    expect(features(onboardingExample, errorRouting)).not.toContain("parallel_branches");
  });
});

describe("retry policy", () => {
  it("warns rather than failing, because a dropped retry is not a shape change", () => {
    // A target without retries still runs every step in the right order. Making
    // this an error would refuse to export a linear workflow because one step
    // asked for a second attempt.
    const check = checkTargetCapabilities(onboardingExample, linear);

    expect(check.errors.some((error) => error.code === "policy_unsupported")).toBe(false);
    expect(check.warnings).toEqual([
      {
        code: "policy_unsupported",
        nodeId: "n_create_account",
        message:
          "Linear Platform cannot retry a failed step, so the retry policy on \"Create Google Workspace account\" will not be exported. The step still runs in the same order; it just will not try again if it fails.",
      },
    ]);
  });

  it("stays quiet on a target that does retry", () => {
    expect(checkTargetCapabilities(onboardingExample, permissive).warnings).toEqual([]);
  });
});

describe("node ceiling", () => {
  it("rejects a document above maxNodes as an emit-stage limit", () => {
    // The stage names the class of failure and who should act, not when the
    // check happened to run. The frozen error model has no pre-check stage.
    const small = fakeTarget({ displayName: "Small", capabilities: { maxNodes: 3 } });
    const error = checkTargetCapabilities(onboardingExample, small).errors[0];

    expect(error).toMatchObject({
      stage: "emit",
      code: "target_limit_exceeded",
      detail: "5 nodes exceeds the 3 Small allows",
    });
    expect(error?.message).toContain("Split it into smaller workflows");
  });

  it("accepts a document exactly at the ceiling", () => {
    const exact = fakeTarget({ capabilities: { maxNodes: 5 } });
    expect(supportsDocument(onboardingExample, exact)).toBe(true);
  });

  it("imposes no ceiling when the target declares none", () => {
    expect(supportsDocument(duplicateLabelDocument(), permissive)).toBe(true);
  });
});

describe("reporting", () => {
  it("reports every mismatch at once", () => {
    // The decision the user is about to make is "use a different target", and
    // they cannot weigh it one rejection at a time.
    const doc = loopDocument();
    nodeOf(doc, "n_body").kind = "branch";

    expect(new Set(features(doc))).toEqual(new Set(["loops", "branching"]));
  });

  it("walks nodes in document order, then edges", () => {
    const doc = loopDocument();
    nodeOf(doc, "n_body").kind = "branch";

    expect(features(doc)).toEqual(["loops", "branching"]);
  });

  it("gives the same answer every run", () => {
    const once = checkTargetCapabilities(onboardingExample, linear);
    expect(checkTargetCapabilities(onboardingExample, linear)).toEqual(once);
  });
});

describe("requiredCapabilities", () => {
  it("describes what the worked example needs, for a UI to gray out an option", () => {
    expect(requiredCapabilities(onboardingExample)).toEqual({
      branching: false,
      loops: false,
      errorRouting: true,
      retryPolicy: true,
      parallelBranches: false,
    });
  });

  it("spots a loop", () => {
    expect(requiredCapabilities(loopDocument()).loops).toBe(true);
  });

  it("spots parallel fan-out", () => {
    expect(requiredCapabilities(parallelDocument()).parallelBranches).toBe(true);
  });
});
