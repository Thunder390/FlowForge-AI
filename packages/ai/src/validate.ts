/**
 * Validation stages 2 and 3, re-exported from where they live.
 *
 * They shipped here in M5. M6 moved the implementation to
 * `@flowforge/registry`, because the compiler's stage 1 has to run the same
 * full gate and `compiler` may not import `ai`. Two packages needing one walk
 * meant it belonged under the one they both already depend on; duplicating it
 * would put rules 7, 8, and 13 behind two implementations that drift.
 *
 * This module stays because the AI layer owning stages 2 and 3 is a fact about
 * the architecture, not about which file the code sits in. AI_SPEC's stage
 * table assigns them here, the orchestrator reaches for them here, and a caller
 * should not need to know that the walk is shared to use it.
 *
 * What has not changed: this package still never reads a binding. The functions
 * below take a `Registry` and never touch `registry.bindings`, and a test in
 * `registry` proves it by validating against a build with every binding
 * stripped.
 */

export {
  checkRegistry,
  checkParameters,
  validateAgainstRegistry,
} from "@flowforge/registry";
