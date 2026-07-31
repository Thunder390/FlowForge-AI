/**
 * Registry type definitions.
 *
 * Transcribed from docs/NODE_REGISTRY.md. That document is the specification;
 * this file and the three artifact JSON Schemas are two views of it that must
 * agree. The schemas enforce at load time what these types assert at compile
 * time.
 *
 * The registry answers four questions and every consumer asks a different one:
 * the AI layer asks what exists and what parameters a capability takes, the
 * validator asks whether a parameter object is legal, and the compiler asks how
 * a capability becomes a platform node. One data structure serves all four, so
 * the model, the validator, and the compiler cannot disagree.
 *
 * The split that makes this work is `capabilities/` versus `bindings/<platform>/`.
 * `Capability` carries no platform vocabulary at all; everything a target needs
 * lives in `Binding`. If a reader can tell which automation platform FlowForge
 * targets from the `Capability` half of this file, the abstraction has leaked.
 */

import type { AuthType, NodeKind, ParameterValue } from "@flowforge/ffir";

export type { AuthType, NodeKind, ParameterValue };

/**
 * The capability ID format, `<integration>.<resource>.<operation>`.
 *
 * Build validation rule 1 in NODE_REGISTRY.md. Pinned here rather than inlined
 * at each use so the loader, the artifact schemas, and the retrieval index all
 * agree on what a legal ID is.
 */
