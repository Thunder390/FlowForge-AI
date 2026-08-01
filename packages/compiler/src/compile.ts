/**
 * The 6-stage pipeline.
 *
 * ```
 * FFIR document
 *      |
 *   [1] Validate          FFIR is well-formed and semantically legal
 *      |
 *   [2] Resolve           Capabilities -> registry entries + bindings
 *      |
 *   [3] Normalize         Defaults applied, expressions parsed to AST
 *      |
 *   [4] Lower             FFIR graph -> platform-specific IR
 *      |
 *   [5] Emit              Platform IR -> the platform's file format
 *      |
 *   [6] Verify            Structural self-check on the emitted output
 *      |
 *    Output + warnings
 * ```
 *
 * Stages 1 through 3 are target-independent and live in this package. Stages 4
 * through 6 are the `Target` interface. That split is where the leverage is:
 * roughly two thirds of the compiler is written once.
 *
 * `compile` is a pure function. No network, no filesystem, no clock, no
 * randomness. This is what makes golden-file testing possible, and golden files
 * are what make compiler bugs visible, because a compiler's bugs are otherwise
 * silent: a workflow that imports cleanly and then does the wrong thing at
 * runtime is the worst failure mode this product has.
 *
 * ## Stages fail whole, not one error at a time
 *
 * Within a stage every failure is collected. Between stages the pipeline stops,
 * because each stage's input is the previous stage's output and there is
 * nothing meaningful to say about a graph that could not be built. Warnings
 * accumulate across every stage that ran and ride along on failure too: a run
 * that dies at stage 4 still learned at stage 2 that three nodes degraded, and
 * discarding that would mean the user is told only on their next attempt.
 */

import type { FFIRDocument } from "@flowforge/ffir";
import type { Registry } from "@flowforge/registry";

import { checkTargetCapabilities } from "./capabilities.js";
import {
  failed,
  ok,
  type CompileError,
  type CompileResult,
  type CompileWarning,
} from "./errors.js";
import { normalize, type NormalizedGraph } from "./normalize.js";
import { resolveNodes } from "./resolve.js";
import type { CompileContext, Target } from "./target.js";
import { validateForCompile } from "./validate.js";

export interface CompileOutput {
  target: string;
  /** The serialized artifact, ready to write to a file. */
  content: string;
  /** `Target.fileExtension`, without the leading dot. */
  fileExtension: string;
  /** The representation stages 4 through 6 were built from. */
  graph: NormalizedGraph;
}

/**
 * Runs stages 1 through 3, the target-independent half.
 *
 * Exported in its own right because it is useful without a target. The renderers
 * in M7 need defaults applied and expressions parsed, and the layout in
 * `metadata.layout` is computed from the same ordering, so a caller that wants
 * a mermaid diagram should not have to nominate an export platform to get one.
 */
export function compileToGraph(
  input: unknown,
  registry: Registry,
  target: string,
): CompileResult<NormalizedGraph> {
  const warnings: CompileWarning[] = [];

  const validated = validateForCompile(input, registry);
  warnings.push(...validated.warnings);
  if (!validated.ok) return failed(validated.errors, warnings);

  const doc = input as FFIRDocument;

  const resolved = resolveNodes(doc.nodes, registry, target);
  warnings.push(...resolved.warnings);
  if (!resolved.ok) return failed(resolved.errors, warnings);

  const normalized = normalize(doc, resolved.value.nodes, registry, target);
  warnings.push(...normalized.warnings);
  if (!normalized.ok) return failed(normalized.errors, warnings);

  return ok(normalized.value, warnings);
}

/**
 * The whole pipeline, stages 1 through 6.
 *
 * The capability check sits between stage 3 and stage 4 rather than at the very
 * front, because its errors name nodes and reporting "this target cannot branch"
 * about a document that turns out to be invalid JSON helps nobody. Validation
 * first, then the question of whether a valid workflow fits this platform.
 */
export function compile(
  input: unknown,
  registry: Registry,
  target: Target,
): CompileResult<CompileOutput> {
  const graph = compileToGraph(input, registry, target.key);
  const warnings: CompileWarning[] = [...graph.warnings];
  if (!graph.ok) return failed(graph.errors, warnings);

  const doc = graph.value.doc;

  const capabilities = checkTargetCapabilities(doc, target);
  warnings.push(...capabilities.warnings);
  if (capabilities.errors.length > 0) return failed(capabilities.errors, warnings);

  const ctx: CompileContext = {
    doc,
    registry,
    target: target.key,
    warn: (warning) => warnings.push(warning),
  };

  const lowered = target.lower(graph.value, ctx);
  if (lowered.target !== target.key) {
    return failed(
      [internal(`target "${target.key}" lowered to IR stamped "${lowered.target}"`)],
      warnings,
    );
  }

  const emitted = target.emit(lowered, ctx);
  const verified = target.verify(emitted);
  if (!verified.ok) {
    return failed([internal(verified.failures.join("; "))], warnings);
  }

  return ok(
    {
      target: target.key,
      content: emitted.content,
      fileExtension: target.fileExtension,
      graph: graph.value,
    },
    warnings,
  );
}

/**
 * A stage 6 failure means the compiler has a bug.
 *
 * The correct response is to fail rather than hand the user a broken file, and
 * to say plainly whose fault it is. A user who is told their workflow is
 * invalid, when in fact our emitter produced a dangling connection, will spend
 * an afternoon editing a workflow that was already correct.
 */
function internal(detail: string): CompileError {
  return {
    stage: "verify",
    code: "internal_inconsistency",
    detail,
    message: `FlowForge produced output that failed its own structural check (${detail}). This is a bug in FlowForge, not a problem with your workflow. Nothing was exported.`,
  };
}

/** Every emitted artifact for a target, keyed for a caller writing files. */
export function fileNameFor(doc: FFIRDocument, target: Target): string {
  const slug = doc.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug === "" ? doc.id : slug}.${target.fileExtension}`;
}
