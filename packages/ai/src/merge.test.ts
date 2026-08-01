/**
 * The merge is where a hallucination surface either exists or does not.
 *
 * Every field it derives is a field the model cannot get wrong, and every
 * sentinel it fails to convert is a field that reaches the validator as a
 * literal `"none"` or a `0` that means something. Both classes of mistake
 * produce documents that look plausible, so both are tested directly rather
 * than through a passing generation.
 */

import {
  SUPPORTED_EXPRESSION_GRAMMARS,
  SUPPORTED_FFIR_VERSIONS,
  validateWithoutRegistry,
} from "@flowforge/ffir";
import { loadFixtureRegistry } from "@flowforge/registry/fixtures";
import type { Registry } from "@flowforge/registry";
import { beforeAll, describe, expect, it } from "vitest";

import {
  ONBOARDING_DOCUMENT_ID,
  ONBOARDING_GENERATED_AT,
  ONBOARDING_PARAMETERS,
  ONBOARDING_PLAN,
  ONBOARDING_PROMPT,
} from "./__fixtures__/onboarding.js";
import {
  hashPrompt,
  merge,
  VERSION_PINS,
  WRITES_EXPRESSION_GRAMMAR,
  WRITES_FFIR_VERSION,
  type MergeInput,
} from "./merge.js";
import type { WorkflowPlan } from "./passes/plan.js";
import type { NodeParameters } from "./passes/parameters.js";
import { PROMPT_VERSION } from "./prompts.js";

let registry: Registry;
beforeAll(async () => {
  registry = await loadFixtureRegistry();
});

function input(overrides: Partial<MergeInput> = {}): MergeInput {
  return {
    plan: structuredClone(ONBOARDING_PLAN),
    parameters: structuredClone(ONBOARDING_PARAMETERS),
    registry,
    prompt: ONBOARDING_PROMPT,
    documentId: ONBOARDING_DOCUMENT_ID,
    generatedAt: ONBOARDING_GENERATED_AT,
    generatedBy: "claude-opus-5",
    promptVersion: PROMPT_VERSION,
    ...overrides,
  };
}

/** A one-node plan, for testing a single conversion without the whole example. */
function tinyPlan(node: Partial<WorkflowPlan["nodes"][number]> = {}): WorkflowPlan {
  return {
    name: "Tiny",
    description: "One step.",
    nodes: [
      {
        id: "n_trigger",
        kind: "trigger",
        capability: "bamboohr.employee.created",
        label: "New employee",
        notes: "",
        capability_scope: "bamboohr",
        on_error: "stop",
        retry_attempts: 0,
        ...node,
      },
    ],
    edges: [],
    variables: [],
  };
}

const TINY_PARAMETERS: NodeParameters = { n_trigger: { poll_interval_minutes: 15 } };

describe("the emitted versions", () => {
  it("writes a version this build supports", () => {
    // Constants rather than "the newest supported": a build that started
    // emitting a version the day it learned to read it would migrate every
    // stored workflow by accident.
    expect(SUPPORTED_FFIR_VERSIONS).toContain(WRITES_FFIR_VERSION);
    expect(SUPPORTED_EXPRESSION_GRAMMARS).toContain(WRITES_EXPRESSION_GRAMMAR);
    expect(VERSION_PINS.ffir.writes).toBe(WRITES_FFIR_VERSION);
  });
});

