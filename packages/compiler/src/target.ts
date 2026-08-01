/**
 * The `Target` interface: stages 4, 5, and 6 of the pipeline.
 *
 * Stages 1 through 3 are target-independent and every target shares them, which
 * is roughly two thirds of the compiler written once. Everything a platform
 * knows about itself lives behind this interface. The design goal the whole
 * architecture is subordinate to is that adding a platform must not require
 * touching the AI layer, and the concrete test of it is that adding one means
 * writing one implementation of this interface plus one key per capability in
 * the registry's `bindings` block. Nothing in `ai`, nothing in `ffir`, nothing
 * in the validator.
 *
 * This module is types only. No target implements it yet: the n8n target is
 * M6b. Defining the seam first is what forces stages 1 through 3 to be honestly
 * target-independent, because there is nothing concrete for them to lean on.
 */

import type { FFIRDocument } from "@flowforge/ffir";
import type { Registry } from "@flowforge/registry";

import type { CompileWarning } from "./errors.js";
import type { NormalizedGraph } from "./normalize.js";

/**
 * What a platform declares it can do.
 *
 * This is what makes honest failure possible. Before lowering, the compiler
 * compares what the document needs against what the target says it supports,
 * and a mismatch produces an error naming the exact node. The alternative,
 * silently flattening a branch into a linear sequence, produces a Zap that runs
 * both paths unconditionally: a data-corrupting bug delivered as a feature.
 */
export interface TargetCapabilities {
  /**
   * `full` is arbitrary branching, `router` is a single dispatch node with one
   * route per case, `linear_only` is no branching at all.
   */
  branching: "full" | "linear_only" | "router";
  loops: boolean;
  /** Whether a failure can be routed to a different node instead of stopping. */
  errorRouting: boolean;
  retryPolicy: boolean;
  /** Whether one node's output can fan out to several successors at once. */
  parallelBranches: boolean;
  expressionSyntax: "n8n" | "make" | "zapier" | "javascript";
  /** Absent means the platform imposes no node ceiling worth checking. */
  maxNodes?: number;
}

/**
 * A platform's own node and connection model, produced by stage 4.
 *
 * Opaque to everything above the target. Each target defines its own shape and
 * extends this; the compiler core only ever hands one back to the target that
 * produced it, so it needs to know nothing beyond provenance. Typing this as
 * the n8n workflow shape would put a platform detail in the shared half of the
 * compiler, which is the leak this interface exists to prevent.
 */
export interface PlatformIR {
  /** The `Target.key` that produced this. Checked by the driver, not by a target. */
  readonly target: string;
}

/** The serialized artifact, produced by stage 5. */
export interface EmitResult {
  readonly target: string;
  /** The platform's file format, already serialized. Stage 5 does nothing else. */
  readonly content: string;
}

/**
 * The outcome of stage 6's self-check.
 *
 * Failures are strings rather than codes because nobody but us reads them: a
 * failure here means the compiler has a bug, and the correct response is to
 * fail rather than hand the user a broken file.
 */
export type VerifyResult =
  | { ok: true }
  | { ok: false; failures: readonly string[] };

/**
 * What stages 4 and 5 are given besides the graph.
 *
 * `warn` exists because both stages can discover something worth telling the
 * user without having grounds to fail: an advisory loop bound, a trigger
 * mechanism the platform cannot honour. Returning warnings instead would make
 * every target thread an accumulator through its own call tree.
 */
export interface CompileContext {
  readonly doc: FFIRDocument;
  readonly registry: Registry;
  /** The target key being compiled for, which is also the registry binding key. */
  readonly target: string;
  /** Records a warning. Never blocks. */
  warn(warning: CompileWarning): void;
}

export interface Target {
  /** Also the key into the registry's `bindings` map. `"n8n"`, `"make"`, ... */
  readonly key: string;
  readonly displayName: string;
  /** Without the leading dot. `"json"`. */
  readonly fileExtension: string;

  readonly capabilities: TargetCapabilities;

  /** Stage 4. The normalized graph becomes the platform's own model. */
  lower(graph: NormalizedGraph, ctx: CompileContext): PlatformIR;

  /**
   * Stage 5. Deliberately dumb: key ordering and formatting, nothing else. All
   * decisions were made in stage 4. This is where determinism is enforced, so
   * an implementation that reaches for a clock or a random id has broken the
   * golden-file testing the whole strategy rests on.
   */
  emit(ir: PlatformIR, ctx: CompileContext): EmitResult;

  /** Stage 6. A structural self-check on the compiler's own output. */
  verify(output: EmitResult): VerifyResult;
}
