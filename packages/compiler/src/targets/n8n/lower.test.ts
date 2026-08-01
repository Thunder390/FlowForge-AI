/**
 * Stage 4, tested through `compile` rather than by hand-building a graph.
 *
 * Lowering reads a normalized graph, and constructing one by hand would mean
 * asserting against a fixture whose relationship to a real compile is
 * whatever the test author assumed. Driving the whole pipeline costs
 * milliseconds and tests the thing that actually ships.
 */

import { cloneOnboarding, onboardingExample } from "@flowforge/ffir/fixtures";
import type { Registry } from "@flowforge/registry";
import { loadFixtureRegistry } from "@flowforge/registry/fixtures";
import { describe, expect, it } from "vitest";

import { nodeOf } from "../../__fixtures__/documents.js";
import { compile } from "../../compile.js";
import type { CompileWarning } from "../../errors.js";
import { nodeUuid } from "../../uuid.js";
import { CREDENTIAL_PLACEHOLDER } from "./lower.js";
import { n8nTarget } from "./index.js";
import type { N8nNode, N8nWorkflow } from "./ir.js";

const registry = await loadFixtureRegistry();

function build(doc: unknown, using: Registry = registry): {
  workflow: N8nWorkflow;
  warnings: readonly CompileWarning[];
} {
  const result = compile(doc, using, n8nTarget);
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.errors)}`);
  return {
    workflow: JSON.parse(result.value.content) as N8nWorkflow,
    warnings: result.warnings,
  };
}

function node(workflow: N8nWorkflow, name: string): N8nNode {
  const found = workflow.nodes.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no node called ${name}`);
  return found;
}

const onboarding = build(onboardingExample);

describe("the workflow envelope", () => {
  it("carries the document's name and n8n's execution order", () => {
    expect(onboarding.workflow.name).toBe("Employee onboarding");
    expect(onboarding.workflow.settings).toEqual({ executionOrder: "v1" });
    expect(onboarding.workflow.meta).toEqual({ instanceId: "flowforge" });
    expect(onboarding.workflow.pinData).toEqual({});
  });

  it("emits one node per FFIR node, in topological order", () => {
    expect(onboarding.workflow.nodes.map((entry) => entry.name)).toEqual([
      "New employee in BambooHR",
      "Build the email address",
      "Create Google Workspace account",
      "Alert IT on failure",
      "Announce in Slack",
    ]);
  });
});

describe("node fields", () => {
  it("takes the id from the workflow and node ids, not from a random source", () => {
    expect(node(onboarding.workflow, "Announce in Slack").id).toBe(
      nodeUuid("wf_01HQ8XONBOARD", "n_slack_welcome"),
    );
  });

  it("takes type and typeVersion from the binding", () => {
    expect(node(onboarding.workflow, "Announce in Slack")).toMatchObject({
      type: "n8n-nodes-base.slack",
      typeVersion: 2.2,
    });
  });

  it("merges static parameters under the mapped FFIR ones", () => {
    // A capability pins resource and operation while FFIR drives the rest.
    expect(node(onboarding.workflow, "Announce in Slack").parameters).toEqual({
      resource: "message",
      operation: "post",
      channel: "#general",
      text: "=Welcome {{ $('New employee in BambooHR').item.json.employee.first_name }} to the team. Their account is {{ $('Build the email address').item.json.email }}.",
    });
  });

  it("nests a dotted parameter_map path", () => {
    expect(
      node(onboarding.workflow, "Create Google Workspace account").parameters,
    ).toMatchObject({
      additionalFields: { changePasswordAtNextLogin: true, orgUnitPath: "/" },
    });
  });

  it("prefixes an expression-bearing parameter with = and leaves a literal alone", () => {
    const slack = node(onboarding.workflow, "Announce in Slack").parameters;
    expect(slack["text"]).toMatch(/^=/);
    expect(slack["channel"]).toBe("#general");
  });
});

describe("credentials", () => {
  it("emits a placeholder keyed by the binding's credential key", () => {
    expect(node(onboarding.workflow, "Announce in Slack").credentials).toEqual({
      slackOAuth2Api: { id: CREDENTIAL_PLACEHOLDER, name: "Slack workspace" },
    });
  });

  it("names it from the FFIR credential's label, which is what n8n shows the user", () => {
    expect(
      node(onboarding.workflow, "Create Google Workspace account").credentials,
    ).toEqual({
      gSuiteAdminOAuth2Api: {
        id: CREDENTIAL_PLACEHOLDER,
        name: "Google Workspace admin",
      },
    });
  });

  it("omits credentials for a capability that needs none", () => {
    expect(node(onboarding.workflow, "Build the email address").credentials).toBeUndefined();
  });

  it("never emits a value, only a reference", () => {
    for (const entry of onboarding.workflow.nodes) {
      for (const credential of Object.values(entry.credentials ?? {})) {
        expect(credential.id).toBe(CREDENTIAL_PLACEHOLDER);
      }
    }
  });
});