describe("sentinels become absence", () => {
  it("omits empty notes rather than writing an empty string", () => {
    const { document } = merge(
      input({ plan: tinyPlan({ notes: "" }), parameters: TINY_PARAMETERS }),
    );
    expect(document.nodes[0]?.notes).toBeUndefined();
  });

  it("keeps notes that say something", () => {
    const { document } = merge(
      input({ plan: tinyPlan({ notes: "Polls every 15 minutes." }), parameters: TINY_PARAMETERS }),
    );
    expect(document.nodes[0]?.notes).toBe("Polls every 15 minutes.");
  });

  it("omits error_policy entirely when it would say nothing", () => {
    // The compiler applies stop and no-retry as its own defaults, so writing
    // them out produces a document that differs from a hand-written one for no
    // behavioural reason.
    const { document } = merge(
      input({
        plan: tinyPlan({ on_error: "stop", retry_attempts: 0 }),
        parameters: TINY_PARAMETERS,
      }),
    );
    expect(document.nodes[0]?.error_policy).toBeUndefined();
  });

  it("keeps on_error alone when there is no retry", () => {
    const { document } = merge(
      input({
        plan: tinyPlan({ on_error: "continue", retry_attempts: 0 }),
        parameters: TINY_PARAMETERS,
      }),
    );
    expect(document.nodes[0]?.error_policy).toEqual({ on_error: "continue" });
  });

  it("supplies the backoff shape the plan does not carry", () => {
    // Pass A emits an attempt count and nothing else, because asking a model
    // to choose a backoff strategy invites it to choose badly.
    const { document } = merge(
      input({
        plan: tinyPlan({ on_error: "stop", retry_attempts: 3 }),
        parameters: TINY_PARAMETERS,
      }),
    );
    expect(document.nodes[0]?.error_policy).toEqual({
      on_error: "stop",
      retry: { attempts: 3, backoff: "exponential", initial_delay_ms: 2000 },
    });
  });

  it("omits the default port, which is how FFIR spells main", () => {
    const plan = tinyPlan();
    plan.nodes.push({ ...plan.nodes[0]!, id: "n_next", kind: "action", capability: "slack.message.send" });
    plan.edges = [
      { id: "e_1", from: "n_trigger", to: "n_next", port: "", condition_left: "", condition_operator: "none", condition_right: "" },
      { id: "e_2", from: "n_trigger", to: "n_next", port: "main", condition_left: "", condition_operator: "none", condition_right: "" },
      { id: "e_3", from: "n_trigger", to: "n_next", port: "error", condition_left: "", condition_operator: "none", condition_right: "" },
    ];

    const { document } = merge(
      input({
        plan,
        parameters: { ...TINY_PARAMETERS, n_next: { channel: "#a", text: "b", thread_ts: "" } },
      }),
    );

    expect(document.edges[0]?.port).toBeUndefined();
    expect(document.edges[1]?.port).toBeUndefined();
    expect(document.edges[2]?.port).toBe("error");
  });

  it('omits the whole condition object for the "none" operator', () => {
    const { document } = merge(input());
    expect(document.edges.every((edge) => edge.condition === undefined)).toBe(true);
  });
});

describe("structural reassembly", () => {
  it("nests a flattened condition back into FFIR's shape", () => {
    const plan = tinyPlan();
    plan.nodes.push({ ...plan.nodes[0]!, id: "n_next", kind: "action", capability: "slack.message.send" });
    plan.edges = [
      {
        id: "e_1",
        from: "n_trigger",
        to: "n_next",
        port: "",
        condition_left: "{{ n_trigger.employee.department }}",
        condition_operator: "equals",
        condition_right: "Engineering",
      },
    ];

    const { document } = merge(
      input({
        plan,
        parameters: { ...TINY_PARAMETERS, n_next: { channel: "#a", text: "b", thread_ts: "" } },
      }),
    );

    expect(document.edges[0]?.condition).toEqual({
      left: "{{ n_trigger.employee.department }}",
      operator: "equals",
      right: "Engineering",
    });
  });

  it("drops the right operand on a unary operator, which the schema forbids", () => {
    // A model that filled the sentinel in anyway must not have it carried
    // through: the FFIR schema rejects `right` on `is_empty` outright.
    const plan = tinyPlan();
    plan.nodes.push({ ...plan.nodes[0]!, id: "n_next", kind: "action", capability: "slack.message.send" });
    plan.edges = [
      {
        id: "e_1",
        from: "n_trigger",
        to: "n_next",
        port: "",
        condition_left: "{{ n_trigger.employee.work_email }}",
        condition_operator: "is_empty",
        condition_right: "leftover",
      },
    ];

    const { document } = merge(
      input({
        plan,
        parameters: { ...TINY_PARAMETERS, n_next: { channel: "#a", text: "b", thread_ts: "" } },
      }),
    );

    expect(document.edges[0]?.condition).toEqual({
      left: "{{ n_trigger.employee.work_email }}",
      operator: "is_empty",
    });
  });

  it("keys node parameters by node id", () => {
    const { document } = merge(input());
    expect(document.nodes.find((node) => node.id === "n_slack_welcome")?.parameters).toEqual(
      ONBOARDING_PARAMETERS["n_slack_welcome"],
    );
  });

  it("warns and continues when pass B returned nothing for a node", () => {
    const parameters = structuredClone(ONBOARDING_PARAMETERS);
    delete parameters["n_alert_it"];

    const { document, warnings } = merge(input({ parameters }));
    expect(document.nodes.find((node) => node.id === "n_alert_it")?.parameters).toEqual({});
    expect(warnings.some((warning) => warning.code === "node_parameters_missing")).toBe(true);
  });
});

