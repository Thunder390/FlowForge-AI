/**
 * What happens when generation goes wrong.
 *
 * The success path is covered by `generate.test.ts`. This is the other half,
 * and the half more likely to rot: a failure branch that returns the wrong
 * stage, swallows a warning, or reports success on an invalid document costs
 * nothing until the day it matters.
 */

import {
  ONBOARDING_DOCUMENT_ID,
  ONBOARDING_GENERATED_AT,
  ONBOARDING_PARAMETERS,
  ONBOARDING_PLAN,
  ONBOARDING_PROMPT,
} from "@flowforge/ai/fixtures";
import {
  buildParametersRequest,
  buildPlanRequest,
  InlineRetriever,
  ReplayProvider,
  type WorkflowPlan,
} from "@flowforge/ai";
import { loadFixtureRegistry } from "@flowforge/registry/fixtures";
import type { Registry } from "@flowforge/registry";
import { beforeAll, describe, expect, it } from "vitest";

import { generate } from "./generate.js";
import { DEFERRED_STAGES, IMPLEMENTED_STAGES, STAGES, STAGE_OWNER } from "./stages.js";

let registry: Registry;
const retriever = new InlineRetriever();

beforeAll(async () => {
  registry = await loadFixtureRegistry();
});

/** Runs a generation against a provider carrying whatever recordings are given. */
async function run(provider: ReplayProvider, prompt = ONBOARDING_PROMPT) {
  return generate({
    prompt,
    registry,
    provider,
    retriever,
    documentId: ONBOARDING_DOCUMENT_ID,
    generatedAt: ONBOARDING_GENERATED_AT,
  });
}

/** A replay provider that records pass A returning `plan` and nothing else. */
function planOnly(plan: WorkflowPlan, prompt = ONBOARDING_PROMPT): ReplayProvider {
  return new ReplayProvider([
    {
      id: "pass-a",
      request: buildPlanRequest({ prompt, registry, retriever }),
      response: { text: JSON.stringify(plan) },
    },
  ]);
}

describe("failing at pass A", () => {
  it("reports the stage and stops before retrieval", async () => {
    // No recording at all, so the provider cannot answer.
    const result = await run(new ReplayProvider([]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("plan");
    expect(result.failures[0]?.code).toBe("no_fixture");
    expect(result.failures[0]?.recovery).toBe("terminal");
    // Nothing downstream ran, so there is no plan to report.
    expect(result.plan).toBeUndefined();
  });

  it("sends a refusal to the fallback rung", async () => {
    const provider = new ReplayProvider([
      {
        id: "declined",
        request: buildPlanRequest({ prompt: ONBOARDING_PROMPT, registry, retriever }),
        response: { text: "", stopReason: "refusal" },
      },
    ]);

    const result = await run(provider);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures[0]?.code).toBe("refusal");
    expect(result.failures[0]?.recovery).toBe("fallback");
  });

  it("sends output that does not match the plan schema to repair", async () => {
    const provider = new ReplayProvider([
      {
        id: "wrong shape",
        request: buildPlanRequest({ prompt: ONBOARDING_PROMPT, registry, retriever }),
        response: { text: '{"name":"only a name"}' },
      },
    ]);

    const result = await run(provider);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures[0]?.code).toBe("schema_violation");
    expect(result.failures[0]?.recovery).toBe("repair");
  });
});

describe("failing at retrieval", () => {
  it("stops before spending a pass B call when the schema cannot be built", async () => {
    // An unknown capability leaves the synthesized schema unable to describe a
    // valid document, and no repair can add a key the schema forbids.
    const plan: WorkflowPlan = {
      ...ONBOARDING_PLAN,
      nodes: [{ ...ONBOARDING_PLAN.nodes[0]!, capability: "nope.not.real" }],
      edges: [],
    };
    const provider = planOnly(plan);

    const result = await run(provider);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("retrieve");
    // One call, pass A. Pass B was never attempted.
    expect(provider.calls).toHaveLength(1);
    // The plan is reported, because it exists and is what the failure is about.
    expect(result.plan).toEqual(plan);
  });
});

describe("failing at pass B", () => {
  it("reports the stage and keeps the plan", async () => {
    const provider = planOnly(ONBOARDING_PLAN);
    const result = await run(provider);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("parameters");
    expect(result.failures[0]?.code).toBe("no_fixture");
    expect(result.plan?.nodes).toHaveLength(5);
    // Pass A and the attempted pass B.
    expect(provider.calls).toHaveLength(2);
  });
});

