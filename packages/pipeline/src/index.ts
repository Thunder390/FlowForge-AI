/**
 * The orchestrator.
 *
 * This is the only package that imports both `@flowforge/ai` and
 * `@flowforge/compiler`, and it exists precisely so that no other package has
 * to. Validation stage 5 is a compile dry-run, so the generation state machine
 * has to be able to call both sides, and the AI layer must not be the thing
 * that can. Without a named orchestrator the import rule is unenforceable and
 * the architecture quietly collapses into a single tangled layer.
 */

export {
  generate,
  validateDocument,
  type GenerateInput,
  type GenerationFailed,
  type GenerationResult,
  type GenerationSuccess,
} from "./generate.js";

export {
  EventLog,
  LabelWatcher,
  STAGE_TEXT,
  type EventSink,
  type GenerationEvent,
} from "./events.js";

export {
  DEFERRED_STAGES,
  IMPLEMENTED_STAGES,
  STAGES,
  STAGE_OWNER,
  type Stage,
  type StageOwner,
} from "./stages.js";

export {
  fromCompileError,
  fromThrown,
  fromValidationError,
  isTerminal,
  RECOVERIES,
  type GenerationFailure,
  type Recovery,
} from "./errors.js";
