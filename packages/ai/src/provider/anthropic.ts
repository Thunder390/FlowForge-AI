/**
 * The Anthropic `ModelProvider`.
 *
 * Deliberately thin. Everything that constitutes a decision, which parameters
 * are set and how a finished message is read, lives in `anthropic-wire.ts` as
 * pure functions with their own tests. What is left here is the part that
 * cannot be tested without a network: construct a client, open a stream, relay
 * it.
 *
 * ## Capabilities
 *
 * All six are declared rather than assumed, and the two that change pipeline
 * behaviour are `strictStructuredOutput` and `serverSideFallback`. The first is
 * why the synthesized pass B schema can be trusted to make an invented
 * parameter name structurally impossible; the independent name check in stage 3
 * exists precisely because that guarantee belongs to this provider rather than
 * to the architecture.
 *
 * ## Retries
 *
 * The SDK retries 408, 409, 429, and 5xx with exponential backoff, which is the
 * first rung of the retry ladder and needs no code here. The rungs above it,
 * doubling `maxTokens` on truncation and the repair prompt, belong to the
 * orchestrator because they change the request rather than repeat it.
 */

import Anthropic from "@anthropic-ai/sdk";

import {
  buildRequest,
  toProviderMessage,
  type BuildOptions,
} from "./anthropic-wire.js";
import {
  ProviderError,
  type GenerationRequest,
  type ModelProvider,
  type ProviderCapabilities,
  type ProviderEvent,
} from "./types.js";

export const ANTHROPIC_PROVIDER_KEY = "anthropic";

export const ANTHROPIC_CAPABILITIES: ProviderCapabilities = {
  strictStructuredOutput: true,
  promptCaching: "prefix",
  toolUse: true,
  maxContextTokens: 1_000_000,
  streamingPartialJson: true,
  serverSideFallback: true,
};

export interface AnthropicProviderOptions extends BuildOptions {
  apiKey: string;
  /** Overridden for a gateway or a compatible endpoint. */
  baseURL?: string;
  /** Injected in tests. Defaults to a client built from the options above. */
  client?: AnthropicLike;
}

/**
 * The one method this provider uses.
 *
 * Named structurally so a test can supply a stub without constructing a real
 * client and without this module needing a second code path for test mode.
 */
export interface AnthropicLike {
  beta: {
    messages: {
      stream(body: unknown): MessageStreamLike;
    };
  };
}

export interface MessageStreamLike extends AsyncIterable<unknown> {
  finalMessage(): Promise<unknown>;
}

export class AnthropicProvider implements ModelProvider {
  readonly key = ANTHROPIC_PROVIDER_KEY;
  readonly capabilities = ANTHROPIC_CAPABILITIES;

  readonly #client: AnthropicLike;
  readonly #build: BuildOptions;

  constructor(options: AnthropicProviderOptions) {
    this.#client =
      options.client ??
      (new Anthropic({
        apiKey: options.apiKey,
        ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      }) as unknown as AnthropicLike);

    this.#build = {
      ...(options.summarizeThinking === undefined
        ? {}
        : { summarizeThinking: options.summarizeThinking }),
      ...(options.serverSideFallback === undefined
        ? {}
        : { serverSideFallback: options.serverSideFallback }),
    };
  }

  async *generate(request: GenerationRequest): AsyncIterable<ProviderEvent> {
    // The body is built to the documented wire shape rather than to the SDK's
    // parameter types, so `anthropic-wire.ts` stays testable without importing
    // the SDK. This is the single cast that reconciles the two.
    const body = buildRequest(request, this.#build);

    let stream: MessageStreamLike;
    try {
      stream = this.#client.beta.messages.stream(body);
    } catch (cause) {
      throw transportError(request, cause);
    }

    yield { type: "start", model: request.model };

    try {
      for await (const event of stream) {
        const text = textDelta(event);
        if (text !== undefined && text !== "") yield { type: "text", text };
      }

      const final = await stream.finalMessage();
      yield {
        type: "message",
        message: toProviderMessage(final as never, request.model),
      };
    } catch (cause) {
      throw transportError(request, cause);
    }
  }
}

/**
 * Reads the text out of one stream event.
 *
 * Structural rather than typed against the SDK's event union, because the union
 * is large, most of it concerns features this provider does not use, and the
 * one shape that matters here is stable. A `thinking_delta` is deliberately not
 * matched: reasoning is not output, and concatenating it into the JSON about to
 * be parsed would corrupt it.
 */
function textDelta(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const candidate = event as { type?: unknown; delta?: { type?: unknown; text?: unknown } };
  if (candidate.type !== "content_block_delta") return undefined;
  if (candidate.delta?.type !== "text_delta") return undefined;
  return typeof candidate.delta.text === "string" ? candidate.delta.text : undefined;
}

function transportError(request: GenerationRequest, cause: unknown): ProviderError {
  const status = (cause as { status?: unknown } | null)?.status;
  return new ProviderError(
    "transport",
    `The model provider call failed for ${request.model}: ${
      cause instanceof Error ? cause.message : String(cause)
    }`,
    {
      model: request.model,
      ...(typeof status === "number" ? { status } : {}),
    },
  );
}
