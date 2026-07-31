import {
  ErrorCode,
  classOf,
  validateWithoutRegistry,
  type FFIRDocument,
  type Node,
  type Parameters,
} from "@flowforge/ffir";
import { cloneOnboarding, onboardingExample } from "@flowforge/ffir/fixtures";
import type { Capability, Registry } from "@flowforge/registry";
import { loadFixtureRegistry } from "@flowforge/registry/fixtures";
import { describe, expect, it } from "vitest";

import { checkParameters, checkRegistry, validateAgainstRegistry } from "./validate.js";

const registry = await loadFixtureRegistry();

function codes(result: { errors: { code: string }[] }): string[] {
  return result.errors.map((error) => error.code);
}

/** The worked example with one node's parameters replaced. */
function withParameters(nodeId: string, parameters: Parameters): FFIRDocument {
  const doc = cloneOnboarding();
  nodeOf(doc, nodeId).parameters = parameters;
  return doc;
}

function nodeOf(doc: FFIRDocument, nodeId: string): Node {
  const node = doc.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) throw new Error(`no node ${nodeId} in the worked example`);
  return node;
}

/** A registry with one capability swapped, for cases the shipped build should not fake. */
function withCapability(id: string, capability: Capability): Registry {
  return {
    ...registry,
    capabilities: new Map([...registry.capabilities, [id, capability]]),
  };
}