describe("derived credentials", () => {
  it("produces one per integration, sorted, with the union of required scopes", () => {
    const { document } = merge(input());
    expect(document.credentials.map((credential) => credential.id)).toEqual([
      "cred_bamboohr",
      "cred_google_workspace",
      "cred_slack",
    ]);
    expect(
      document.credentials.find((credential) => credential.id === "cred_slack")
        ?.required_scopes,
    ).toEqual(["chat:write"]);
  });

  it("asks for exactly the scopes used, not everything the integration offers", () => {
    // The registry declares five Slack scopes and this workflow gets one. A
    // guide that cannot say what is needed pushes users toward granting
    // everything, which is a real security difference rather than tidiness.
    const slackAuth = registry.integrations.get("slack")?.auth[0];
    expect(slackAuth?.scopes_available).toHaveLength(5);

    const { document } = merge(input());
    expect(
      document.credentials.find((credential) => credential.id === "cred_slack")
        ?.required_scopes,
    ).toEqual(["chat:write"]);
  });

  it("produces none for a capability that needs no credential", () => {
    // Every `core.*` capability. A blanket "one per node" would fail rule 10.
    const { document } = merge(input());
    expect(document.credentials.some((c) => c.capability_scope === "core")).toBe(false);
    expect(document.nodes.find((node) => node.id === "n_build_email")?.credential).toBeUndefined();
  });

  it("omits required_scopes when the capability declares none", () => {
    const { document } = merge(input());
    const bamboo = document.credentials.find((c) => c.id === "cred_bamboohr");
    expect(bamboo?.required_scopes).toBeUndefined();
    expect(bamboo?.auth_type).toBe("api_key");
  });

  it("uses the capability's own integration, not the scope the model claimed", () => {
    // The join is against the integration the capability actually resolves to,
    // which removes the hallucination surface outright rather than validating
    // it afterwards.
    const plan = tinyPlan({ capability_scope: "totally_wrong" });
    const { document, warnings } = merge(input({ plan, parameters: TINY_PARAMETERS }));

    expect(document.credentials[0]?.capability_scope).toBe("bamboohr");
    expect(document.nodes[0]?.credential).toBe("cred_bamboohr");
    // Still recorded: a model contradicting a value it could have derived is a
    // prompt-quality signal worth counting.
    expect(warnings.some((warning) => warning.code === "capability_scope_ignored")).toBe(true);
  });

  it("does not warn when the model simply left the scope empty", () => {
    const { warnings } = merge(
      input({ plan: tinyPlan({ capability_scope: "" }), parameters: TINY_PARAMETERS }),
    );
    expect(warnings.some((warning) => warning.code === "capability_scope_ignored")).toBe(false);
  });
});

