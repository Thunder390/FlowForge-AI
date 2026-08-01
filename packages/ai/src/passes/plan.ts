/**
 * Pass A: plan generation.
 *
 * The model chooses the steps, the capability each one uses, and how they
 * connect. It does not fill in parameter values, because it cannot yet: doing
 * that well needs the full parameter schema for each capability, and sending
 * every schema for every capability is what the two-pass split exists to avoid.
 *
 * ## The output shape is flat and fully required
 *
 * Three properties, each a workaround for a real structured-output constraint,
 * and each one worth knowing before someone "tidies" the schema:
 *
 * 1. **Every field is in `required`.** Structured outputs works best with a
 *    fully closed shape, so optionality is expressed with sentinel values:
 *    empty string for absent text, `"none"` for an absent condition operator,
 *    `0` for no retries. The merge converts them back to genuine absence.
 * 2. **Conditions are flattened onto the edge** rather than nested under a
 *    `condition` object. Fewer nesting levels means fewer places to go wrong,
 *    and the merge reassembles the nested FFIR form.
 * 3. **No `pattern`, `minLength`, or `minimum` anywhere.** Structured outputs
 *    does not support them. Our validator enforces those, and its failures feed
 *    the repair loop.
 *
 * ## The enums are FFIR's, not copies of them
 *
 * Node kinds, condition operators, error policies, and variable types are built
 * from the constants `ffir` exports rather than written out again. A schema
 * that let the model emit a kind FFIR does not have would produce a document
 * that fails stage 1 every time, and the failure would look like a model
 * problem rather than a drifted constant.
 *
 * ## Prompt caching layout
 *
 * ```
 * [system 1] Instructions          stable
 * [system 2] Capability catalog    stable, changes only on registry bump
 *            <-- cache breakpoint
 * [user]     The user's prompt     volatile
 * ```
 *
 * Opus 5's minimum cacheable prefix is 512 tokens, so a prefix this size caches
 * comfortably. Whether it *is* caching is not visible from the output, only
 * from `usage.cache_read_input_tokens`, which is why that field is carried all
 * the way through the provider interface.
 */

import {
  CONDITION_OPERATORS,
  NODE_KINDS,
  ON_ERROR_VALUES,
  VARIABLE_TYPES,
} from "@flowforge/ffir";
import type { Registry } from "@flowforge/registry";

import {
  DEFAULT_EFFORT,
  GENERATION_MAX_TOKENS,
  MODELS,
} from "../provider/anthropic-wire.js";
import type {
  Effort,
  GenerationRequest,
  JsonSchema,
  ModelProvider,
  ProviderEvent,
  ProviderMessage,
  RequestMessage,
} from "../provider/types.js";
import { loadPrompt } from "../prompts.js";
import type { CapabilityRetriever } from "../retrieval/types.js";
import { callStructured } from "./call.js";

export const PLAN_SCHEMA_NAME = "workflow_plan";

/**
 * The sentinel meaning "this edge carries no condition".
 *
 * A member of the operator enum rather than an absent field, because the shape
 * is closed. The merge turns it back into an omitted `condition` object.
 */
export const NO_CONDITION = "none";

export interface PlanNode {
  id: string;
  kind: string;
  capability: string;
  label: string;
  /** `""` means none. */
  notes: string;
  /** The integration segment, or `""` for a capability needing no credential. */
  capability_scope: string;
  on_error: string;
  /** `0` means no retry policy. */
  retry_attempts: number;
}

export interface PlanEdge {
  id: string;
  from: string;
  to: string;
  /** `""` means the default port. */
  port: string;
  condition_left: string;
  condition_operator: string;
  condition_right: string;
}

export interface PlanVariable {
  id: string;
  label: string;
  description: string;
  type: string;
  required: boolean;
  sensitive: boolean;
  /** `""` means none. Always `""` when `sensitive`. */
  default: string;
}

