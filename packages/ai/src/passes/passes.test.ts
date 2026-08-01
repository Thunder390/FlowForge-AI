/**
 * The two passes: what they send, and what they refuse to do.
 *
 * The request layout is the substance here. A cache breakpoint on the wrong
 * block costs money silently, an enum that has drifted from FFIR's produces a
 * document that fails stage 1 every time, and a synthesis error that reaches
 * the provider spends an Opus call on a request that cannot succeed.
 */

import {
  CONDITION_OPERATORS,
  NODE_KINDS,
  ON_ERROR_VALUES,
  VARIABLE_TYPES,
} from "@flowforge/ffir";
import { loadFixtureRegistry } from "@flowforge/registry/fixtures";
import type { Registry } from "@flowforge/registry";
import { beforeAll, describe, expect, it } from "vitest";

import { ONBOARDING_PLAN, ONBOARDING_PROMPT } from "../__fixtures__/onboarding.js";
import { GENERATION_MAX_TOKENS, MODELS } from "../provider/anthropic-wire.js";
import { ReplayProvider } from "../provider/replay.js";
import { ProviderError } from "../provider/types.js";
import { InlineRetriever } from "../retrieval/inline.js";
import { OutputError } from "../structured.js";
import { callStructured } from "./call.js";
import {
  buildParametersRequest,
  PARAMETERS_SCHEMA_NAME,
  runParameters,
} from "./parameters.js";
import {
  buildPlanRequest,
  capabilitiesOf,
  NO_CONDITION,
  PLAN_SCHEMA,
  PLAN_SCHEMA_NAME,
  runPlan,
} from "./plan.js";

let registry: Registry;
const retriever = new InlineRetriever();

beforeAll(async () => {
  registry = await loadFixtureRegistry();
});

function planInput() {
  return { prompt: ONBOARDING_PROMPT, registry, retriever };
}

function parametersInput() {
  return { plan: ONBOARDING_PLAN, prompt: ONBOARDING_PROMPT, registry, retriever };
}

describe("the pass A schema", () => {
  it("uses FFIR's enums rather than copies of them", () => {
    // A schema that let the model emit a kind FFIR does not have would produce
    // a document failing stage 1 every time, and the failure would look like a
    // model problem rather than a drifted constant.
    const nodes = PLAN_SCHEMA.properties?.["nodes"]?.items?.properties;
    expect(nodes?.["kind"]?.enum).toEqual([...NODE_KINDS]);
    expect(nodes?.["on_error"]?.enum).toEqual([...ON_ERROR_VALUES]);

    const edges = PLAN_SCHEMA.properties?.["edges"]?.items?.properties;
    expect(edges?.["condition_operator"]?.enum).toEqual([
      NO_CONDITION,
      ...CONDITION_OPERATORS,
    ]);

    const variables = PLAN_SCHEMA.properties?.["variables"]?.items?.properties;
    expect(variables?.["type"]?.enum).toEqual([...VARIABLE_TYPES]);
  });

  it("requires every field, because absence is expressed with sentinels", () => {
    const nodeItem = PLAN_SCHEMA.properties?.["nodes"]?.items;
    expect(nodeItem?.required).toEqual(Object.keys(nodeItem?.properties ?? {}));

    const edgeItem = PLAN_SCHEMA.properties?.["edges"]?.items;
    expect(edgeItem?.required).toEqual(Object.keys(edgeItem?.properties ?? {}));
  });

  it("is closed at every level", () => {
    expect(PLAN_SCHEMA.additionalProperties).toBe(false);
    for (const key of ["nodes", "edges", "variables"]) {
      expect(PLAN_SCHEMA.properties?.[key]?.items?.additionalProperties).toBe(false);
    }
  });

  it("flattens conditions onto the edge rather than nesting them", () => {
    // Fewer nesting levels means fewer places for the model to go wrong; the
    // merge reassembles the nested FFIR form.
    const edges = PLAN_SCHEMA.properties?.["edges"]?.items?.properties;
    expect(edges?.["condition_left"]).toBeDefined();
    expect(edges?.["condition"]).toBeUndefined();
  });

  it("carries none of the keywords structured outputs rejects", () => {
    const serialized = JSON.stringify(PLAN_SCHEMA);
    for (const banned of ["pattern", "minLength", "minimum"]) {
      expect(serialized).not.toContain(`"${banned}"`);
    }
  });
});