describe("a valid workflow", () => {
  it("passes both stages", () => {
    expect(validateAgainstRegistry(onboardingExample, registry)).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("passes every stage the two packages own together", () => {
    // Stages 0, 1, and 4 in `ffir`, then 2 and 3 here. Composing all five is
    // the orchestrator's job in M8, but the worked example has to survive them
    // all today or the fixtures have drifted from each other.
    expect(validateWithoutRegistry(onboardingExample).ok).toBe(true);
    expect(validateAgainstRegistry(onboardingExample, registry).ok).toBe(true);
  });

  it("does not mutate the document it is handed", () => {
    const before = structuredClone(onboardingExample);
    validateAgainstRegistry(onboardingExample, registry);
    expect(onboardingExample).toEqual(before);
  });

  it("accepts a node whose capability declares no required parameters", () => {
    const doc = withParameters("n_trigger", {});
    expect(codes(checkParameters(doc, registry))).toEqual([]);
  });
});

describe("stage 2, unknown capabilities", () => {
  it("rejects a capability the registry does not contain", () => {
    const doc = cloneOnboarding();
    nodeOf(doc, "n_slack_welcome").capability = "slack.message.broadcast";

    const result = checkRegistry(doc, registry);
    expect(codes(result)).toEqual([ErrorCode.UNKNOWN_CAPABILITY]);
    expect(result.errors[0]?.path).toBe("/nodes/3/capability");
  });

  it("hands back the integration's real capability list when the app is known", () => {
    // Rung 2 of the unknown-capability ladder: the integration segment resolves
    // but the operation does not, the model is given the real list, and it
    // repairs reliably. Only if the list is in the error.
    const doc = cloneOnboarding();
    nodeOf(doc, "n_slack_welcome").capability = "slack.message.broadcast";

    const error = checkRegistry(doc, registry).errors[0];
    expect(error?.details).toMatchObject({
      integration: "slack",
      integration_known: true,
      available: ["slack.channel.create", "slack.message.send"],
    });
    expect(error?.message).toContain("slack.message.send");
  });

  it("says so plainly when the integration itself is unknown", () => {
    const doc = cloneOnboarding();
    nodeOf(doc, "n_slack_welcome").capability = "pipedrive.deal.create";

    const error = checkRegistry(doc, registry).errors[0];
    expect(error?.details).toMatchObject({
      integration: "pipedrive",
      integration_known: false,
      available: [],
    });
    expect(error?.message).toContain("no integration called");
  });

  it("reports every unknown capability, not just the first", () => {
    const doc = cloneOnboarding();
    nodeOf(doc, "n_slack_welcome").capability = "slack.message.broadcast";
    nodeOf(doc, "n_alert_it").capability = "discord.message.send";

    expect(codes(checkRegistry(doc, registry))).toEqual([
      ErrorCode.UNKNOWN_CAPABILITY,
      ErrorCode.UNKNOWN_CAPABILITY,
    ]);
  });

  it("rejects a credential scoped to an integration the registry lacks", () => {
    const doc = cloneOnboarding();
    const credential = doc.credentials[2];
    if (credential !== undefined) credential.capability_scope = "mattermost";

    const result = checkRegistry(doc, registry);
    expect(result.errors.map((error) => error.code)).toContain(
      ErrorCode.UNKNOWN_CAPABILITY_SCOPE,
    );
    expect(
      result.errors.find((error) => error.code === ErrorCode.UNKNOWN_CAPABILITY_SCOPE)?.path,
    ).toBe("/credentials/2/capability_scope");
  });

  it("catches a bogus scope on a credential no node uses, which rule 10 cannot", () => {
    // Rule 10 checks a scope against the capabilities that reference it, so an
    // unreferenced credential is invisible to it. The merge step still joins
    // every scope against the registry to build the setup guide.
    const doc = cloneOnboarding();
    doc.credentials.push({
      id: "cred_orphan",
      capability_scope: "salesforce",
      auth_type: "oauth2",
      label: "Unused",
    });

    expect(validateWithoutRegistry(doc).ok).toBe(true);
    expect(codes(checkRegistry(doc, registry))).toEqual([
      ErrorCode.UNKNOWN_CAPABILITY_SCOPE,
    ]);
  });
});

describe("stage 3, parameter names", () => {
  it("rejects a parameter name the capability does not declare", () => {
    // The explicit test for the name check. It is the one guarding against a
    // weaker future provider: the synthesized pass B schema makes an illegal
    // name structurally impossible, but that guarantee belongs to one provider
    // and does not apply to hand-authored or imported documents at all.
    const doc = withParameters("n_slack_welcome", {
      channel: "#general",
      text: "hello",
      icon_emoji: ":tada:",
    });

    const result = checkParameters(doc, registry);
    expect(codes(result)).toEqual([ErrorCode.UNKNOWN_PARAMETER_NAME]);
    expect(result.errors[0]?.path).toBe("/nodes/3/parameters/icon_emoji");
    expect(result.errors[0]?.details).toMatchObject({
      node_id: "n_slack_welcome",
      capability: "slack.message.send",
      parameter: "icon_emoji",
      declared: ["channel", "text", "thread_ts", "blocks"],
    });
  });

  it("names the node and the parameter, because vague feedback produces vague fixes", () => {
    const doc = withParameters("n_slack_welcome", {
      channel: "#general",
      text: "hello",
      icon_emoji: ":tada:",
    });
    expect(checkParameters(doc, registry).errors[0]?.message).toBe(
      'Node "n_slack_welcome", parameter "icon_emoji": "icon_emoji" is not a parameter of this capability. Legal names here are: channel, text, thread_ts, blocks.',
    );
  });

  it("rejects an unknown name nested inside a declared object", () => {
    const doc = withParameters("n_build_email", {
      assignments: [{ field: "email", value: "x", transform: "upper" }],
    });

    const result = checkParameters(doc, registry);
    expect(codes(result)).toEqual([ErrorCode.UNKNOWN_PARAMETER_NAME]);
    expect(result.errors[0]?.path).toBe("/nodes/1/parameters/assignments/0/transform");
  });
});

describe("stage 3, parameter values", () => {
  it("rejects a value its registry rule forbids", () => {
    const doc = withParameters("n_slack_welcome", { channel: "general", text: "hello" });

    const result = checkParameters(doc, registry);
    expect(codes(result)).toEqual([ErrorCode.INVALID_PARAMETER_VALUE]);
    expect(result.errors[0]?.path).toBe("/nodes/3/parameters/channel");
    expect(result.errors[0]?.details).toMatchObject({
      node_id: "n_slack_welcome",
      failure: "param_pattern_failed",
      value: "general",
    });
  });

  it("carries the registry failure code the repair prompt prints", () => {
    // The FFIR code says which rule failed; `details.failure` says which of the
    // registry's rules did. The repair prompt shows the second.
    const cases: [string, Parameters, string][] = [
      ["n_slack_welcome", { text: "hello" }, "param_missing"],
      ["n_slack_welcome", { channel: 7, text: "hi" }, "param_type_mismatch"],
      ["n_slack_welcome", { channel: "general", text: "hi" }, "param_pattern_failed"],
      ["n_trigger", { poll_interval_minutes: 1 }, "param_out_of_range"],
    ];

    for (const [nodeId, parameters, failure] of cases) {
      const result = checkParameters(withParameters(nodeId, parameters), registry);
      expect(result.errors[0]?.details, `${nodeId} ${failure}`).toMatchObject({ failure });
    }
  });

  it("accepts a value carrying an expression, whatever its declared shape", () => {
    const doc = withParameters("n_slack_welcome", {
      channel: "{{ $vars.alert_channel }}",
      text: "Welcome {{ n_trigger.employee.first_name }}",
    });
    expect(codes(checkParameters(doc, registry))).toEqual([]);
  });

  it("reports every bad parameter across every node", () => {
    const doc = cloneOnboarding();
    nodeOf(doc, "n_slack_welcome").parameters = { channel: "general", text: "hi" };
    nodeOf(doc, "n_alert_it").parameters = { channel: "#it-alerts" };

    // Omitting Slack's text trips two registry rules at once, because text is
    // required and blocks is conditionally required when text is empty. Both
    // are true statements about what the registry declares, and between them
    // they tell the model it may supply either one.
    expect(
      checkParameters(doc, registry).errors.map((error) => [
        error.path,
        error.details?.["failure"],
      ]),
    ).toEqual([
      ["/nodes/3/parameters/channel", "param_pattern_failed"],
      ["/nodes/4/parameters/text", "param_missing"],
      ["/nodes/4/parameters/blocks", "param_conditional_missing"],
    ]);
  });
});

describe("each failure gets its own code", () => {
  it("distinguishes an unknown capability, an unknown name, and a bad value", () => {
    const doc = cloneOnboarding();
    nodeOf(doc, "n_trigger").capability = "bamboohr.employee.hired";
    nodeOf(doc, "n_slack_welcome").parameters = {
      channel: "general",
      text: "hi",
      icon_emoji: ":x:",
    };

    expect(codes(validateAgainstRegistry(doc, registry))).toEqual([
      ErrorCode.UNKNOWN_CAPABILITY,
      ErrorCode.INVALID_PARAMETER_VALUE,
      ErrorCode.UNKNOWN_PARAMETER_NAME,
    ]);
  });

  it("classes all three as repairable, so the loop retries rather than gives up", () => {
    const doc = cloneOnboarding();
    nodeOf(doc, "n_trigger").capability = "bamboohr.employee.hired";
    nodeOf(doc, "n_slack_welcome").parameters = { channel: "general", text: "hi", x: 1 };

    for (const error of validateAgainstRegistry(doc, registry).errors) {
      expect(classOf(error), error.code).toBe("repairable");
    }
  });
});

describe("stage interaction", () => {
  it("does not check the parameters of a capability that did not resolve", () => {
    // There is nothing to check them against, and inventing a failure per
    // parameter would bury the one error that matters.
    const doc = cloneOnboarding();
    nodeOf(doc, "n_slack_welcome").capability = "slack.message.broadcast";
    nodeOf(doc, "n_slack_welcome").parameters = { anything: "at all" };

    expect(codes(checkParameters(doc, registry))).toEqual([]);
    expect(codes(validateAgainstRegistry(doc, registry))).toEqual([
      ErrorCode.UNKNOWN_CAPABILITY,
    ]);
  });

  it("still checks the other nodes' parameters", () => {
    const doc = cloneOnboarding();
    nodeOf(doc, "n_trigger").capability = "bamboohr.employee.hired";
    nodeOf(doc, "n_alert_it").parameters = { channel: "it-alerts", text: "hi" };

    expect(codes(validateAgainstRegistry(doc, registry))).toEqual([
      ErrorCode.UNKNOWN_CAPABILITY,
      ErrorCode.INVALID_PARAMETER_VALUE,
    ]);
  });

  it("runs stage 3 even when stage 2 found something, so one repair fixes both", () => {
    const doc = cloneOnboarding();
    nodeOf(doc, "n_trigger").capability = "bamboohr.employee.hired";
    nodeOf(doc, "n_slack_welcome").parameters = { channel: "general", text: "hi" };

    expect(validateAgainstRegistry(doc, registry).errors).toHaveLength(2);
  });
});

describe("architectural compliance", () => {
  it("validates identically against a registry with every binding removed", () => {
    // The AI layer never reads a binding. If it did, "adding Make.com requires
    // no AI change" would stop being true, and a validator is the easiest place
    // for that leak to start: "check it can compile" sounds like diligence.
    // Whether a target can express a capability is settled at registry load and
    // at the compile dry-run, which is stage 5 and belongs to the pipeline.
    const unbound: Registry = { ...registry, bindings: new Map(), targets: [] };

    expect(validateAgainstRegistry(onboardingExample, unbound)).toEqual(
      validateAgainstRegistry(onboardingExample, registry),
    );

    const doc = withParameters("n_slack_welcome", { channel: "general", text: "hi" });
    expect(validateAgainstRegistry(doc, unbound)).toEqual(
      validateAgainstRegistry(doc, registry),
    );
  });
});

describe("edge cases", () => {
  it("accepts a capability marked deprecated, which is the point of never removing one", () => {
    // A stored workflow that pinned a capability whose upstream node has since
    // disappeared still has to resolve, so it can be migrated with a clear
    // message rather than failing to load.
    const slack = registry.capabilities.get("slack.message.send");
    if (slack === undefined) throw new Error("fixture drift");
    const deprecated = withCapability("slack.message.send", {
      ...slack,
      deprecated: true,
      replaced_by: "slack.channel.create",
    });

    expect(validateAgainstRegistry(onboardingExample, deprecated).ok).toBe(true);
  });

  it("reports a malformed capability string rather than throwing", () => {
    const doc = cloneOnboarding();
    nodeOf(doc, "n_slack_welcome").capability = "not-a-capability";

    const result = checkRegistry(doc, registry);
    expect(codes(result)).toEqual([ErrorCode.UNKNOWN_CAPABILITY]);
    expect(result.errors[0]?.details).toMatchObject({ integration: "not-a-capability" });
  });

  it("handles an empty capability string", () => {
    const doc = cloneOnboarding();
    nodeOf(doc, "n_slack_welcome").capability = "";
    expect(codes(checkRegistry(doc, registry))).toEqual([ErrorCode.UNKNOWN_CAPABILITY]);
  });

  it("handles a document with no credentials to scope-check", () => {
    const doc = cloneOnboarding();
    doc.credentials = [];
    for (const node of doc.nodes) delete node.credential;
    expect(codes(checkRegistry(doc, registry))).toEqual([]);
  });

  it("rejects a parameter object carrying an inherited property name", () => {
    const doc = withParameters("n_slack_welcome", {
      channel: "#general",
      text: "hi",
      constructor: "surprise",
    });
    expect(codes(checkParameters(doc, registry))).toEqual([
      ErrorCode.UNKNOWN_PARAMETER_NAME,
    ]);
  });

  it("returns ok for a registry that happens to contain nothing", () => {
    const empty: Registry = {
      ...registry,
      capabilities: new Map(),
      integrations: new Map(),
    };
    const result = validateAgainstRegistry(onboardingExample, empty);
    // Five nodes and three credentials, every one of them unresolvable.
    expect(result.errors).toHaveLength(8);
    expect(new Set(codes(result))).toEqual(
      new Set([ErrorCode.UNKNOWN_CAPABILITY, ErrorCode.UNKNOWN_CAPABILITY_SCOPE]),
    );
  });
});

describe("determinism", () => {
  it("returns the same errors in the same order on repeated runs", () => {
    const doc = cloneOnboarding();
    nodeOf(doc, "n_trigger").capability = "bamboohr.employee.hired";
    nodeOf(doc, "n_slack_welcome").parameters = { channel: "general", stray: 1 };

    const once = validateAgainstRegistry(doc, registry);
    expect(validateAgainstRegistry(doc, registry)).toEqual(once);
  });

  it("orders errors by stage, then by node, then by rule number", () => {
    const doc = cloneOnboarding();
    nodeOf(doc, "n_alert_it").capability = "slack.message.shout";
    nodeOf(doc, "n_build_email").parameters = { assignments: [], stray: true };
    nodeOf(doc, "n_slack_welcome").parameters = { channel: "general", text: "hi" };

    expect(
      validateAgainstRegistry(doc, registry).errors.map((error) => [
        error.code,
        error.path,
      ]),
    ).toEqual([
      [ErrorCode.UNKNOWN_CAPABILITY, "/nodes/4/capability"],
      [ErrorCode.INVALID_PARAMETER_VALUE, "/nodes/1/parameters/assignments"],
      [ErrorCode.UNKNOWN_PARAMETER_NAME, "/nodes/1/parameters/stray"],
      [ErrorCode.INVALID_PARAMETER_VALUE, "/nodes/3/parameters/channel"],
    ]);
  });
});