describe("variables", () => {
  it("keeps a default on an ordinary variable", () => {
    const { document } = merge(input());
    const domain = document.variables?.find((variable) => variable.id === "company_domain");
    expect(domain?.default).toBe("example.com");
    expect(domain?.sensitive).toBe(false);
  });

  it("strips the default from a variable the model marked sensitive", () => {
    const { document } = merge(input());
    const secret = document.variables?.find((variable) => variable.id === "temp_password");
    expect(secret?.sensitive).toBe(true);
    expect(secret?.default).toBeUndefined();
  });

  it("promotes a variable whose name reads like a credential", () => {
    // Model judgment is trusted to add the flag, never to remove it.
    const plan = tinyPlan();
    plan.variables = [
      {
        id: "api_token",
        label: "Service token",
        description: "",
        type: "string",
        required: true,
        sensitive: false,
        default: "sk-not-really",
      },
    ];

    const { document, warnings } = merge(input({ plan, parameters: TINY_PARAMETERS }));
    const promoted = document.variables?.[0];
    expect(promoted?.sensitive).toBe(true);
    // Rule 15 forbids a sensitive variable carrying a default, and a default
    // on a secret is a secret stored in the document.
    expect(promoted?.default).toBeUndefined();
    expect(warnings.some((warning) => warning.code === "variable_marked_sensitive")).toBe(true);
  });

  it("leaves an ordinary name alone", () => {
    const plan = tinyPlan();
    plan.variables = [
      {
        id: "company_domain",
        label: "Company email domain",
        description: "",
        type: "string",
        required: true,
        sensitive: false,
        default: "example.com",
      },
    ];
    const { document } = merge(input({ plan, parameters: TINY_PARAMETERS }));
    expect(document.variables?.[0]?.sensitive).toBe(false);
    expect(document.variables?.[0]?.default).toBe("example.com");
  });

  it("omits an empty description and an absent variables list", () => {
    const { document } = merge(input({ plan: tinyPlan(), parameters: TINY_PARAMETERS }));
    expect(document.variables).toBeUndefined();
  });
});

describe("stamped metadata", () => {
  it("records what produced the document", () => {
    const { document } = merge(input());
    expect(document.metadata).toMatchObject({
      generated_by: "claude-opus-5",
      generated_at: ONBOARDING_GENERATED_AT,
      registry_version: "n8n@1.62.0+overlay.3",
      prompt_version: PROMPT_VERSION,
    });
  });

  it("hashes the prompt rather than storing it", () => {
    const { document } = merge(input());
    expect(document.metadata?.["source_prompt_hash"]).toBe(hashPrompt(ONBOARDING_PROMPT));
    expect(JSON.stringify(document)).not.toContain(ONBOARDING_PROMPT);
  });

  it("carries warnings from earlier stages onto the document", () => {
    const { document } = merge(
      input({ warnings: [{ code: "capability_unknown", message: "something degraded" }] }),
    );
    expect(document.metadata?.["warnings"]).toContainEqual({
      code: "capability_unknown",
      message: "something degraded",
    });
  });

  it("omits the warnings key entirely when there are none", () => {
    const { document } = merge(input({ plan: tinyPlan(), parameters: TINY_PARAMETERS }));
    expect(document.metadata?.["warnings"]).toBeUndefined();
  });
});

describe("the merged document", () => {
  it("passes the structural validation stages", () => {
    const { document } = merge(input());
    expect(validateWithoutRegistry(document).errors).toEqual([]);
  });

  it("is a pure function of its inputs", () => {
    // No clock and no id generator, which is what lets a test assert on a
    // whole document rather than on one with two fields excused.
    expect(JSON.stringify(merge(input()).document)).toBe(
      JSON.stringify(merge(input()).document),
    );
  });

  it("preserves the plan's node and edge order", () => {
    const { document } = merge(input());
    expect(document.nodes.map((node) => node.id)).toEqual(
      ONBOARDING_PLAN.nodes.map((node) => node.id),
    );
    expect(document.edges.map((edge) => edge.id)).toEqual(
      ONBOARDING_PLAN.edges.map((edge) => edge.id),
    );
  });

  it("copies name and description from the plan verbatim", () => {
    const { document } = merge(input());
    expect(document.name).toBe(ONBOARDING_PLAN.name);
    expect(document.description).toBe(ONBOARDING_PLAN.description);
    expect(document.id).toBe(ONBOARDING_DOCUMENT_ID);
  });
});