describe("failing at validation", () => {
  it("returns every failure rather than the first", async () => {
    // The repair prompt needs the complete list to fix a document in one
    // retry rather than three.
    const plan: WorkflowPlan = {
      ...structuredClone(ONBOARDING_PLAN),
      // Two problems at once: an edge to a node that does not exist, and a
      // second trigger.
      nodes: [
        ...structuredClone(ONBOARDING_PLAN.nodes),
        {
          id: "n_second_trigger",
          kind: "trigger",
          capability: "bamboohr.employee.created",
          label: "Another trigger",
          notes: "",
          capability_scope: "bamboohr",
          on_error: "stop",
          retry_attempts: 0,
        },
      ],
      edges: [
        ...structuredClone(ONBOARDING_PLAN.edges),
        {
          id: "e_bad",
          from: "n_trigger",
          to: "n_does_not_exist",
          port: "",
          condition_left: "",
          condition_operator: "none",
          condition_right: "",
        },
      ],
    };

    const parameters = {
      ...structuredClone(ONBOARDING_PARAMETERS),
      n_second_trigger: { poll_interval_minutes: 15 },
    };

    const provider = new ReplayProvider([
      {
        id: "pass-a",
        request: buildPlanRequest({ prompt: ONBOARDING_PROMPT, registry, retriever }),
        response: { text: JSON.stringify(plan) },
      },
      {
        id: "pass-b",
        request: buildParametersRequest({
          plan,
          prompt: ONBOARDING_PROMPT,
          registry,
          retriever,
        }).request,
        response: { text: JSON.stringify(parameters) },
      },
    ]);

    const result = await run(provider);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.stage).toBe("validate");
    const codes = result.failures.map((failure) => failure.code);
    expect(codes).toContain("edge_endpoint_missing");
    expect(codes).toContain("trigger_count_invalid");
    expect(result.failures.every((failure) => failure.recovery === "repair")).toBe(true);
  });

  it("catches a missing required parameter at pass B, before validation sees it", async () => {
    // Worth stating plainly, because it is the closed schema earning its
    // keep. `max_iterations` is required in the registry, so the synthesized
    // schema requires it, so a response omitting it fails at `parameters`
    // rather than reaching stage 3. The validator would have caught it too;
    // catching it here means the repair prompt is answering a question about
    // the shape it was given rather than about a document it half-built.
    const plan: WorkflowPlan = {
      ...structuredClone(ONBOARDING_PLAN),
      nodes: [
        ONBOARDING_PLAN.nodes[0]!,
        {
          id: "n_loop",
          kind: "loop",
          capability: "core.loop.for_each",
          label: "For each hire",
          notes: "",
          capability_scope: "",
          on_error: "stop",
          retry_attempts: 0,
        },
      ],
      edges: [
        {
          id: "e_1",
          from: "n_trigger",
          to: "n_loop",
          port: "",
          condition_left: "",
          condition_operator: "none",
          condition_right: "",
        },
      ],
      variables: [],
    };

    const parameters = {
      n_trigger: { poll_interval_minutes: 15 },
      n_loop: { items: "{{ n_trigger.employee.id }}", item_alias: "hire" },
    };

    const provider = new ReplayProvider([
      {
        id: "pass-a",
        request: buildPlanRequest({ prompt: ONBOARDING_PROMPT, registry, retriever }),
        response: { text: JSON.stringify(plan) },
      },
      {
        id: "pass-b",
        request: buildParametersRequest({
          plan,
          prompt: ONBOARDING_PROMPT,
          registry,
          retriever,
        }).request,
        response: { text: JSON.stringify(parameters) },
      },
    ]);

    const result = await run(provider);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("parameters");
    expect(result.failures[0]?.code).toBe("schema_violation");
    expect(JSON.stringify(result.failures[0]?.details)).toContain("max_iterations");
  });
});

describe("usage accounting", () => {
  it("totals every call in the generation, including a failed one", async () => {
    const provider = new ReplayProvider([
      {
        id: "pass-a",
        request: buildPlanRequest({ prompt: ONBOARDING_PROMPT, registry, retriever }),
        response: {
          text: JSON.stringify(ONBOARDING_PLAN),
          usage: { inputTokens: 8000, outputTokens: 1500, cacheReadInputTokens: 7200 },
        },
      },
    ]);

    // Fails at pass B, but pass A's tokens were still spent and still have to
    // be billed and reported.
    const result = await run(provider);
    expect(result.usage.inputTokens).toBe(8000);
    expect(result.usage.outputTokens).toBe(1500);
    expect(result.usage.cacheReadInputTokens).toBe(7200);
  });
});

describe("the stage vocabulary", () => {
  it("accounts for every stage as implemented or deferred, with no overlap", () => {
    const covered = [...IMPLEMENTED_STAGES, ...DEFERRED_STAGES].sort();
    expect(covered).toEqual([...STAGES].sort());
    for (const stage of IMPLEMENTED_STAGES) {
      expect(DEFERRED_STAGES).not.toContain(stage);
    }
  });

  it("defers exactly the two stages the roadmap places in M9", () => {
    expect([...DEFERRED_STAGES]).toEqual(["classify", "compile"]);
  });

  it("names an owner for every stage", () => {
    for (const stage of STAGES) {
      expect(STAGE_OWNER[stage], stage).toBeTruthy();
    }
    // The two that make the orchestrator necessary sit on opposite sides.
    expect(STAGE_OWNER["parameters"]).toBe("ai");
    expect(STAGE_OWNER["compile"]).toBe("compiler");
  });
});
