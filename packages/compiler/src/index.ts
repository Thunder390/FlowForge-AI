/**
 * FFIR to platform artifacts.
 *
 * The compiler is a pure function: `compile(ffir, registry, target)` returns
 * output or a typed error, with no network, no filesystem, no clock, and no
 * randomness. Everything a platform knows about itself lives behind the
 * `Target` interface, so adding one means writing one implementation of it plus
 * one key per capability in the registry's `bindings` block. Nothing in `ai`,
 * nothing in `ffir`, nothing in the validator.
 *
 * **This package must not import `@flowforge/ai`, and `ai` must not import
 * this one.** Both depend on `ffir` and `registry`; neither depends on the
 * other. `packages/pipeline` is the only layer allowed to call both, which is
 * why the compile dry-run that AI_SPEC calls validation stage 5 belongs there
 * and not here.
 *
 * ## What exists today
 *
 * Stages 1 through 3, the target-independent half, and the `Target` interface
 * that stages 4 through 6 implement. No target implements it yet: the n8n
 * target is M6b. Building the shared half first, with nothing concrete to lean
 * on, is what makes its target-independence a property of the code rather than
 * an intention.
 *
 * `compileToGraph` is therefore the useful entry point right now, and stays
 * useful afterwards: the M7 renderers need a normalized graph and have no
 * business naming an export platform to get one.
 */

export {
  compile,
  compileToGraph,
  fileNameFor,
  type CompileOutput,
} from "./compile.js";

export {
  checkTargetCapabilities,
  supportsDocument,
  requiredCapabilities,
  type CapabilityCheck,
} from "./capabilities.js";

export {
  COMPILE_STAGES,
  WARNING_CODES,
  describeCompileError,
  failed,
  nodeIdOf,
  ok,
  type CompileError,
  type CompileResult,
  type CompileStage,
  type CompileWarning,
  type EmitError,
  type LowerError,
  type ResolveError,
  type ValidateError,
  type VerifyError,
  type WarningCode,
} from "./errors.js";

export {
  DEFAULT_ERROR_POLICY,
  applyDefaults,
  assignDisplayNames,
  normalize,
  topologicalOrder,
  type NormalizedCondition,
  type NormalizedEdge,
  type NormalizedGraph,
  type NormalizedNode,
} from "./normalize.js";

export { resolveNodes, type ResolveOutput, type ResolvedNode } from "./resolve.js";

export {
  type CompileContext,
  type EmitResult,
  type PlatformIR,
  type Target,
  type TargetCapabilities,
  type VerifyResult,
} from "./target.js";

export { validateForCompile } from "./validate.js";