export interface WorkflowPlan {
  name: string;
  description: string;
  nodes: PlanNode[];
  edges: PlanEdge[];
  variables: PlanVariable[];
}

const STRING: JsonSchema = { type: "string" };

/** Transcribed from the pass A output schema in AI_SPEC.md. */
export const PLAN_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    name: STRING,
    description: STRING,
    nodes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: STRING,
          kind: { type: "string", enum: [...NODE_KINDS] },
          capability: STRING,
          label: STRING,
          notes: STRING,
          capability_scope: STRING,
          on_error: { type: "string", enum: [...ON_ERROR_VALUES] },
          retry_attempts: { type: "integer" },
        },
        required: [
          "id",
          "kind",
          "capability",
          "label",
          "notes",
          "capability_scope",
          "on_error",
          "retry_attempts",
        ],
        additionalProperties: false,
      },
    },
    edges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: STRING,
          from: STRING,
          to: STRING,
          port: STRING,
          condition_left: STRING,
          condition_operator: {
            type: "string",
            enum: [NO_CONDITION, ...CONDITION_OPERATORS],
          },
          condition_right: STRING,
        },
        required: [
          "id",
          "from",
          "to",
          "port",
          "condition_left",
          "condition_operator",
          "condition_right",
        ],
        additionalProperties: false,
      },
    },
    variables: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: STRING,
          label: STRING,
          description: STRING,
          type: { type: "string", enum: [...VARIABLE_TYPES] },
          required: { type: "boolean" },
          sensitive: { type: "boolean" },
          default: STRING,
        },
        required: [
          "id",
          "label",
          "description",
          "type",
          "required",
          "sensitive",
          "default",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["name", "description", "nodes", "edges", "variables"],
  additionalProperties: false,
};

export interface PlanRequestInput {
  prompt: string;
  registry: Registry;
  retriever: CapabilityRetriever;
  model?: string;
  effort?: Effort;
  maxTokens?: number;
  /**
   * Earlier turns, for chat iteration.
   *
   * Iteration is a full regeneration with the current workflow as context
   * rather than a patch, because a partial edit can invalidate expressions
   * elsewhere in the graph and detecting that means re-running the whole
   * validator anyway. Carrying prior turns is what makes the cached prefix
   * survive the second request.
   */
  history?: readonly RequestMessage[];
}

/**
 * Builds the pass A request.
 *
 * Separate from running it so a test can assert on the request without a
 * provider, and so the fixture set can be keyed by the request the pipeline
 * actually builds rather than by a hand-copied approximation of it.
 */
export function buildPlanRequest(input: PlanRequestInput): GenerationRequest {
  return {
    model: input.model ?? MODELS.generation,
    maxTokens: input.maxTokens ?? GENERATION_MAX_TOKENS,
    effort: input.effort ?? DEFAULT_EFFORT,
    system: [
      { text: loadPrompt("pass_a") },
      // The breakpoint goes on the last system block, which caches the
      // instructions and the catalog together. Render order is tools, then
      // system, then messages, so everything volatile is already after it.
      { text: input.retriever.catalog(input.registry), cache: true },
    ],
    messages: [...(input.history ?? []), { role: "user", content: input.prompt }],
    outputSchema: { name: PLAN_SCHEMA_NAME, schema: PLAN_SCHEMA },
  };
}

export interface PlanResult {
  plan: WorkflowPlan;
  message: ProviderMessage;
  request: GenerationRequest;
}

export async function runPlan(
  provider: ModelProvider,
  input: PlanRequestInput,
  onEvent?: (event: ProviderEvent) => void,
): Promise<PlanResult> {
  const request = buildPlanRequest(input);
  const { value, message } = await callStructured<WorkflowPlan>(
    provider,
    request,
    onEvent,
  );
  return { plan: value, message, request };
}

/** The distinct capabilities a plan names, sorted. What retrieval is asked for. */
export function capabilitiesOf(plan: WorkflowPlan): string[] {
  return [...new Set(plan.nodes.map((node) => node.capability))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}