describe("the pass A request", () => {
  it("puts the cache breakpoint after the catalog, not before it", () => {
    // Render order is tools, then system, then messages, so a breakpoint on
    // the last system block caches the instructions and the catalog together
    // and leaves only the user's prompt volatile.
    const request = buildPlanRequest(planInput());
    expect(request.system).toHaveLength(2);
    expect(request.system[0]?.cache).toBeUndefined();
    expect(request.system[1]?.cache).toBe(true);
    expect(request.system[1]?.text).toContain("Capability catalog");
  });

  it("sends the user's prompt as the only message by default", () => {
    const request = buildPlanRequest(planInput());
    expect(request.messages).toEqual([{ role: "user", content: ONBOARDING_PROMPT }]);
  });

  it("carries prior turns ahead of the new one, for chat iteration", () => {
    const request = buildPlanRequest({
      ...planInput(),
      history: [
        { role: "user", content: "original" },
        { role: "assistant", content: "the workflow" },
      ],
    });
    expect(request.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
  });

  it("defaults to the generation model, high effort, and the token floor", () => {
    const request = buildPlanRequest(planInput());
    expect(request.model).toBe(MODELS.generation);
    expect(request.effort).toBe("high");
    expect(request.maxTokens).toBe(GENERATION_MAX_TOKENS);
    expect(request.outputSchema?.name).toBe(PLAN_SCHEMA_NAME);
  });

  it("is identical for identical input, which is what makes the prefix cache", () => {
    expect(JSON.stringify(buildPlanRequest(planInput()))).toBe(
      JSON.stringify(buildPlanRequest(planInput())),
    );
  });
});

describe("the pass B request", () => {
  it("puts the breakpoint after the instructions, before the per-workflow bundle", () => {
    const { request } = buildParametersRequest(parametersInput());
    expect(request.system[0]?.cache).toBe(true);
    expect(request.system[1]?.cache).toBeUndefined();
    expect(request.system[1]?.text).toContain("Capability details");
  });

  it("constrains output to the schema synthesized for these exact nodes", () => {
    const { request, synthesis } = buildParametersRequest(parametersInput());
    expect(synthesis.ok).toBe(true);
    expect(request.outputSchema?.name).toBe(PARAMETERS_SCHEMA_NAME);
    expect(Object.keys(request.outputSchema?.schema.properties ?? {})).toEqual(
      ONBOARDING_PLAN.nodes.map((node) => node.id),
    );
  });

  it("sends the plan and then the original request, in that order", () => {
    // The plan says "announce in Slack"; the request says which channel.
    const { request } = buildParametersRequest(parametersInput());
    const message = request.messages[0]?.content ?? "";
    expect(message.indexOf("n_slack_welcome")).toBeLessThan(
      message.indexOf(ONBOARDING_PROMPT),
    );
  });

  it("bundles only the capabilities the plan named", () => {
    const { bundle } = buildParametersRequest(parametersInput());
    expect(bundle.resolved).toEqual(capabilitiesOf(ONBOARDING_PLAN));
    expect(bundle.unknown).toEqual([]);
  });
});

describe("running a pass", () => {
  it("returns the parsed plan for a recorded response", async () => {
    const request = buildPlanRequest(planInput());
    const provider = new ReplayProvider([
      { id: "plan", request, response: { text: JSON.stringify(ONBOARDING_PLAN) } },
    ]);

    const result = await runPlan(provider, planInput());
    expect(result.plan.nodes).toHaveLength(5);
    expect(result.request).toEqual(request);
  });

  it("returns the parsed parameters for a recorded response", async () => {
    const { request } = buildParametersRequest(parametersInput());
    const provider = new ReplayProvider([
      {
        id: "parameters",
        request,
        response: {
          text: JSON.stringify({
            n_trigger: { poll_interval_minutes: 15 },
            n_build_email: {
              assignments: [{ field: "email", value: "x" }],
              include_other_fields: true,
            },
            n_create_account: {
              primary_email: "a@b.c",
              given_name: "A",
              family_name: "B",
              password: "{{ $vars.temp_password }}",
              change_password_at_next_login: true,
              org_unit_path: "/",
            },
            n_slack_welcome: { channel: "#general", text: "hi", thread_ts: "" },
            n_alert_it: { channel: "#it-alerts", text: "uh oh", thread_ts: "" },
          }),
        },
      },
    ]);

    const result = await runParameters(provider, parametersInput());
    expect(Object.keys(result.parameters)).toHaveLength(5);
  });

  it("refuses to spend a call when the schema cannot describe a valid document", async () => {
    // The model would be handed a schema no valid answer fits, so it would
    // produce something that fails stage 3 and no repair could fix it, because
    // the fix is a key the schema forbids.
    const provider = new ReplayProvider([]);
    const broken = {
      ...parametersInput(),
      plan: {
        ...ONBOARDING_PLAN,
        nodes: [
          {
            ...ONBOARDING_PLAN.nodes[0]!,
            capability: "nope.not.real",
          },
        ],
      },
    };

    await expect(runParameters(provider, broken)).rejects.toThrow(OutputError);
    expect(provider.calls).toHaveLength(0);
  });
});

describe("the structured call", () => {
  it("raises a refusal as its own code, so the fallback rung can answer it", async () => {
    const request = buildPlanRequest(planInput());
    const provider = new ReplayProvider([
      { id: "declined", request, response: { text: "", stopReason: "refusal" } },
    ]);

    let thrown: unknown;
    try {
      await callStructured(provider, request);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as ProviderError).code).toBe("refusal");
  });

  it("raises truncation separately, because the answer is to double max_tokens", async () => {
    // Collapsing refusal and truncation into one failure would make both
    // unrecoverable: they sit on different rungs of the ladder.
    const request = buildPlanRequest(planInput());
    const provider = new ReplayProvider([
      { id: "cut off", request, response: { text: '{"name":', stopReason: "max_tokens" } },
    ]);

    let thrown: unknown;
    try {
      await callStructured(provider, request);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as ProviderError).code).toBe("max_tokens");
  });

  it("checks the stop reason before reading the text", async () => {
    // A refusal can carry partial content. Parsing it first would produce a
    // malformed-JSON error that sends the ladder to the wrong rung.
    const request = buildPlanRequest(planInput());
    const provider = new ReplayProvider([
      { id: "partial", request, response: { text: '{"nam', stopReason: "refusal" } },
    ]);

    await expect(callStructured(provider, request)).rejects.toThrow(/declined/);
  });

  it("rejects a call with no output schema as a bug in the caller", async () => {
    const provider = new ReplayProvider([]);
    await expect(
      callStructured(provider, {
        model: MODELS.generation,
        maxTokens: 1000,
        system: [],
        messages: [{ role: "user", content: "x" }],
      }),
    ).rejects.toThrow(/bug in the calling pass/);
  });
});

describe("capabilitiesOf", () => {
  it("de-duplicates and sorts, so retrieval is asked one stable question", () => {
    expect(capabilitiesOf(ONBOARDING_PLAN)).toEqual([
      "bamboohr.employee.created",
      "core.transform.map",
      "google_workspace.user.create",
      "slack.message.send",
    ]);
  });
});
