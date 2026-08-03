/**
 * The generation state machine's stages.
 *
 * Declared in full, including the two this build does not run yet, because this
 * file is the vocabulary and three independent stage enums is the failure mode
 * it exists to prevent. `ffir`'s error codes are declared the same way and for
 * the same reason: tracing, the event log, and the UI all name stages, and they
 * have to name the same ones.
 *
 * ```
 * User prompt
 *     |
 * [0] classify      Haiku. Ready, or three clarifying questions.        (M9)
 *     |
 * [1] plan          Opus, catalog in the cached prefix. Graph, no params.
 *     |
 * [2] retrieve      Capabilities to full schemas. Local, no model call.
 *     |
 * [3] parameters    Opus, only the relevant schemas, closed output schema.
 *     |
 * [4] merge         Plan + parameters -> FFIR. Local, deterministic.
 *     |
 * [5] validate      Stages 0 to 4. Local.
 *     |
 * [6] compile       Compile dry-run: the gate that guarantees export works. (M9)
 *     |
 * Validated FFIR
 * ```
 */

export const STAGES = [
  "classify",
  "plan",
  "retrieve",
  "parameters",
  "merge",
  "validate",
  "compile",
] as const;
export type Stage = (typeof STAGES)[number];

/**
 * The stages `generate` actually runs.
 *
 * `classify` is still M9: it is a model call this build has no prompt for.
 *
 * `compile` runs from here. An earlier version of this comment argued the
 * dry-run was not worth landing before the retry ladder, on the grounds that a
 * gate which can only report a failure and never repair it merely moves the
 * error from download time to generation time. That undersells the move. A
 * failure reported at generation time is one the user hears about while they
 * are still looking at the screen, rather than a file that downloads cleanly
 * and breaks on import. The ladder also needs a gate to repair *from* before it
 * can repair anything, so this is the precondition rather than a consolation
 * prize. Repair itself arrives with the ladder.
 *
 * A test pins the events `generate` emits against this list, so a stage that
 * starts running without being declared here, or stops running while still
 * declared, fails rather than drifting.
 */
export const IMPLEMENTED_STAGES: readonly Stage[] = [
  "plan",
  "retrieve",
  "parameters",
  "merge",
  "validate",
  "compile",
];

/** Stages the roadmap places in M9. Named so the gap is explicit rather than implied. */
export const DEFERRED_STAGES: readonly Stage[] = ["classify"];

export type StageOwner = "ai" | "compiler" | "pipeline";

/**
 * Which layer owns each stage.
 *
 * The reason `packages/pipeline` exists is visible in this table: `parameters`
 * is owned by `ai` and `compile` by `compiler`, neither may import the other,
 * and one state machine has to run both. `validate` is owned here because it is
 * composed rather than delegated, stages 0, 1, and 4 from `ffir` and stages 2
 * and 3 from `registry`, and no single package below this one can run all five.
 */
export const STAGE_OWNER: Record<Stage, StageOwner> = {
  classify: "ai",
  plan: "ai",
  retrieve: "ai",
  parameters: "ai",
  merge: "ai",
  validate: "pipeline",
  compile: "compiler",
};
