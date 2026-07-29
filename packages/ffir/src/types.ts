/**
 * FFIR type definitions.
 *
 * Transcribed from docs/WORKFLOW_SCHEMA.md. That document is the specification;
 * this file and `schema.json` are two views of it that must agree. The schema
 * enforces at runtime what these types assert at compile time.
 *
 * FFIR contains zero platform vocabulary. If a reader can tell which automation
 * platform FlowForge targets by reading this file, the abstraction has leaked.
 */

/** FFIR versions this build understands. A newer document is rejected, not parsed. */
export const SUPPORTED_FFIR_VERSIONS = ["1.0"] as const;
export type SupportedFFIRVersion = (typeof SUPPORTED_FFIR_VERSIONS)[number];

/** Expression grammars this build implements. Versioned separately from `ffir_version`. */
export const SUPPORTED_EXPRESSION_GRAMMARS = ["1"] as const;
export type SupportedExpressionGrammar =
  (typeof SUPPORTED_EXPRESSION_GRAMMARS)[number];

/**
 * The node's role in graph traversal. Deliberately a small closed set: the
 * compiler switches on `kind` to decide how to lower a node, so adding a kind
 * is a breaking change to every target.
 */
export const NODE_KINDS = [
  "trigger",
  "action",
  "transform",
  "branch",
  "merge",
  "loop",
  "ai",
  "wait",
  "error_handler",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const CONDITION_OPERATORS = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "greater_than",
  "less_than",
  "is_empty",
  "is_not_empty",
  "matches_regex",
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/** Operators that take no `right` operand. */
export const UNARY_CONDITION_OPERATORS = ["is_empty", "is_not_empty"] as const;

export const ON_ERROR_VALUES = ["stop", "continue", "route"] as const;
export type OnError = (typeof ON_ERROR_VALUES)[number];

export const BACKOFF_STRATEGIES = ["fixed", "exponential"] as const;
export type BackoffStrategy = (typeof BACKOFF_STRATEGIES)[number];

export const AUTH_TYPES = [
  "oauth2",
  "api_key",
  "basic",
  "webhook_secret",
  "none",
] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

export const VARIABLE_TYPES = ["string", "number", "boolean"] as const;
export type VariableType = (typeof VARIABLE_TYPES)[number];

/**
 * A parameter value is a JSON literal or a string containing expressions.
 * The shape of a `parameters` object is defined by the capability's registry
 * entry, not by FFIR. FFIR says only "this is an object".
 */
export type ParameterValue =
  | string
  | number
  | boolean
  | null
  | ParameterValue[]
  | { [key: string]: ParameterValue };

export type Parameters = Record<string, ParameterValue>;

export interface RetryPolicy {
  attempts: number;
  backoff: BackoffStrategy;
  initial_delay_ms: number;
}

export interface ErrorPolicy {
  on_error: OnError;
  retry?: RetryPolicy;
  timeout_ms?: number;
}

export interface Node {
  /** Unique within the workflow. Referenced by edges and expressions. */
  id: string;
  kind: NodeKind;
  /** Registry join key: `<integration>.<resource>.<operation>`. */
  capability: string;
  label: string;
  /** Validated against the registry entry, not against the FFIR schema. */
  parameters: Parameters;
  /** References a `credentials[].id`. */
  credential?: string;
  /** Compiler applies defaults when absent. */
  error_policy?: ErrorPolicy;
  notes?: string;
}

export interface Condition {
  left: string;
  operator: ConditionOperator;
  /** Required for every operator except `is_empty` and `is_not_empty`. */
  right?: string;
}

export interface Edge {
  id: string;
  from: string;
  to: string;
  /** Named output of the source node. Defaults to `"main"`. */
  port?: string;
  /** Only meaningful on edges out of a `branch`. */
  condition?: Condition;
}

/**
 * A symbolic handle, never a secret value. The compiler emits credential
 * placeholders referencing these by name; the export is intentionally
 * non-functional until the user connects real credentials.
 */
export interface CredentialRef {
  id: string;
  /** The integration segment of the capability ID. */
  capability_scope: string;
  auth_type: AuthType;
  label: string;
  required_scopes?: string[];
}

/**
 * A workflow-scoped constant the user must fill in. Referenced as
 * `{{ $vars.<id> }}`.
 */
export interface Variable {
  id: string;
  label: string;
  type: VariableType;
  required: boolean;
  /**
   * Marks a variable holding a credential, token, password, or other secret.
   * Variables are the one place a secret can legitimately enter a workflow
   * definition, so they carry a stronger rule than parameters, not a weaker
   * one. A sensitive variable must not carry a `default` (validation rule 15),
   * is excluded from every export and published copy, and renders as a
   * setup-guide checklist item.
   */
  sensitive: boolean;
  /** Forbidden when `sensitive` is `true`. */
  default?: string;
  description?: string;
}

export interface Warning {
  code: string;
  node_id?: string;
  message: string;
}

/**
 * Non-semantic. The compiler must produce identical functional output whether
 * or not `metadata` is present, which keeps it safe for renderers and UI state.
 */
export interface Metadata {
  generated_by?: string;
  generated_at?: string;
  source_prompt_hash?: string;
  /** Pins which registry produced this workflow, so it can be diagnosed later. */
  registry_version?: string;
  prompt_version?: string;
  warnings?: Warning[];
  layout?: Record<string, { x: number; y: number }>;
  [key: string]: unknown;
}

export interface FFIRDocument {
  ffir_version: string;
  expression_grammar: string;
  id: string;
  name: string;
  description: string;
  /** Flat list. Order is not significant. */
  nodes: Node[];
  /** Flat list. Defines all control flow. */
  edges: Edge[];
  credentials: CredentialRef[];
  variables?: Variable[];
  metadata?: Metadata;
}
