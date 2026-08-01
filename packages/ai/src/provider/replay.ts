/**
 * The replay provider: recorded model responses, played back for CI.
 *
 * Everything below M9 is tested against this. A pipeline that can only be
 * exercised by spending money on a live model is a pipeline nobody runs on
 * every commit, and generation is exactly the layer where a regression is
 * cheapest to catch early and most expensive to catch late.
 *
 * ## Matching is by request digest, not by call order
 *
 * A sequential fixture set, first call gets the first recording, is quietly
 * wrong the moment two passes are reordered or a retry is inserted: every
 * subsequent call is served the wrong recording and the test still passes. A
 * digest over the canonical request cannot do that. Either the request is the
 * one that was recorded or the lookup fails and says so.
 *
 * The digest covers the model, the system blocks including where the cache
 * breakpoint sits, the messages, and the output schema. It deliberately covers
 * the schema: pass B's schema is synthesized per workflow, so a recording made
 * for one set of node ids must not be served to another.
 *
 * ## The stream is chunked
 *
 * A recording plays back as several `text` events rather than one, because the
 * consumer parses partial JSON to drive live progress and a provider that hands
 * over the whole document at once would never exercise that path.
 */

import { createHash } from "node:crypto";

import {
  emptyUsage,
  ProviderError,
  type GenerationRequest,
  type ModelProvider,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderMessage,
  type ProviderUsage,
  type StopReason,
} from "./types.js";

export const REPLAY_PROVIDER_KEY = "replay";

/**
 * What a recording says the model returned.
 *
 * `stopReason` defaults to `end_turn` and `usage` to zeros, so an ordinary
 * recording is three fields. A fixture exercising refusal or truncation sets
 * `stopReason` explicitly, which is the case worth being able to write.
 */
export interface RecordedResponse {
  text: string;
  stopReason?: StopReason;
  usage?: Partial<ProviderUsage>;
  model?: string;
}

export interface RecordedExchange {
  /** A readable name. Reported when a lookup misses, so the set reads as a script. */
  id: string;
  request: GenerationRequest;
  response: RecordedResponse;
}

export interface ReplayProviderOptions {
  /** Characters per `text` event. Fixed so a stream replays identically every run. */
  chunkSize?: number;
  capabilities?: Partial<ProviderCapabilities>;
}

export const REPLAY_CAPABILITIES: ProviderCapabilities = {
  strictStructuredOutput: true,
  promptCaching: "prefix",
  toolUse: true,
  maxContextTokens: 1_000_000,
  streamingPartialJson: true,
  serverSideFallback: false,
};

const DEFAULT_CHUNK_SIZE = 96;

export class ReplayProvider implements ModelProvider {
  readonly key = REPLAY_PROVIDER_KEY;
  readonly capabilities: ProviderCapabilities;

  readonly #byDigest = new Map<string, RecordedExchange>();
  readonly #chunkSize: number;

  /**
   * Every request this provider was asked for, in order.
   *
   * Exposed because the most useful assertions about a generation are about
   * what was *asked*: that the catalog sat behind a cache breakpoint, that pass
   * B's schema named exactly the nodes pass A planned, that a repair reused the
   * conversation rather than starting a new one.
   */
  readonly calls: GenerationRequest[] = [];

  constructor(
    exchanges: readonly RecordedExchange[],
    options: ReplayProviderOptions = {},
  ) {
    this.capabilities = { ...REPLAY_CAPABILITIES, ...options.capabilities };
    this.#chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;

    for (const exchange of exchanges) {
      const digest = digestRequest(exchange.request);
      const clash = this.#byDigest.get(digest);
      if (clash !== undefined) {
        // Two recordings for one request means the set cannot say which is
        // meant, and silently keeping the last would make the fixture order
        // load-bearing in a set whose whole point is that it is not.
        throw new ProviderError(
          "no_fixture",
          `Fixtures "${clash.id}" and "${exchange.id}" record the same request (${digest}). Give them different requests or drop one.`,
          { digest, ids: [clash.id, exchange.id] },
        );
      }
      this.#byDigest.set(digest, exchange);
    }
  }

  async *generate(request: GenerationRequest): AsyncIterable<ProviderEvent> {
    this.calls.push(request);

    const digest = digestRequest(request);
    const exchange = this.#byDigest.get(digest);
    if (exchange === undefined) {
      throw new ProviderError("no_fixture", describeMiss(request, digest, this.#byDigest), {
        digest,
        model: request.model,
        schema: request.outputSchema?.name,
        known: [...this.#byDigest.values()].map((known) => known.id),
      });
    }

    const model = exchange.response.model ?? request.model;
    yield { type: "start", model };

    for (const chunk of chunks(exchange.response.text, this.#chunkSize)) {
      yield { type: "text", text: chunk };
    }

    const message: ProviderMessage = {
      model,
      stopReason: exchange.response.stopReason ?? "end_turn",
      text: exchange.response.text,
      usage: { ...emptyUsage(), ...exchange.response.usage },
    };
    yield { type: "message", message };
  }
}

/**
 * A stable fingerprint of everything about a request that changes the answer.
 *
 * Exported because it is also how a recording is authored: build the request
 * the pass would build, digest it, and the fixture matches by construction
 * rather than by a hash pasted from a failing test.
 */
export function digestRequest(request: GenerationRequest): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        model: request.model,
        maxTokens: request.maxTokens,
        effort: request.effort ?? null,
        system: request.system.map((block) => ({
          text: block.text,
          cache: block.cache === true,
        })),
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        outputSchema:
          request.outputSchema === undefined
            ? null
            : { name: request.outputSchema.name, schema: request.outputSchema.schema },
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

/**
 * JSON with object keys in sorted order.
 *
 * `JSON.stringify` preserves insertion order, so two structurally identical
 * schemas built by different code paths would otherwise digest differently and
 * a fixture would miss for no reason a reader could see.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function chunks(text: string, size: number): string[] {
  if (text === "") return [];
  const out: string[] = [];
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size));
  return out;
}

/**
 * The message a missing fixture produces.
 *
 * Written to be actionable on its own, because this is the error a prompt
 * change surfaces as and "no fixture found" without naming what was asked
 * sends the reader to a debugger.
 */
function describeMiss(
  request: GenerationRequest,
  digest: string,
  known: ReadonlyMap<string, RecordedExchange>,
): string {
  const ids = [...known.values()].map((exchange) => exchange.id);
  const schema = request.outputSchema?.name ?? "none";
  return (
    `No recorded response for this request (digest ${digest}, model ${request.model}, schema ${schema}). ` +
    `The fixture set holds: ${ids.length === 0 ? "nothing" : ids.join(", ")}. ` +
    `A prompt, catalog, or schema change alters the digest, so this usually means a recording needs regenerating rather than that the request is wrong.`
  );
}