describe("error handling", () => {
  it("maps a routing policy to continueErrorOutput and carries the retry", () => {
    expect(node(onboarding.workflow, "Create Google Workspace account")).toMatchObject({
      onError: "continueErrorOutput",
      retryOnFail: true,
      maxTries: 2,
      waitBetweenTries: 2000,
    });
  });

  it("leaves onError off when the policy is stop, which is n8n's own default", () => {
    expect(node(onboarding.workflow, "Announce in Slack").onError).toBeUndefined();
    expect(node(onboarding.workflow, "Announce in Slack").retryOnFail).toBeUndefined();
  });

  it("maps continue to continueRegularOutput", () => {
    const doc = cloneOnboarding();
    nodeOf(doc, "n_slack_welcome").error_policy = { on_error: "continue" };
    expect(node(build(doc).workflow, "Announce in Slack").onError).toBe(
      "continueRegularOutput",
    );
  });

  it("routes a node that has an error edge whatever its policy says", () => {
    // Rule 17 required the edge to exist, and a node whose failures feed a
    // handler has to continue on its error output or the handler never runs.
    const doc = cloneOnboarding();
    nodeOf(doc, "n_create_account").error_policy = { on_error: "stop" };
    expect(node(build(doc).workflow, "Create Google Workspace account").onError).toBe(
      "continueErrorOutput",
    );
  });

  it("warns that exponential backoff is exported as a fixed wait", () => {
    expect(
      onboarding.warnings.filter(
        (warning) =>
          warning.code === "policy_unsupported" && warning.nodeId === "n_create_account",
      ),
    ).toHaveLength(1);
  });

  it("warns that a per-step timeout has nowhere to go", () => {
    const doc = cloneOnboarding();
    nodeOf(doc, "n_slack_welcome").error_policy = { on_error: "stop", timeout_ms: 5000 };

    const warnings = build(doc).warnings.filter(
      (warning) => warning.nodeId === "n_slack_welcome",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("no per-step timeout");
  });
});

describe("connections", () => {
  it("keys by source display name and targets by display name", () => {
    expect(onboarding.workflow.connections["New employee in BambooHR"]).toEqual({
      main: [[{ node: "Build the email address", type: "main", index: 0 }]],
    });
  });

  it("gives the error port its own key alongside main", () => {
    expect(onboarding.workflow.connections["Create Google Workspace account"]).toEqual({
      main: [[{ node: "Announce in Slack", type: "main", index: 0 }]],
      error: [[{ node: "Alert IT on failure", type: "main", index: 0 }]],
    });
  });

  it("omits a node with no outgoing edges", () => {
    expect(onboarding.workflow.connections["Announce in Slack"]).toBeUndefined();
  });

  it("puts every FFIR edge in the output exactly once", () => {
    const count = Object.values(onboarding.workflow.connections)
      .flatMap((outputs) => Object.values(outputs))
      .flatMap((slots) => slots)
      .reduce((total, slot) => total + (slot?.length ?? 0), 0);

    expect(count).toBe(onboardingExample.edges.length);
  });
});

describe("the trigger", () => {
  it("warns when the platform implements a poll as a webhook", () => {
    // A webhook needs a URL registered upstream and a poller does not, so the
    // user has to be told the mechanism changed.
    const warning = onboarding.warnings.find(
      (candidate) => candidate.code === "trigger_mechanism_changed",
    );
    expect(warning?.nodeId).toBe("n_trigger");
    expect(warning?.message).toContain("webhook");
  });

  it("lowers to the binding's node type", () => {
    expect(node(onboarding.workflow, "New employee in BambooHR").type).toBe(
      "n8n-nodes-base.webhook",
    );
  });
});

describe("degradation", () => {
  function degraded(): Registry {
    const forTarget = new Map(registry.bindings.get("n8n"));
    forTarget.set("slack.message.send", null);
    return { ...registry, bindings: new Map([["n8n", forTarget]]) };
  }

  it("compiles a degraded node through the HTTP node type", () => {
    const { workflow } = build(onboardingExample, degraded());
    expect(node(workflow, "Announce in Slack").type).toBe("n8n-nodes-base.httpRequest");
  });

  it("keeps the node's place in the graph", () => {
    const { workflow } = build(onboardingExample, degraded());
    expect(workflow.nodes).toHaveLength(5);
    expect(workflow.connections["Create Google Workspace account"]?.["main"]).toEqual([
      [{ node: "Announce in Slack", type: "main", index: 0 }],
    ]);
  });

  it("warns once per degraded node", () => {
    const { warnings } = build(onboardingExample, degraded());
    expect(warnings.filter((warning) => warning.code === "capability_degraded")).toHaveLength(
      2,
    );
  });
});

describe("determinism", () => {
  it("produces identical bytes on repeated compiles", () => {
    const first = compile(onboardingExample, registry, n8nTarget);
    const second = compile(onboardingExample, registry, n8nTarget);
    if (!first.ok || !second.ok) throw new Error("expected success");
    expect(first.value.content).toBe(second.value.content);
  });

  it("is unmoved by the order the nodes are written in", () => {
    const shuffled = cloneOnboarding();
    shuffled.nodes = [
      nodeOf(shuffled, "n_alert_it"),
      nodeOf(shuffled, "n_slack_welcome"),
      nodeOf(shuffled, "n_create_account"),
      nodeOf(shuffled, "n_build_email"),
      nodeOf(shuffled, "n_trigger"),
    ];

    const original = compile(onboardingExample, registry, n8nTarget);
    const reordered = compile(shuffled, registry, n8nTarget);
    if (!original.ok || !reordered.ok) throw new Error("expected success");
    expect(reordered.value.content).toBe(original.value.content);
  });

  it("emits no value that looks like a generated id or a timestamp", () => {
    const content = JSON.stringify(onboarding.workflow);
    expect(content).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});
