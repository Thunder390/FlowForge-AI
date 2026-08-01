/**
 * One error vocabulary across four layers.
 *
 * The compiler has `CompileError`, `ffir` and `registry` have `ValidationError`
 * with its own code enum, `ai` throws `ProviderError` and `OutputError`, and
 * the API will have an error envelope. Three or four independent error
 * dictionaries is how a support conversation becomes archaeology, so everything
 * that can fail a generation reconciles here into one shape.
 *
 * The reconciliation deliberately does not renumber anything. Each failure
 * carries the originating code unchanged, because that code is what is written
 * in the specs, printed in the repair prompt, and searched for in a log. What
 * this file adds is the two things a caller actually needs and no single
 * vocabulary provides: which stage produced it, and whether trying again could
 * possibly help.
 */

import { ERROR_CLASS, type ValidationError } from "@flowforge/ffir";
import type { CompileError } from "@flowforge/compiler";
import { describeCompileError, nodeIdOf } from "@flowforge/compiler";
import { OutputError, ProviderError } from "@flowforge/ai";

import type { Stage } from "./stages.js";

/**
 * What the orchestrator should do next.
 *
 * | Recovery | Meaning |
 * | --- | --- |
 * | `repair` | Feed the failure back to the model and retry. |
 * | `retry` | Repeat the same request; the failure was transient. |
 * | `fallback` | Route to another model. A refusal, not a mistake. |
 * | `terminal` | Nothing to try. Report it. |
 */
export const RECOVERIES = ["repair", "retry", "fallback", "terminal"] as const;
export type Recovery = (typeof RECOVERIES)[number];

export interface GenerationFailure {
  stage: Stage;
  /** The originating vocabulary's code, unchanged. */
  code: string;
  message: string;
  recovery: Recovery;
  /** Present when the failure points at one node. */
  nodeId?: string;
  /** RFC 6901 pointer into the document, when the failure came from a validator. */
  path?: string;
  details?: Record<string, unknown>;
}

/**
 * A validation failure.
 *
 * `recovery` comes from `ffir`'s own `ERROR_CLASS`, which already distinguishes
 * terminal from repairable and marks the subset that indicates the model
 * ignored an explicit prompt instruction. That last distinction is a
 * prompt-quality signal rather than a different action, so it maps to `repair`
 * like any other repairable failure and stays visible through the code.
 */
export function fromValidationError(
  stage: Stage,
  error: ValidationError,
): GenerationFailure {
  const nodeId = error.details?.["node_id"];
  return {
    stage,
    code: error.code,
    message: error.message,
    recovery: ERROR_CLASS[error.code] === "terminal" ? "terminal" : "repair",
    ...(typeof nodeId === "string" ? { nodeId } : {}),
    ...(error.path === "" ? {} : { path: error.path }),
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

/**
 * A compile failure.
 *
 * Every stage except `verify` is the workflow's problem and can be repaired. A
 * `verify` failure means our own emitter produced something structurally wrong,
 * which no amount of asking the model to try again will fix, and which should
 * page someone rather than loop.
 */
export function fromCompileError(error: CompileError): GenerationFailure {
  const nodeId = nodeIdOf(error);
  return {
    stage: "compile",
    code: error.code,
    message: describeCompileError(error),
    recovery: error.stage === "verify" ? "terminal" : "repair",
    ...(nodeId === undefined ? {} : { nodeId }),
    details: { compileStage: error.stage },
  };
}

/** How each provider failure is answered. See the retry ladder in AI_SPEC.md. */
const PROVIDER_RECOVERY: Record<string, Recovery> = {
  refusal: "fallback",
  max_tokens: "retry",
  transport: "retry",
  no_message: "terminal",
  no_fixture: "terminal",
  credentials_missing: "terminal",
};

/**
 * Anything thrown during a stage.
 *
 * Provider and output errors are recognised and mapped; anything else is an
 * unexpected throw and is reported as terminal under a code that says so. A
 * bug should not be silently retried three times.
 */
export function fromThrown(stage: Stage, thrown: unknown): GenerationFailure {
  if (thrown instanceof ProviderError) {
    return {
      stage,
      code: thrown.code,
      message: thrown.message,
      recovery: PROVIDER_RECOVERY[thrown.code] ?? "terminal",
      ...(Object.keys(thrown.details).length === 0 ? {} : { details: thrown.details }),
    };
  }

  if (thrown instanceof OutputError) {
    return {
      stage,
      code: thrown.code,
      message: thrown.message,
      // The model produced something that did not fit the shape it was given,
      // which is exactly what the repair prompt is for.
      recovery: "repair",
      details: { schema: thrown.schemaName, issues: thrown.issues },
    };
  }

  return {
    stage,
    code: "unexpected_error",
    message: thrown instanceof Error ? thrown.message : String(thrown),
    recovery: "terminal",
  };
}

/** True when every failure is terminal, so no retry ladder rung applies. */
export function isTerminal(failures: readonly GenerationFailure[]): boolean {
  return failures.length > 0 && failures.every((failure) => failure.recovery === "terminal");
}
