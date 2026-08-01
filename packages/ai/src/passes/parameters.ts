/**
 * Pass B: parameter fill.
 *
 * The structure is already decided. This pass produces values, constrained by a
 * schema synthesized from registry data for this specific workflow, which is
 * what makes an invented parameter name structurally impossible rather than
 * merely unlikely. See `schema-synth.ts` for how that schema is built and what
 * it cannot express.
 *
 * ## Prompt layout
 *
 * ```
 * [system 1] Instructions        stable across every workflow
 *            <-- cache breakpoint
 * [system 2] Schema bundle       varies per workflow
 * [user]     Plan, then the original request
 * ```
 *
 * The breakpoint sits after the instruction block because everything after it
 * is per-workflow. That block may fall under Opus 5's 512-token minimum
 * cacheable prefix, in which case nothing caches and nothing errors: the way to
 * know is `usage.cache_creation_input_tokens`, not inspection.
 *
 * The user's original request goes last, after the plan, so that values reflect
 * what they actually asked for rather than only what the plan inferred. A plan
 * says "announce in Slack"; the request says which channel.
 */

import type { ParameterValue } from "@flowforge/ffir";
import type { Registry } from "@flowforge/registry";

import {
  DEFAULT_EFFORT,
  GENERATION_MAX_TOKENS,
  MODELS,
} from "../provider/anthropic-wire.js";
import type {
  Effort,
  GenerationRequest,
  ModelProvider,
  ProviderEvent,
  ProviderMessage,
} from "../provider/types.js";
import { loadPrompt } from "../prompts.js";
import type { CapabilityRetriever, SchemaBundle } from "../retrieval/types.js";
import {
  synthesizeParameterSchema,
  type SynthesisResult,
} from "../schema-synth.js";
import { capabilitiesOf, type WorkflowPlan } from "./plan.js";
import { callStructured } from "./call.js";
import { OutputError } from "../structured.js";

export const PARAMETERS_SCHEMA_NAME = "workflow_parameters";

/** Parameter values keyed by node id, exactly as the synthesized schema shapes them. */
export type NodeParameters = Record<string, Record<string, ParameterValue>>;

export interface ParametersRequestInput {
  plan: WorkflowPlan;
  /** The user's original request. Goes last, so values answer what was asked. */
  prompt: string;
  registry: Registry;
  retriever: CapabilityRetriever;
  model?: string;
  effort?: Effort;
  maxTokens?: number;
}

export interface ParametersRequestBuild {
  request: GenerationRequest;
  /** Carries the errors and the losses. The caller decides what to do about them. */
  synthesis: SynthesisResult;
  bundle: SchemaBundle;
}

/**
 * Builds the pass B request, the schema, and the bundle together.
 *
 * They are returned as one object because they are one decision: the schema
 * names the capabilities the bundle documents, and a caller holding one without
 * the other cannot tell whether a parameter is missing because the registry has
 * no shape for it or because the model declined to fill it.
 */
export function buildParametersRequest(
  input: ParametersRequestInput,
): ParametersRequestBuild {
  const synthesis = synthesizeParameterSchema(
    input.plan.nodes.map((node) => ({ id: node.id, capability: node.capability })),
    input.registry,
  );
  const bundle = input.retriever.bundle(input.registry, capabilitiesOf(input.plan));

  const request: GenerationRequest = {
    model: input.model ?? MODELS.generation,
    maxTokens: input.maxTokens ?? GENERATION_MAX_TOKENS,
    effort: input.effort ?? DEFAULT_EFFORT,
    system: [
      { text: loadPrompt("pass_b"), cache: true },
      { text: bundle.text },
    ],
    messages: [{ role: "user", content: userMessage(input.plan, input.prompt) }],
    outputSchema: { name: PARAMETERS_SCHEMA_NAME, schema: synthesis.schema },
  };

  return { request, synthesis, bundle };
}

/**
 * The plan, then the request.
 *
 * The plan is serialized with stable key order and two-space indentation. Key
 * order matters because this text is part of the request, and a plan whose keys
 * wandered between runs would produce a different request for the same
 * workflow, which breaks fixture replay and would break a cache if this block
 * were ever moved in front of the breakpoint.
 */
function userMessage(plan: WorkflowPlan, prompt: string): string {
  return [
    "Here is the plan to fill in.",
    "",
    "```json",
    JSON.stringify(plan, null, 2),
    "```",
    "",
    "The person asked for this, in their own words. Let it decide the values:",
    "",
    prompt,
  ].join("\n");
}

export interface ParametersResult {
  parameters: NodeParameters;
  synthesis: SynthesisResult;
  bundle: SchemaBundle;
  message: ProviderMessage;
  request: GenerationRequest;
}

/**
 * Runs pass B.
 *
 * A synthesis error stops the call before it is made. The model would be given
 * a schema that cannot describe a valid document, so it would produce something
 * that fails stage 3 and no repair could fix it, because the fix is a key the
 * schema forbids. Spending an Opus call to arrive there is worse than saying so
 * now.
 */
export async function runParameters(
  provider: ModelProvider,
  input: ParametersRequestInput,
  onEvent?: (event: ProviderEvent) => void,
): Promise<ParametersResult> {
  const { request, synthesis, bundle } = buildParametersRequest(input);
  assertSynthesizable(synthesis);

  const { value, message } = await callStructured<NodeParameters>(
    provider,
    request,
    onEvent,
  );
  return { parameters: value, synthesis, bundle, message, request };
}

/**
 * Stops before the call when the schema cannot describe a valid document.
 *
 * Exported because the orchestrator builds the request and makes the call as
 * two steps, so that it can report unknown capabilities to the ladder before
 * spending an Opus call, and it needs the same gate at the same point.
 */
export function assertSynthesizable(synthesis: SynthesisResult): void {
  if (synthesis.ok) return;
  throw new OutputError(
    "schema_violation",
    PARAMETERS_SCHEMA_NAME,
    synthesis.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => issue.message),
  );
}
