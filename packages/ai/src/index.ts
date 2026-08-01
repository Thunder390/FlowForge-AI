/**
 * The AI layer: prompts, providers, generation passes, and the
 * registry-dependent validation stages.
 *
 * **This package must not import `@flowforge/compiler`.** Both depend on `ffir`
 * and `registry`; neither depends on the other. That is the structural
 * expression of the architecture's central decision, which is that the AI layer
 * produces FFIR and knows nothing about any target platform. The moment this
 * package can import the compiler, someone reaches for a platform detail from
 * inside a prompt, and the claim that adding Make.com requires no AI change
 * becomes false. `package.json` not listing the compiler is what actually
 * enforces it: with a strict node linker the import fails to resolve at build
 * time rather than at review time.
 *
 * **This package produces FFIR and nothing else.** Not n8n JSON, not mermaid,
 * not the setup guide. Four of those five artifacts are deterministic functions
 * of the fifth, generating them would cost roughly four times the output tokens
 * and latency, and each generated artifact is an independent hallucination
 * surface where a derived one has none.
 *
 * The orchestration that strings these pieces together lives in
 * `@flowforge/pipeline`, because validation stage 5 is a compile dry-run and
 * something has to call both this package and the compiler. That something
 * cannot be this package.
 */

// Validation stages 2 and 3. They live in `registry`, because the rules they
// walk are registry data and because `compiler` needs them too while neither
// package may import the other. Owning them is a fact about the architecture
// rather than about which directory the code sits in, so they are re-exported.
export {
  checkRegistry,
  checkParameters,
  validateAgainstRegistry,
} from "./validate.js";

export {
  STOP_REASONS,
  EFFORT_LEVELS,
  PROVIDER_ERROR_CODES,
  ProviderError,
  collect,
  emptyUsage,
  type Effort,
  type GenerationRequest,
  type JsonSchema,
  type ModelProvider,
  type OutputSchema,
  type ProviderCapabilities,
  type ProviderErrorCode,
  type ProviderEvent,
  type ProviderMessage,
  type ProviderUsage,
  type RequestMessage,
  type StopDetails,
  type StopReason,
  type SystemBlock,
} from "./provider/types.js";

export {
  AnthropicProvider,
  ANTHROPIC_CAPABILITIES,
  ANTHROPIC_PROVIDER_KEY,
  type AnthropicLike,
  type AnthropicProviderOptions,
  type MessageStreamLike,
} from "./provider/anthropic.js";

export {
  buildRequest,
  toProviderMessage,
  toStopReason,
  textOf,
  DEFAULT_EFFORT,
  GENERATION_MAX_TOKENS,
  MODELS,
  SERVER_SIDE_FALLBACK_BETA,
  type AnthropicMessageLike,
  type AnthropicRequestBody,
  type AnthropicSystemBlock,
  type BuildOptions,
} from "./provider/anthropic-wire.js";

export {
  ReplayProvider,
  REPLAY_CAPABILITIES,
  REPLAY_PROVIDER_KEY,
  canonicalJson,
  digestRequest,
  type RecordedExchange,
  type RecordedResponse,
  type ReplayProviderOptions,
} from "./provider/replay.js";

export {
  ProviderResolver,
  type CredentialSource,
  type ProviderCredentials,
  type ProviderCredentialStore,
  type ProviderFactory,
  type ProviderResolverOptions,
  type ResolvedProvider,
} from "./provider/resolve.js";

export {
  InlineRetriever,
  INLINE_RETRIEVER_KEY,
  flattenOutputs,
  renderBundle,
  renderCatalog,
} from "./retrieval/inline.js";
export type { CapabilityRetriever, SchemaBundle } from "./retrieval/types.js";

export {
  synthesizeParameterSchema,
  emptyStringIsLegal,
  isRequiredInSchema,
  SYNTHESIS_ISSUE_CODES,
  type SchemaNode,
  type SynthesisIssue,
  type SynthesisIssueCode,
  type SynthesisResult,
} from "./schema-synth.js";

export {
  loadPrompt,
  promptPath,
  PROMPTS,
  PROMPT_NAMES,
  PROMPT_VERSION,
  type PromptName,
} from "./prompts.js";

export {
  OutputError,
  parseStructured,
  unfence,
  OUTPUT_ERROR_CODES,
  type OutputErrorCode,
} from "./structured.js";

export { callStructured, type StructuredCall } from "./passes/call.js";

export {
  buildPlanRequest,
  capabilitiesOf,
  runPlan,
  NO_CONDITION,
  PLAN_SCHEMA,
  PLAN_SCHEMA_NAME,
  type PlanEdge,
  type PlanNode,
  type PlanRequestInput,
  type PlanResult,
  type PlanVariable,
  type WorkflowPlan,
} from "./passes/plan.js";

export {
  assertSynthesizable,
  buildParametersRequest,
  runParameters,
  PARAMETERS_SCHEMA_NAME,
  type NodeParameters,
  type ParametersRequestBuild,
  type ParametersRequestInput,
  type ParametersResult,
} from "./passes/parameters.js";

export {
  merge,
  hashPrompt,
  DEFAULT_RETRY_BACKOFF,
  DEFAULT_RETRY_INITIAL_DELAY_MS,
  MERGE_WARNING_CODES,
  VERSION_PINS,
  WRITES_EXPRESSION_GRAMMAR,
  WRITES_FFIR_VERSION,
  type MergeInput,
  type MergeResult,
  type MergeWarningCode,
} from "./merge.js";
