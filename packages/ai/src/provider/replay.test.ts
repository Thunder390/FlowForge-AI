/**
 * The replay provider is what every test below M9 stands on, so its own
 * failure modes matter more than most.
 *
 * The one that would be worst is a silent mismatch: serving a recording made
 * for a different request and letting a test pass on an answer that has nothing
 * to do with what was asked. Most of this file is about that not happening.
 */

import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  digestRequest,
  ReplayProvider,
  type RecordedExchange,
} from "./replay.js";
import { collect, ProviderError, type GenerationRequest } from "./types.js";

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    model: "claude-opus-5",
    maxTokens: 32_000,
    system: [{ text: "instructions" }, { text: "catalog", cache: true }],
    messages: [{ role: "user", content: "post to slack" }],
    outputSchema: {
      name: "plan",
      schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
    ...overrides,
  };
}

function exchange(id: string, req: GenerationRequest, text: string): RecordedExchange {
  return { id, request: req, response: { text } };
}

describe("digesting a request", () => {
  it("is stable across calls", () => {
    expect(digestRequest(request())).toBe(digestRequest(request()));
  });

  it("changes when anything the model would see changes", () => {
    const base = digestRequest(request());

    expect(digestRequest(request({ model: "claude-opus-4-8" }))).not.toBe(base);
    expect(digestRequest(request({ messages: [{ role: "user", content: "other" }] }))).not.toBe(base);
    expect(digestRequest(request({ system: [{ text: "different" }] }))).not.toBe(base);
    expect(digestRequest(request({ effort: "low" }))).not.toBe(base);
    expect(digestRequest(request({ maxTokens: 64_000 }))).not.toBe(base);
  });

  it("changes when the cache breakpoint moves", () => {
    // Same text, different caching. It is a different request to the API and
    // costs differently, so it must not be served the same recording.
    const moved = request({ system: [{ text: "instructions", cache: true }, { text: "catalog" }] });
    expect(digestRequest(moved)).not.toBe(digestRequest(request()));
  });

  it("changes when the output schema changes", () => {
    // Pass B's schema is synthesized per workflow. A recording made for one
    // set of node ids must never be served to another.
    const other = request({
      outputSchema: {
        name: "plan",
        schema: {
          type: "object",
          properties: { n_a: { type: "string" } },
          required: ["n_a"],
          additionalProperties: false,
        },
      },
    });
    expect(digestRequest(other)).not.toBe(digestRequest(request()));
  });
});

describe("canonical JSON", () => {
  it("sorts keys, so structurally identical values digest identically", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("preserves array order, which is meaningful", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("drops undefined members rather than emitting them", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("handles nesting and null", () => {
    expect(canonicalJson({ b: { d: null, c: [1] }, a: "x" })).toBe(
      '{"a":"x","b":{"c":[1],"d":null}}',
    );
  });
});

describe("replaying", () => {
  it("serves the recording made for that exact request", async () => {
    const provider = new ReplayProvider([exchange("one", request(), '{"ok":true}')]);
    const message = await collect(provider, request());
    expect(message.text).toBe('{"ok":true}');
    expect(message.stopReason).toBe("end_turn");
  });

  it("streams in chunks, so a partial-parse consumer is actually exercised", async () => {
    const text = "x".repeat(250);
    const provider = new ReplayProvider([exchange("one", request(), text)], {
      chunkSize: 100,
    });

    const chunks: string[] = [];
    for await (const event of provider.generate(request())) {
      if (event.type === "text") chunks.push(event.text);
    }
    expect(chunks.map((chunk) => chunk.length)).toEqual([100, 100, 50]);
    expect(chunks.join("")).toBe(text);
  });

  it("emits start, then text, then the message, in that order", async () => {
    const provider = new ReplayProvider([exchange("one", request(), "ab")], {
      chunkSize: 1,
    });
    const types: string[] = [];
    for await (const event of provider.generate(request())) types.push(event.type);
    expect(types).toEqual(["start", "text", "text", "message"]);
  });

  it("records what it was asked for", async () => {
    // The most useful assertions about a generation are about what was asked:
    // that the catalog sat behind a breakpoint, that pass B's schema named the
    // nodes pass A planned.
    const provider = new ReplayProvider([exchange("one", request(), "{}")]);
    await collect(provider, request());
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.system[1]?.cache).toBe(true);
  });

  it("replays a recorded refusal without inventing text", async () => {
    const provider = new ReplayProvider([
      { id: "declined", request: request(), response: { text: "", stopReason: "refusal" } },
    ]);
    const message = await collect(provider, request());
    expect(message.stopReason).toBe("refusal");
    expect(message.text).toBe("");
  });
});

describe("when a recording is missing", () => {
  it("fails loudly rather than serving something else", async () => {
    const provider = new ReplayProvider([exchange("one", request(), "{}")]);
    await expect(
      collect(provider, request({ messages: [{ role: "user", content: "different" }] })),
    ).rejects.toThrow(ProviderError);
  });

  it("says what was asked and what the set holds", async () => {
    // This is the error a prompt change surfaces as, so it has to be
    // actionable without a debugger.
    const provider = new ReplayProvider([exchange("onboarding/pass-a", request(), "{}")]);

    let thrown: unknown;
    try {
      await collect(provider, request({ model: "claude-opus-4-8" }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProviderError);
    const error = thrown as ProviderError;
    expect(error.code).toBe("no_fixture");
    expect(error.message).toContain("claude-opus-4-8");
    expect(error.message).toContain("onboarding/pass-a");
    expect(error.details["known"]).toEqual(["onboarding/pass-a"]);
  });
});

describe("building a fixture set", () => {
  it("rejects two recordings of the same request", () => {
    // Silently keeping the last would make fixture order load-bearing in a set
    // whose whole point is that it is not.
    expect(
      () =>
        new ReplayProvider([
          exchange("first", request(), "{}"),
          exchange("second", request(), "{}"),
        ]),
    ).toThrow(/record the same request/);
  });

  it("declares no server-side fallback, because a recording cannot have one", () => {
    const provider = new ReplayProvider([]);
    expect(provider.capabilities.serverSideFallback).toBe(false);
    expect(provider.capabilities.strictStructuredOutput).toBe(true);
  });
});
