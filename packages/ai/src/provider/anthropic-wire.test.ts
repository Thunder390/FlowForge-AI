/**
 * The wire format is where a provider integration goes wrong silently.
 *
 * A parameter that returns a 400 fails loudly and gets fixed. A cache
 * breakpoint on the wrong block, a `thinking` config that quietly disables
 * reasoning, or a stop reason read before it is checked all keep working and
 * cost either money or correctness. Those are what these tests are about.
 */

import { describe, expect, it } from "vitest";

import {
  buildRequest,
  DEFAULT_EFFORT,
  GENERATION_MAX_TOKENS,
  MODELS,
  SERVER_SIDE_FALLBACK_BETA,
  textOf,
  toProviderMessage,
  toStopReason,
  type AnthropicMessageLike,
} from "./anthropic-wire.js";
import { STOP_REASONS, type GenerationRequest, type JsonSchema } from "./types.js";

const SCHEMA: JsonSchema = {
  type: "object",
  properties: { a: { type: "string" } },
  required: ["a"],
  additionalProperties: false,
};

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    model: MODELS.generation,
    maxTokens: GENERATION_MAX_TOKENS,
    effort: DEFAULT_EFFORT,
    system: [{ text: "instructions" }, { text: "catalog", cache: true }],
    messages: [{ role: "user", content: "post to slack" }],
    outputSchema: { name: "thing", schema: SCHEMA },
    ...overrides,
  };
}

describe("model ids", () => {
  it("names the current models rather than a retired one", () => {
    // The strategy document's roadmap named Claude 3.5 Sonnet, which is
    // retired and would 404. These are the values the code carries.
    expect(MODELS.generation).toBe("claude-opus-5");
    expect(MODELS.classifier).toBe("claude-haiku-4-5");
  });
});

describe("parameters that must not be sent", () => {
  it("sets no sampling parameters, which all return a 400 on Opus 5", () => {
    const body = buildRequest(request()) as unknown as Record<string, unknown>;
    expect(body["temperature"]).toBeUndefined();
    expect(body["top_p"]).toBeUndefined();
    expect(body["top_k"]).toBeUndefined();
  });

  it("omits `thinking` entirely, which is how Opus 5 runs adaptive thinking", () => {
    // Setting `budget_tokens` would be a 400; setting `disabled` would turn
    // off the reasoning that graph planning depends on. Omitting the parameter
    // is the correct third option, and it is easy to "fix" by mistake.
    expect(buildRequest(request()).thinking).toBeUndefined();
  });

  it("adds a summarized display only when asked", () => {
    const body = buildRequest(request(), { summarizeThinking: true });
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });
});

describe("the request body", () => {
  it("carries the cache breakpoint on the block that declared it", () => {
    const body = buildRequest(request());
    expect(body.system).toEqual([
      { type: "text", text: "instructions" },
      { type: "text", text: "catalog", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("puts effort and the output format inside output_config", () => {
    // Not top-level. `effort` at the top level is silently ignored, which is
    // the worst of the three possible outcomes.
    const body = buildRequest(request());
    expect(body.output_config).toEqual({
      effort: "high",
      format: { type: "json_schema", schema: SCHEMA },
    });
  });

  it("omits output_config when there is nothing to put in it", () => {
    // Built literally rather than through the helper: under
    // `exactOptionalPropertyTypes` an omitted optional and one explicitly set
    // to `undefined` are different types, and this test is about the former.
    const body = buildRequest({
      model: MODELS.generation,
      maxTokens: GENERATION_MAX_TOKENS,
      system: [{ text: "instructions" }],
      messages: [{ role: "user", content: "hello" }],
    });
    expect(body.output_config).toBeUndefined();
  });

  it("opts into server-side fallback by default", () => {
    const body = buildRequest(request());
    expect(body.betas).toEqual([SERVER_SIDE_FALLBACK_BETA]);
    // The scalar form routes by refusal category. Pinning a model would be a
    // migration the day that model is deprecated.
    expect(body.fallbacks).toBe("default");
  });

  it("can be built without the fallback beta", () => {
    const body = buildRequest(request(), { serverSideFallback: false });
    expect(body.betas).toBeUndefined();
    expect(body.fallbacks).toBeUndefined();
  });

  it("preserves message order, which is what makes repair a continuation", () => {
    const body = buildRequest(
      request({
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "reply" },
          { role: "user", content: "fix it" },
        ],
      }),
    );
    expect(body.messages.map((message) => message.content)).toEqual([
      "first",
      "reply",
      "fix it",
    ]);
  });

  it("uses a max_tokens that leaves room for thinking plus the document", () => {
    // The cap covers both, so sizing it around the expected output truncates
    // mid-document. 32000 is the floor for a generation call.
    expect(GENERATION_MAX_TOKENS).toBeGreaterThanOrEqual(32_000);
  });
});

describe("reading a finished message", () => {
  const usage = {
    input_tokens: 8000,
    output_tokens: 1500,
    cache_read_input_tokens: 7200,
    cache_creation_input_tokens: 0,
  };

  it("concatenates only text blocks", () => {
    // A response can also carry a `fallback` block marking where one model
    // declined and another continued. Concatenating it into the JSON about to
    // be parsed would corrupt the document.
    const message: AnthropicMessageLike = {
      content: [
        { type: "text", text: '{"a":' },
        { type: "fallback" },
        { type: "text", text: '"b"}' },
      ],
    };
    expect(textOf(message)).toBe('{"a":"b"}');
  });

  it("carries the cache read count through, because nothing else reveals it", () => {
    const mapped = toProviderMessage({ usage }, MODELS.generation);
    expect(mapped.usage).toEqual({
      inputTokens: 8000,
      outputTokens: 1500,
      cacheReadInputTokens: 7200,
      cacheCreationInputTokens: 0,
    });
  });

  it("reports the model that actually answered, which a fallback can change", () => {
    const mapped = toProviderMessage({ model: "claude-opus-4-8" }, MODELS.generation);
    expect(mapped.model).toBe("claude-opus-4-8");
  });

  it("keeps stop_details only on a refusal", () => {
    const declined = toProviderMessage(
      {
        stop_reason: "refusal",
        stop_details: { category: "cyber", explanation: "no" },
        content: [],
      },
      MODELS.generation,
    );
    expect(declined.stopReason).toBe("refusal");
    expect(declined.stopDetails).toEqual({ category: "cyber", explanation: "no" });

    // Populated only on a refusal and null otherwise, so forwarding it
    // elsewhere would put a null in the error details of a healthy response.
    const fine = toProviderMessage(
      { stop_reason: "end_turn", stop_details: null },
      MODELS.generation,
    );
    expect(fine.stopDetails).toBeUndefined();
  });

  it("survives a refusal with no content at all", () => {
    // The case that throws in code which reads content[0] without checking.
    const mapped = toProviderMessage({ stop_reason: "refusal" }, MODELS.generation);
    expect(mapped.text).toBe("");
    expect(mapped.usage.inputTokens).toBe(0);
  });
});

describe("stop reasons", () => {
  it("passes every member of the vocabulary through unchanged", () => {
    for (const reason of STOP_REASONS) {
      expect(toStopReason(reason)).toBe(reason);
    }
  });

  it("treats null and an unknown future value as end_turn", () => {
    // A message still being written, or an API newer than this build. Neither
    // should throw: the response is validated against a closed schema straight
    // afterwards, so a genuinely broken one fails with a message about the
    // document rather than about our enum.
    expect(toStopReason(null)).toBe("end_turn");
    expect(toStopReason(undefined)).toBe("end_turn");
    expect(toStopReason("something_new")).toBe("end_turn");
  });
});
