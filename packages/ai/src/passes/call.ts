/**
 * The one place a pass turns a provider call into typed data.
 *
 * Both passes do the same three things in the same order and each of them has a
 * way of going wrong that is easy to skip: check the stop reason *before*
 * reading the text, parse, then validate against the schema the request was
 * constrained to. Writing that twice would mean one of the copies eventually
 * reads `content` without checking first, which is exactly the line that throws
 * the day a safety classifier declines.
 */

import { collect, ProviderError, type GenerationRequest, type ModelProvider } from "../provider/types.js";
import { parseStructured } from "../structured.js";
import type { ProviderEvent, ProviderMessage } from "../provider/types.js";

export interface StructuredCall<T> {
  value: T;
  message: ProviderMessage;
}

/**
 * Runs a request whose output is constrained to a schema.
 *
 * A refusal and a truncation are raised as distinct codes because the ladder
 * treats them differently: a refusal is answered by the server-side fallback,
 * and a truncation by retrying once with `maxTokens` doubled. Collapsing them
 * into one failure would make both unrecoverable.
 */
export async function callStructured<T>(
  provider: ModelProvider,
  request: GenerationRequest,
  onEvent?: (event: ProviderEvent) => void,
): Promise<StructuredCall<T>> {
  if (request.outputSchema === undefined) {
    throw new ProviderError(
      "no_message",
      "A structured call needs an output schema. This is a bug in the calling pass, not a model failure.",
      { model: request.model },
    );
  }

  const message = await collect(provider, request, onEvent);

  if (message.stopReason === "refusal") {
    throw new ProviderError(
      "refusal",
      `The model declined this request${
        message.stopDetails?.category == null
          ? ""
          : ` (${message.stopDetails.category})`
      }. Content is empty or partial and must not be read.`,
      {
        model: message.model,
        ...(message.stopDetails === undefined ? {} : { stopDetails: message.stopDetails }),
      },
    );
  }

  if (message.stopReason === "max_tokens") {
    throw new ProviderError(
      "max_tokens",
      `The model hit the ${request.maxTokens} token cap before finishing. The output is truncated and cannot be parsed.`,
      { model: message.model, maxTokens: request.maxTokens },
    );
  }

  const value = parseStructured<T>(
    message.text,
    request.outputSchema.schema,
    request.outputSchema.name,
  );

  return { value, message };
}
