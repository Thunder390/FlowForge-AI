/**
 * The Anthropic adapter, against a stub client.
 *
 * There is not much here on purpose: everything that constitutes a decision
 * lives in `anthropic-wire.ts` and is tested there without a client at all.
 * What is left is the stream loop, and its two interesting properties are that
 * reasoning must not be relayed as output and that a transport failure must
 * arrive as a `ProviderError` rather than as whatever the SDK threw.
 */

import { describe, expect, it } from "vitest";

import { AnthropicProvider, type AnthropicLike, type MessageStreamLike } from "./anthropic.js";
import { collect, ProviderError, type GenerationRequest, type ProviderEvent } from "./types.js";

const REQUEST: GenerationRequest = {
  model: "claude-opus-5",
  maxTokens: 32_000,
  system: [{ text: "instructions", cache: true }],
  messages: [{ role: "user", content: "hello" }],
  outputSchema: {
    name: "thing",
    schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
};

function stubClient(
  events: unknown[],
  final: unknown,
  onBody?: (body: unknown) => void,
): AnthropicLike {
  return {
    beta: {
      messages: {
        stream(body: unknown): MessageStreamLike {
          onBody?.(body);
          return {
            async *[Symbol.asyncIterator]() {
              for (const event of events) yield event;
            },
            finalMessage: async () => final,
          };
        },
      },
    },
  };
}

function textEvent(text: string): unknown {
  return { type: "content_block_delta", delta: { type: "text_delta", text } };
}

function provider(client: AnthropicLike): AnthropicProvider {
  return new AnthropicProvider({ apiKey: "unused", client });
}

describe("streaming", () => {
  it("relays text deltas and then the final message", async () => {
    const client = stubClient(
      [textEvent('{"a":'), textEvent('"b"}')],
      {
        model: "claude-opus-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: '{"a":"b"}' }],
        usage: { input_tokens: 10, output_tokens: 4 },
      },
    );

    const seen: ProviderEvent[] = [];
    for await (const event of provider(client).generate(REQUEST)) seen.push(event);

    expect(seen.map((event) => event.type)).toEqual(["start", "text", "text", "message"]);
    expect(seen.filter((e): e is Extract<ProviderEvent, { type: "text" }> => e.type === "text")
      .map((e) => e.text)).toEqual(['{"a":', '"b"}']);
  });

  it("does not relay thinking as output", async () => {
    // Reasoning is not output. Concatenating a thinking delta into the JSON
    // about to be parsed would corrupt every document the model reasons about.
    const client = stubClient(
      [
        { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
        textEvent("{}"),
      ],
      { stop_reason: "end_turn", content: [{ type: "text", text: "{}" }] },
    );

    const texts: string[] = [];
    for await (const event of provider(client).generate(REQUEST)) {
      if (event.type === "text") texts.push(event.text);
    }
    expect(texts).toEqual(["{}"]);
  });

  it("skips empty deltas rather than emitting a no-op progress event", async () => {
    const client = stubClient(
      [textEvent(""), textEvent("x")],
      { stop_reason: "end_turn", content: [{ type: "text", text: "x" }] },
    );
    const texts: string[] = [];
    for await (const event of provider(client).generate(REQUEST)) {
      if (event.type === "text") texts.push(event.text);
    }
    expect(texts).toEqual(["x"]);
  });

  it("ignores stream events it does not recognise", async () => {
    const client = stubClient(
      [{ type: "message_start" }, { type: "content_block_stop" }, null, "junk", textEvent("x")],
      { stop_reason: "end_turn", content: [{ type: "text", text: "x" }] },
    );
    const message = await collect(provider(client), REQUEST);
    expect(message.text).toBe("x");
  });
});

describe("the request it sends", () => {
  it("hands the client the wire body, breakpoint and all", async () => {
    let body: unknown;
    const client = stubClient([], { stop_reason: "end_turn", content: [] }, (sent) => {
      body = sent;
    });

    await collect(provider(client), REQUEST);

    expect(body).toMatchObject({
      model: "claude-opus-5",
      max_tokens: 32_000,
      system: [
        { type: "text", text: "instructions", cache_control: { type: "ephemeral" } },
      ],
      fallbacks: "default",
    });
  });
});

describe("failures", () => {
  it("wraps a transport throw as a ProviderError carrying the status", async () => {
    const client: AnthropicLike = {
      beta: {
        messages: {
          stream(): MessageStreamLike {
            throw Object.assign(new Error("rate limited"), { status: 429 });
          },
        },
      },
    };

    let thrown: unknown;
    try {
      await collect(provider(client), REQUEST);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProviderError);
    expect((thrown as ProviderError).code).toBe("transport");
    expect((thrown as ProviderError).details["status"]).toBe(429);
  });

  it("wraps a failure part-way through the stream", async () => {
    const client: AnthropicLike = {
      beta: {
        messages: {
          stream(): MessageStreamLike {
            return {
              async *[Symbol.asyncIterator]() {
                yield textEvent("partial");
                throw new Error("connection reset");
              },
              finalMessage: async () => ({}),
            };
          },
        },
      },
    };

    await expect(collect(provider(client), REQUEST)).rejects.toThrow(ProviderError);
  });

  it("reports a stream that ends with no message rather than returning undefined", async () => {
    const provider: AnthropicLike = {
      beta: {
        messages: {
          stream(): MessageStreamLike {
            return {
              // A stream that ends immediately, yielding nothing.
              async *[Symbol.asyncIterator](): AsyncIterator<never> {
                return;
              },
              finalMessage: async () => {
                throw new Error("no message");
              },
            };
          },
        },
      },
    };
    await expect(
      collect(new AnthropicProvider({ apiKey: "unused", client: provider }), REQUEST),
    ).rejects.toThrow(ProviderError);
  });
});

describe("capabilities", () => {
  it("declares strict structured output, which stage 3 deliberately does not rely on", () => {
    const anthropic = provider(stubClient([], {}));
    expect(anthropic.capabilities.strictStructuredOutput).toBe(true);
    expect(anthropic.capabilities.promptCaching).toBe("prefix");
    expect(anthropic.capabilities.serverSideFallback).toBe(true);
    expect(anthropic.key).toBe("anthropic");
  });
});
