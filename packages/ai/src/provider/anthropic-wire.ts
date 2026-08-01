/**
 * The Anthropic wire format, as pure functions.
 *
 * Split out of `anthropic.ts` so that everything load-bearing about the request
 * is testable without a network call or an SDK client: where the cache
 * breakpoint lands, which parameters are set, which are deliberately absent,
 * and how a finished message becomes a `ProviderMessage`. The adapter that
 * remains is a thin loop over a stream.
 *
 * ## Parameters that are absent on purpose
 *
 * `temperature`, `top_p`, and `top_k` are removed on Opus 5 and return a 400.
 * Steering happens through prompting and through `effort`.
 *
 * `thinking` is omitted, which on Opus 5 runs adaptive thinking: it is on by
 * default there, unlike the 4.x family where omitting it meant no thinking.
 * `budget_tokens` was removed and also returns a 400, so there is no budget to
 * set. `display` is offered as an option because the default is `"omitted"`,
 * and a UI that streams reasoning shows a long unexplained pause under it.
 *
 * ## max_tokens caps thinking and output together
 *
 * Sizing it tightly around the expected document truncates mid-generation. The
 * floor for a generation call is 32000, and every call is streamed, because a
 * non-streaming request much above 16000 risks an SDK HTTP timeout.
 */

import {
  emptyUsage,
  type Effort,
  type GenerationRequest,
  type JsonSchema,
  type ProviderMessage,
  type ProviderUsage,
  type StopReason,
  STOP_REASONS,
} from "./types.js";

/** The models this build targets, from the role table in AI_SPEC.md. */
export const MODELS = {
  /** Graph reasoning, strict schemas, repair. Quality matters on all three. */
  generation: "claude-opus-5",
  /** The completeness classifier: cheap, fast, a binary decision. */
  classifier: "claude-haiku-4-5",
} as const;

/** The floor for a generation call. `max_tokens` caps thinking plus output. */
export const GENERATION_MAX_TOKENS = 32_000;

/** Sweeping `medium` and `low` against the eval set is the main cost lever. */
export const DEFAULT_EFFORT: Effort = "high";

/**
 * The beta that enables `fallbacks: "default"`.
 *
 * The scalar form routes by refusal category rather than pinning a substitute
 * model, which is the difference that matters: the right fallback depends on
 * why a request was declined, and a pinned model becomes a migration the day it
 * is deprecated.
 */
export const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  system: AnthropicSystemBlock[];
  messages: { role: "user" | "assistant"; content: string }[];
  output_config?: {
    effort?: Effort;
    format?: { type: "json_schema"; schema: JsonSchema };
  };
  thinking?: { type: "adaptive"; display: "summarized" };
  betas?: string[];
  fallbacks?: "default";
}

export interface BuildOptions {
  /**
   * Surfaces summarized reasoning. Off by default: the API default is
   * `"omitted"`, and nothing consumes reasoning until the UI does.
   */
  summarizeThinking?: boolean;
  /**
   * Opts into server-side fallback on a refusal. On by default, because a
   * declined request otherwise just stops, and routing it to another model
   * server-side recovers it in one round trip with no client-side ladder.
   */
  serverSideFallback?: boolean;
}

/**
 * Builds the request body.
 *
 * The cache breakpoint is placed by the caller, on a `SystemBlock`, and this
 * function only transcribes it. That keeps the decision where it is legible:
 * pass A puts it after the capability catalog, pass B after the instruction
 * block and before the per-workflow schema bundle.
 */
export function buildRequest(
  request: GenerationRequest,
  options: BuildOptions = {},
): AnthropicRequestBody {
  const body: AnthropicRequestBody = {
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.system.map((block) => ({
      type: "text",
      text: block.text,
      ...(block.cache === true ? { cache_control: { type: "ephemeral" as const } } : {}),
    })),
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  };

  const outputConfig: NonNullable<AnthropicRequestBody["output_config"]> = {};
  if (request.effort !== undefined) outputConfig.effort = request.effort;
  if (request.outputSchema !== undefined) {
    outputConfig.format = { type: "json_schema", schema: request.outputSchema.schema };
  }
  if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig;

  if (options.summarizeThinking === true) {
    body.thinking = { type: "adaptive", display: "summarized" };
  }

  if (options.serverSideFallback !== false) {
    body.betas = [SERVER_SIDE_FALLBACK_BETA];
    body.fallbacks = "default";
  }

  return body;
}

/** The subset of a finished message this package reads. */
export interface AnthropicMessageLike {
  model?: string;
  stop_reason?: string | null;
  stop_details?: { category?: string | null; explanation?: string } | null;
  content?: readonly { type?: string; text?: string }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

/**
 * Maps a finished message onto the provider vocabulary.
 *
 * Only `text` blocks contribute to the text. A response can also carry a
 * `fallback` block marking the point where one model declined and another
 * continued, and concatenating that into the JSON we are about to parse would
 * corrupt it.
 */
export function toProviderMessage(
  message: AnthropicMessageLike,
  fallbackModel: string,
): ProviderMessage {
  const stopReason = toStopReason(message.stop_reason);
  const result: ProviderMessage = {
    model: message.model ?? fallbackModel,
    stopReason,
    text: textOf(message),
    usage: toUsage(message.usage),
  };

  // Populated only on a refusal, and `null` for every other stop reason, so it
  // is forwarded only where it means something.
  if (stopReason === "refusal" && message.stop_details != null) {
    result.stopDetails = message.stop_details;
  }
  return result;
}

export function textOf(message: AnthropicMessageLike): string {
  return (message.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
}

/**
 * A `null` stop reason means the message was still being written; an
 * unrecognised one comes from an API newer than this build. Both fall back to
 * `end_turn` rather than throwing, because the response is validated against a
 * closed schema immediately afterwards and a genuinely broken one fails there
 * with a message about the document rather than about our enum.
 */
export function toStopReason(raw: string | null | undefined): StopReason {
  if (raw == null) return "end_turn";
  return (STOP_REASONS as readonly string[]).includes(raw)
    ? (raw as StopReason)
    : "end_turn";
}

function toUsage(usage: AnthropicMessageLike["usage"]): ProviderUsage {
  if (usage === undefined) return emptyUsage();
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
  };
}