export const CAPABILITY_ID_PATTERN = /^[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+$/;

/** The integration segment of an ID, matched on its own. */
export const INTEGRATION_ID_PATTERN = /^[a-z0-9_]+$/;

/**
 * Codepoint order, not locale order.
 *
 * Every ordered thing the registry produces sorts through this one function.
 * `localeCompare` gives different answers on different machines, which would
 * make a registry loaded in CI and a registry loaded on a laptop iterate
 * differently, and every golden file downstream depends on them not doing that.
 */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Reserved namespaces.
 *
 * `core.*` is the set of platform-agnostic primitives FFIR itself depends on.
 * Every target must implement all of them, which is why build validation rule 6
 * singles them out. `http.request.send` is the universal escape hatch that any
 * unmapped integration degrades to.
 */
export const CORE_INTEGRATION = "core";
export const HTTP_FALLBACK_CAPABILITY = "http.request.send";

/**
 * The `core.*` capabilities named in NODE_REGISTRY.md.
 *
 * A literal list rather than "whatever the fixtures happen to contain", because
 * a target that cannot express `core.branch.if` cannot be a target at all and we
 * want to learn that from a failing test rather than at compile time.
 */
export const CORE_CAPABILITIES = [
  "core.branch.if",
  "core.loop.for_each",
  "core.merge.collect",
  "core.transform.map",
  "core.wait.delay",
] as const;
export type CoreCapability = (typeof CORE_CAPABILITIES)[number];

/** The default compiler target. The only one bound in the MVP registry. */
export const DEFAULT_TARGET = "n8n";

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export const PARAMETER_TYPES = [
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "enum",
  "datetime",
] as const;
export type ParameterType = (typeof PARAMETER_TYPES)[number];

/**
 * Validation expressed as data rather than as code, so the AI layer and the
 * compiler enforce exactly the same thing. Hand-written TypeScript guards
 * duplicating these is how the two drift apart.
 *
 * These keywords are for our validator, not for a model's structured-output
 * schema: structured output does not support `pattern`, `minLength`, or
 * `minimum`, so the synthesized schema cannot carry them and the validator
 * enforces the semantics instead.
 */
export interface ValidationRules {
  pattern?: string;
  min_length?: number;
  max_length?: number;
  min?: number;
  max?: number;
  one_of?: ParameterValue[];
  not_empty?: boolean;
}

/**
 * The state another parameter must be in for a `conditional_required` to fire.
 *
 * Exactly one key. NODE_REGISTRY.md specifies `is_empty`; the other three close
 * the set so a curator never has to reach outside it, which is what would turn
 * registry data into something the validator has to interpret loosely.
 */
export type ConditionSpec =
  | { is_empty: boolean }
  | { is_not_empty: boolean }
  | { equals: ParameterValue }
  | { one_of: ParameterValue[] };

/** Required only when the named sibling parameters are all in the given state. */
export interface ConditionalRequired {
  when: Record<string, ConditionSpec>;
}

export interface ParameterDefinition {
  type: ParameterType;
  /** Hard requirement. Missing means compile failure. */
  required: boolean;
  /** Written for the model. This is prompt text; it earns its tokens. */
  description: string;
  /** Applied by the compiler when the parameter is absent. */
  default?: ParameterValue;
  /** Shown to the model in pass B. Concrete examples cut error rate. */
  example?: ParameterValue;
  validation?: ValidationRules;
  conditional_required?: ConditionalRequired;
  /** For `enum`. The closed list of legal values. */
  values?: ParameterValue[];
  /** For `array`. The element schema. */
  items?: ParameterDefinition;
  /** For `object`. The declared field schemas. */
  fields?: Record<string, ParameterDefinition>;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/**
 * One field a capability emits.
 *
 * Nesting is representable because the worked example needs it: an expression
 * reads `{{ n_trigger.employee.first_name }}`, so `employee` has to declare
 * `first_name`. Pass B sees these field names, which is what stops the model
 * inventing plausible-sounding ones.
 */
export interface OutputField {
  type: ParameterType;
  description?: string;
  /** For `object`. The nested field shapes. */
  fields?: Record<string, OutputField>;
  /** For `array`. The element shape. */
  items?: OutputField;
}

export type OutputShape = Record<string, OutputField>;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * `type` maps directly onto `credentials[].auth_type` in FFIR, which is why it
 * is FFIR's type rather than a copy of the same five strings.
 */
export interface AuthDefinition {
  id: string;
  type: AuthType;
  label: string;
  default: boolean;
  scopes_available?: string[];
  field_hint?: string;
  /** Rendered verbatim into the setup guide, so it is written for the end user. */
  setup_notes?: string;
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export const TRIGGER_MECHANISMS = [
  "webhook",
  "polling",
  "schedule",
  "manual",
] as const;
export type TriggerMechanism = (typeof TRIGGER_MECHANISMS)[number];

export interface PollInterval {
  default: number;
  min: number;
  max?: number;
}

/**
 * The extra block a `kind: "trigger"` capability carries.
 *
 * When a platform cannot support the preferred mechanism the compiler falls
 * back to `fallback` and records a `trigger_mechanism_changed` warning. That
 * degradation is visible in the UI rather than silent.
 */
export interface TriggerSpec {
  mechanism: TriggerMechanism;
  poll_interval_minutes?: PollInterval;
  fallback?: TriggerMechanism;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export interface RateLimit {
  requests_per_minute?: number;
  notes?: string;
}

export interface Capability {
  /** `<integration>.<resource>.<operation>`. Stable forever. */
  id: string;
  /**
   * The node kind this capability is normally used as.
   *
   * A node's `kind` need not equal its capability's: the worked example uses
   * `slack.message.send` at `kind: "error_handler"`, which lowers exactly like
   * an action and is an error handler purely because its inbound edges carry
   * `port: "error"`.
   */
  kind: NodeKind;
  display_name: string;
  description: string;
  /** The retrieval vocabulary for pass A. Hand-curated; the n8n package has none. */
  aliases: string[];
  /** Names an `AuthDefinition.id` on the owning integration. Absent for `core.*`. */
  auth_required?: string;
  required_scopes?: string[];
  parameters: Record<string, ParameterDefinition>;
  output?: OutputShape;
  rate_limit?: RateLimit;
  /** Present exactly when `kind` is `"trigger"`. */
  trigger?: TriggerSpec;
  /** Capability IDs are never removed; an upstream node that disappears is marked. */
  deprecated?: boolean;
  replaced_by?: string;
}

/**
 * Where a built artifact came from.
 *
 * `hand_written` marks the M4 fixtures. The generator arrives in M20 and must
 * reproduce these files from `n8n-nodes-base@1.62.0` plus the overlay, at which
 * point the flag comes off. Recording it is what keeps "generated" honest in the
 * meantime.
 */
export interface SourceStamp {
  generated_from: string;
  generated_at: string;
  overlay_version: number;
  hand_written?: boolean;
}

/** One `capabilities/<integration>.json` artifact. */
export interface CapabilityFile {
  integration: string;
  display_name: string;
  description: string;
  categories: string[];
  aliases: string[];
  docs_url?: string;
  auth: AuthDefinition[];
  capabilities: Capability[];
  source: SourceStamp;
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

/**
 * What every platform binding carries, whatever the platform.
 *
 * `transform` names a function in the target's closed, unit-tested transform
 * table. Registry data never contains executable code: generated data that can
 * execute is a supply chain, not a config file.
 */
export interface BindingCommon {
  /** Platform params with fixed values, not sourced from FFIR. */
  static_parameters?: Record<string, ParameterValue>;
  /** FFIR parameter name to platform path. Dots mean nesting. */
  parameter_map?: Record<string, string>;
  /** FFIR parameter name to named transform function. */
  transform?: Record<string, string>;
  /** The platform's credential type name. */
  credential_key?: string;
}

export interface N8nBinding extends BindingCommon {
  node_type: string;
  /** Pinned. Bumping it is a deliberate act. */
  type_version: number;
}

export interface MakeBinding extends BindingCommon {
  module: string;
}

export interface ZapierBinding extends BindingCommon {
  app: string;
  action: string;
}

export type Binding = N8nBinding | MakeBinding | ZapierBinding;

export function isN8nBinding(binding: Binding): binding is N8nBinding {
  return "node_type" in binding;
}

/**
 * One `bindings/<platform>/<integration>.json` artifact.
 *
 * Keyed by capability ID because that is the join key to the capability file. A
 * `null` value means "this platform genuinely cannot do this" and degrades
 * cleanly to `http.request.send` with a warning; an absent key means "not yet
 * mapped", which is a registry gap that gets logged for us to fill. The compiler
 * treats them differently, so the format has to be able to say both.
 */
export interface BindingFile {
  integration: string;
  platform: string;
  bindings: Record<string, Binding | null>;
  source: SourceStamp;
}

// ---------------------------------------------------------------------------
// Retrieval index
// ---------------------------------------------------------------------------

/**
 * One row of `index.json`: what pass A needs to know that a thing exists,
 * without needing to know what parameters it takes.
 */
export interface IndexEntry {
  capability_id: string;
  integration: string;
  kind: NodeKind;
  display_name: string;
  description: string;
  aliases: string[];
  categories: string[];
}

/**
 * Integration-level vocabulary, held once rather than repeated on every entry.
 *
 * The whole index sits inline in pass A's cached prompt prefix, so duplicating
 * "slack workspace" across every Slack capability is paid for on every request.
 */
export interface IndexIntegration {
  integration: string;
  display_name: string;
  aliases: string[];
  categories: string[];
}

/** The compact retrieval index. Small enough to hold in memory and to inline. */
export interface RegistryIndex {
  version: string;
  integrations: IndexIntegration[];
  entries: IndexEntry[];
}

// ---------------------------------------------------------------------------
// The loaded registry
// ---------------------------------------------------------------------------

/** A capability file joined with its capabilities, keyed for lookup. */
export interface IntegrationEntry {
  integration: string;
  display_name: string;
  description: string;
  categories: readonly string[];
  aliases: readonly string[];
  docs_url?: string;
  auth: readonly AuthDefinition[];
  /** Sorted by capability ID. */
  capabilities: readonly Capability[];
  source: SourceStamp;
}

/**
 * One immutable, version-keyed registry build, joined and indexed for lookup.
 *
 * A build is content-addressed, published under its version string, and never
 * modified after publication. Stored FFIR pins `metadata.registry_version`, and
 * if that version meant "whatever shipped in the current deploy" then a registry
 * bump would silently change how every previously generated workflow
 * recompiles.
 *
 * Maps are insertion-ordered and every one of them is built from sorted input,
 * so iterating a `Registry` is deterministic.
 */
export interface Registry {
  readonly version: string;
  /** Keyed by integration ID, sorted. */
  readonly integrations: ReadonlyMap<string, IntegrationEntry>;
  /** Keyed by capability ID, sorted. */
  readonly capabilities: ReadonlyMap<string, Capability>;
  /** Platform key to capability ID to binding. A present key with a `null` value is meaningful. */
  readonly bindings: ReadonlyMap<string, ReadonlyMap<string, Binding | null>>;
  /** Platform keys present in this build, sorted. */
  readonly targets: readonly string[];
  readonly index: RegistryIndex;
}
