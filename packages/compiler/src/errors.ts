/**
 * The compiler's error and warning vocabulary.
 *
 * Transcribed from the error model in docs/COMPILER_ARCHITECTURE.md. Every
 * error carries a stage, a stable machine-readable code, and where possible the
 * offending node id, because the stage is what tells a caller what to do about
 * it:
 *
 * | Stage | Who handles it | How |
 * | --- | --- | --- |
 * | `validate` | The AI repair loop | Feed the errors back and retry. |
 * | `resolve` | The registry | Degrade, or fill the gap in the backlog. |
 * | `lower` | The user | This target cannot express this workflow. |
 * | `emit` | The user | The workflow is too large for this target. |
 * | `verify` | Us | The compiler has a bug. Page someone. |
 *
 * ## One deviation, and why
 *
 * The frozen union gives `message` to the `validate` variant only. Every
 * variant carries it here, optionally, because the same document specifies the
 * prose a `lower` failure must produce:
 *
 * > Cannot compile to Zapier: this workflow uses conditional branching (node
 * > "n_branch_is_manager", kind "branch"), and Zapier Zaps are linear.
 *
 * That sentence cannot be reconstructed from `feature` and `nodeId` alone: it
 * needs the target's display name and the node's kind, neither of which the
 * error carries. Making the field optional keeps every frozen shape a legal
 * value, so this widens the contract rather than changing it.
 *
 * ## Errors are not exceptions
 *
 * Nothing here is thrown. The compiler is a pure function and returns a
 * `CompileResult`, so a caller cannot forget to handle a failure by forgetting
 * a `catch`. A thrown error from inside the compiler is a bug in the compiler.
 */

/** The pipeline stage that produced a failure. Stages 1 through 6, by name. */
export const COMPILE_STAGES = [
  "validate",
  "resolve",
  "lower",
  "emit",
  "verify",
] as const;
export type CompileStage = (typeof COMPILE_STAGES)[number];

/**
 * A validation failure, carrying the FFIR error code unchanged.
 *
 * `code` is a `string` rather than `ErrorCode` because the vocabulary is
 * `ffir`'s and narrowing it here would mean this package has an opinion about
 * which codes exist. It does not; it forwards them.
 */
export interface ValidateError {
  stage: "validate";
  code: string;
  nodeId?: string;
  message: string;
  /** RFC 6901 pointer into the document, forwarded from the validator. */
  path?: string;
}

/** A capability id that is not in the registry at all. */
export interface ResolveError {
  stage: "resolve";
  code: "capability_unknown";
  capability: string;
  nodeId?: string;
  message?: string;
}

/** The target cannot express something the document uses. */
export interface LowerError {
  stage: "lower";
  code: "unsupported_feature";
  feature: string;
  nodeId: string;
  message?: string;
}

/** The document exceeds a hard limit of the target's file format. */
export interface EmitError {
  stage: "emit";
  code: "target_limit_exceeded";
  detail: string;
  message?: string;
}

/** The compiler's own output failed its structural self-check. A bug, not user error. */
export interface VerifyError {
  stage: "verify";
  code: "internal_inconsistency";
  detail: string;
  message?: string;
}

export type CompileError =
  | ValidateError
  | ResolveError
  | LowerError
  | EmitError
  | VerifyError;

/**
 * The closed set of warning codes.
 *
 * `capability_degraded` and `capability_unknown` are both emitted by stage 2
 * and produce identical output. They are separate codes because one is a fact
 * about a platform and the other is a fact about us: the first is a binding the
 * registry explicitly marks `null`, the second is a gap in our coverage that
 * belongs in a backlog. Counting them together would hide how much of the
 * registry is missing behind how much of it is impossible.
 */
export const WARNING_CODES = [
  "capability_degraded",
  "capability_unknown",
  "policy_unsupported",
  "trigger_mechanism_changed",
  "loop_bound_advisory",
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

/**
 * Never blocks compilation.
 *
 * `message` is written for the end user and is actionable, because it surfaces
 * as a badge on the node in the canvas and as a section in the setup guide. A
 * user exporting a workflow with a degraded node has to know which step needs
 * manual work before importing it.
 */
export interface CompileWarning {
  code: WarningCode;
  nodeId?: string;
  message: string;
}

/**
 * What every stage returns.
 *
 * Warnings ride along on both arms: a run that fails at stage 4 still learned
 * useful things at stage 2, and throwing them away would mean a user who fixes
 * the blocking error is told about the degraded nodes only on the second run.
 */
export type CompileResult<T> =
  | { ok: true; value: T; warnings: readonly CompileWarning[] }
  | { ok: false; errors: readonly CompileError[]; warnings: readonly CompileWarning[] };

export function ok<T>(
  value: T,
  warnings: readonly CompileWarning[] = [],
): CompileResult<T> {
  return { ok: true, value, warnings };
}

export function failed<T>(
  errors: readonly CompileError[],
  warnings: readonly CompileWarning[] = [],
): CompileResult<T> {
  return { ok: false, errors, warnings };
}

/** The node an error points at, when it points at one. */
export function nodeIdOf(error: CompileError): string | undefined {
  switch (error.stage) {
    case "validate":
    case "resolve":
      return error.nodeId;
    case "lower":
      return error.nodeId;
    case "emit":
    case "verify":
      return undefined;
  }
}

/**
 * Human-readable text for an error.
 *
 * Falls back to a constructed sentence for the variants whose `message` is
 * optional, so a caller rendering a list never has a blank row. The design
 * system's guidance applies: "Invalid API Key format" rather than "Failed".
 */
export function describeCompileError(error: CompileError): string {
  if (error.message !== undefined) return error.message;

  switch (error.stage) {
    case "resolve":
      return `Capability "${error.capability}" is not in this registry.`;
    case "lower":
      return `This target cannot express "${error.feature}", which node "${error.nodeId}" uses.`;
    case "emit":
      return `The workflow exceeds a limit of this target's file format: ${error.detail}`;
    case "verify":
      return `The compiler produced output that failed its own structural check: ${error.detail}. This is a bug in FlowForge, not a problem with the workflow.`;
    default:
      return error.message;
  }
}
