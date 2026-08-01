/**
 * The `ModelProvider` interface and its vocabulary.
 *
 * Transcribed from the provider abstraction in docs/AI_SPEC.md. Anthropic is the
 * only implementation at launch and the interface exists anyway, because
 * swapping providers is not a driver swap: a capability difference changes what
 * the pipeline has to do, so it is declared rather than assumed. That is the
 * same reason `TargetCapabilities` exists in the compiler, and the two are
 * deliberately the same shape of idea.
 *
 * | Capability | If false |
 * | --- | --- |
 * | `strictStructuredOutput` | Stage 3's name check becomes load-bearing rather than belt-and-braces. Expect a higher repair rate. |
 * | `promptCaching` | The inline catalog stops being nearly free and retrieval should switch to tool search sooner. |
 * | `streamingPartialJson` | Loading UI falls back to coarse stage transitions instead of live node labels. |
 * | `serverSideFallback` | Refusal handling becomes a client-side retry against a second provider. |
 *
 * ## Why generation is an async iterable
 *
 * Every generation call is streamed. Above roughly 16k `max_tokens` a
 * non-streaming request risks an SDK HTTP timeout, and 32000 is the floor for a
 * generation call, so streaming is not optional. It is also what makes the real
 * loading stages possible: the design system asks for sequential progress text,
 * and the honest way to produce it is from the actual position of the stream
 * rather than from a timer.
 */

/**
 * Why the model stopped.
 *
 * A closed set, and `refusal` is the member that matters: a safety classifier
 * can decline with an empty or partial content array, so code that reads the
 * text without checking this first will throw on the day it happens rather than
 * on the day it is written.
 */
export const STOP_REASONS = [
  "end_turn",
  "max_tokens",
  "refusal",
  "stop_sequence",
  "tool_use",
  "pause_turn",
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/** Reasoning depth and overall token spend. Starts at `high`; the main cost lever. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export interface ProviderCapabilities {
  /** `additionalProperties: false` is actually enforced by the API. */
  strictStructuredOutput: boolean;
  promptCaching: "prefix" | "none";
  toolUse: boolean;
  maxContextTokens: number;
  /** Drives live progress in the UI. */
  streamingPartialJson: boolean;
  serverSideFallback: boolean;
}

/**
 * One block of the system prompt.
 *
 * Split into blocks rather than concatenated because the cache breakpoint is
 * placed on a block boundary, and where it goes is a design decision worth
 * being able to see in the request rather than inferring from a string.
 */
export interface SystemBlock {
  text: string;
  /**
   * Marks the end of the cacheable prefix. At most one block carries it, and it
   * is the last one: render order is tools, then system, then messages, so a
   * breakpoint on the final system block caches the instructions and the
   * capability catalog together.
   */
  cache?: boolean;
}

export interface RequestMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * A JSON Schema value, as far as this package models one.
 *
 * Deliberately structural rather than a faithful JSON Schema type. The schemas
 * this package builds use a small, closed subset, and the subset is the point:
 * structured outputs rejects `pattern`, `minLength`, and `minimum`, so a type
 * permissive enough to express them would invite writing one.
 */
export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: JsonSchema;
  enum?: readonly (string | number | boolean | null)[];
}

/** A closed object schema. What both passes constrain their output to. */
export interface OutputSchema {
  /** Names the schema for the provider and for tracing. */
  name: string;
  schema: JsonSchema;
}

export interface GenerationRequest {
  model: string;
  /** In render order. The last block normally carries the cache breakpoint. */
  system: readonly SystemBlock[];
  /**
   * The conversation. A list rather than one prompt because repair is a
   * continuation of the existing conversation rather than a fresh request,
   * which is what preserves the cached prefix and the reasoning already done.
   */
  messages: readonly RequestMessage[];
  /** Caps thinking plus output together. 32000 is the floor for a generation call. */
  maxTokens: number;
  effort?: Effort;
  outputSchema?: OutputSchema;
}

/**
 * Token accounting for one call.
 *
 * `cacheReadInputTokens` is here because it is the only way to know the cached
 * prefix is working. If it is zero across repeated requests something in the
 * prefix is varying, and the failure is otherwise silent: the requests still
 * succeed, they just cost ten times more than they should.
 */
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export function emptyUsage(): ProviderUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}

/** Populated only when `stopReason` is `"refusal"`. Absent for every other reason. */
export interface StopDetails {
  category?: string | null;
  explanation?: string;
}

export interface ProviderMessage {
  /** The model that actually produced this, which a fallback can change. */
  model: string;
  stopReason: StopReason;
  /** The concatenated text output. Empty on a refusal that produced nothing. */
  text: string;
  usage: ProviderUsage;
  stopDetails?: StopDetails;
}

/**
 * What a generation emits as it runs.
 *
 * `text` carries incremental output so a caller can parse partial JSON and show
 * node labels as the model writes them. A provider without
 * `streamingPartialJson` is free to emit one `text` event holding everything,
 * which is why the capability is declared: the consumer's behaviour differs.
 */
export type ProviderEvent =
  | { type: "start"; model: string }
  | { type: "text"; text: string }
  | { type: "message"; message: ProviderMessage };

export interface ModelProvider {
  /** `"anthropic" | "replay" | ...`. Recorded on the generation. */
  readonly key: string;
  readonly capabilities: ProviderCapabilities;
  generate(request: GenerationRequest): AsyncIterable<ProviderEvent>;
}

/**
 * The closed set of provider failure codes.
 *
 * Closed because the retry ladder switches on it, and a ladder that can be
 * handed a code it has no rung for silently falls through to the terminal arm.
 */
export const PROVIDER_ERROR_CODES = [
  /** The stream ended without a final message. A bug in the provider adapter. */
  "no_message",
  /** A safety classifier declined. Handled by server-side fallback, not by repair. */
  "refusal",
  /** Output hit the cap. Retried once with `maxTokens` doubled. */
  "max_tokens",
  /** The transport failed: network, 429, 5xx. */
  "transport",
  /** Neither the tenant nor the platform has credentials for this provider. */
  "credentials_missing",
  /** The fixture set has no recording for this request. Replay only. */
  "no_fixture",
] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

/**
 * A provider failure.
 *
 * Thrown rather than returned, unlike the compiler's `CompileResult`, because a
 * provider call is I/O and the transport underneath it throws anyway. Pretending
 * otherwise would mean every caller handles two failure channels.
 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: ProviderErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Drains a generation to its final message.
 *
 * The convenience every caller that does not render live progress wants, kept
 * in one place so "the stream ended without a message" is diagnosed identically
 * everywhere rather than surfacing as `undefined` three frames later.
 */
export async function collect(
  provider: ModelProvider,
  request: GenerationRequest,
  onEvent?: (event: ProviderEvent) => void,
): Promise<ProviderMessage> {
  let message: ProviderMessage | undefined;
  for await (const event of provider.generate(request)) {
    onEvent?.(event);
    if (event.type === "message") message = event.message;
  }

  if (message === undefined) {
    throw new ProviderError(
      "no_message",
      `Provider "${provider.key}" produced no final message for model ${request.model}.`,
      { provider: provider.key, model: request.model },
    );
  }
  return message;
}
