/**
 * The inline retriever: the whole catalog in the cached prefix.
 *
 * Right for the MVP registry and wrong past a few hundred capabilities. At this
 * size the catalog is roughly six thousand tokens, it is byte-identical across
 * every request, and it sits behind a cache breakpoint, so after the first
 * request it costs about a tenth of base input. That is cheaper than any
 * retrieval call would be, and it has a property no retrieval call has: the
 * model sees everything, so "it only picked from things that exist" is true by
 * construction rather than by hoping the search was good.
 *
 * ## Both renderings are text, not JSON
 *
 * AI_SPEC names the fields the catalog carries and not their encoding. A line
 * format costs meaningfully fewer tokens than the equivalent JSON for the same
 * content, on a block that is paid for on every uncached request, and it reads
 * better in a prompt. Determinism, which is the property that actually matters
 * here, comes from the registry index being sorted at build time rather than
 * from the syntax.
 *
 * ## What the bundle carries, and what it deliberately does not
 *
 * The bundle carries three things the synthesized schema cannot: the validation
 * constraints structured outputs rejects (`pattern`, `min_length`, ranges),
 * concrete examples, and the **output shape** of every capability. Parameter
 * descriptions are not repeated here, because they already travel in the
 * schema's `description` fields and paying for them twice on every pass B call
 * is a real cost for no added signal.
 *
 * The output shapes are the part that earns its place. Pass B needs to know
 * that `bamboohr.employee.created` emits `employee.first_name` in order to
 * write `{{ n_trigger.employee.first_name }}`. Without them the model invents
 * field names that look right, which is precisely the failure this whole
 * architecture exists to prevent.
 */

import {
  compareStrings,
  resolve,
  type AuthDefinition,
  type Capability,
  type IndexEntry,
  type OutputField,
  type ParameterDefinition,
  type ParameterValue,
  type Registry,
  type ResolvedCapability,
} from "@flowforge/registry";

import type { CapabilityRetriever, SchemaBundle } from "./types.js";

export const INLINE_RETRIEVER_KEY = "inline";

export class InlineRetriever implements CapabilityRetriever {
  readonly key = INLINE_RETRIEVER_KEY;

  catalog(registry: Registry): string {
    return renderCatalog(registry);
  }

  bundle(registry: Registry, capabilityIds: readonly string[]): SchemaBundle {
    return renderBundle(registry, capabilityIds);
  }
}

/**
 * The capability catalog.
 *
 * Integration vocabulary is stated once per integration rather than repeated on
 * every capability, because the whole block sits inline in the cached prefix
 * and "slack workspace" duplicated across every Slack capability is paid for on
 * every request that misses the cache.
 */
export function renderCatalog(registry: Registry): string {
  const lines: string[] = [];
  lines.push(`# Capability catalog (registry ${registry.index.version})`);
  lines.push("");
  lines.push(
    "Every step must reference one of these capability IDs exactly. The `aka` lines are how people phrase the same thing; they are not IDs.",
  );

  for (const integration of registry.index.integrations) {
    const entries = registry.index.entries.filter(
      (entry) => entry.integration === integration.integration,
    );
    if (entries.length === 0) continue;

    lines.push("");
    lines.push(
      `## ${integration.integration} | ${integration.display_name} | ${integration.categories.join(", ")}`,
    );
    if (integration.aliases.length > 0) {
      lines.push(`aka: ${integration.aliases.join(", ")}`);
    }
    for (const entry of entries) lines.push(...capabilityLines(entry));
  }

  return `${lines.join("\n")}\n`;
}

function capabilityLines(entry: IndexEntry): string[] {
  const lines = [
    `${entry.capability_id} | ${entry.kind} | ${entry.display_name} | ${entry.description}`,
  ];
  if (entry.aliases.length > 0) lines.push(`  aka: ${entry.aliases.join(", ")}`);
  return lines;
}

/**
 * The schema bundle for one workflow.
 *
 * Capabilities are de-duplicated and sorted, so a plan using `slack.message.send`
 * on three nodes pays for its schema once, and two plans naming the same set
 * produce the same bundle whatever order the nodes came in.
 */
export function renderBundle(
  registry: Registry,
  capabilityIds: readonly string[],
): SchemaBundle {
  const unique = [...new Set(capabilityIds)].sort(compareStrings);

  const resolved: ResolvedCapability[] = [];
  const unknown: string[] = [];
  for (const id of unique) {
    const entry = resolve(registry, id);
    if (entry === undefined) unknown.push(id);
    else resolved.push(entry);
  }

  const lines: string[] = ["# Capability details", ""];
  lines.push(
    "Parameter names and types are enforced by the output schema. This section adds what a schema cannot state: the format rules a value must satisfy, worked examples, and the fields each step emits.",
  );

  for (const entry of resolved) {
    lines.push("");
    lines.push(...capabilityBlock(entry));
  }

  return {
    text: `${lines.join("\n")}\n`,
    resolved: resolved.map((entry) => entry.id),
    unknown,
  };
}

function capabilityBlock(entry: ResolvedCapability): string[] {
  const capability = entry.capability;
  const lines: string[] = [];

  lines.push(`## ${capability.id} | ${capability.display_name}`);
  lines.push(capability.description);

  const auth = describeAuth(entry.auth, capability);
  if (auth !== undefined) lines.push(auth);

  const parameters = Object.entries(capability.parameters);
  if (parameters.length > 0) {
    lines.push("Parameters:");
    for (const [name, definition] of parameters) {
      lines.push(`- ${name}${parameterNotes(definition)}`);
    }
  }

  const outputs = flattenOutputs(capability.output);
  if (outputs.length > 0) {
    lines.push("Emits (reference as {{ <node id>.<field> }}):");
    for (const output of outputs) lines.push(`- ${output}`);
  } else {
    lines.push("Emits: nothing referenceable. Do not write expressions against this step.");
  }

  return lines;
}

function describeAuth(
  auth: AuthDefinition | undefined,
  capability: Capability,
): string | undefined {
  if (auth === undefined) return undefined;
  const scopes = capability.required_scopes ?? [];
  const suffix = scopes.length === 0 ? "" : `, scopes ${scopes.join(" ")}`;
  return `Credential: ${auth.label} (${auth.type}${suffix}).`;
}

/**
 * The constraints and examples for one parameter.
 *
 * Everything here is something the JSON schema cannot express. `required` is
 * stated anyway because the schema's own `required` list follows a rule about
 * sentinel values rather than about the registry, and a model reading only the
 * schema would conclude an optional-with-default parameter is discretionary,
 * which it is, and that a required-with-a-pattern one is too, which it is not.
 */
function parameterNotes(definition: ParameterDefinition): string {
  const parts: string[] = [definition.type];
  parts.push(definition.required ? "required" : "optional");
  if (definition.default !== undefined) {
    parts.push(`default ${format(definition.default)}`);
  }

  const rules = definition.validation;
  if (rules?.pattern !== undefined) parts.push(`must match ${rules.pattern}`);
  if (rules?.one_of !== undefined) {
    parts.push(`one of ${rules.one_of.map(format).join(", ")}`);
  }
  if (rules?.min !== undefined || rules?.max !== undefined) {
    parts.push(`range ${rules.min ?? "any"} to ${rules.max ?? "any"}`);
  }
  if (rules?.min_length !== undefined || rules?.max_length !== undefined) {
    parts.push(`length ${rules.min_length ?? 0} to ${rules.max_length ?? "any"}`);
  }
  if (rules?.not_empty === true) parts.push("must not be empty");

  const when = definition.conditional_required?.when;
  if (when !== undefined) {
    parts.push(`required when ${Object.keys(when).join(" and ")} is in the stated state`);
  }

  const head = `(${parts.join(", ")})`;
  return definition.example === undefined
    ? ` ${head}`
    : ` ${head} e.g. ${format(definition.example)}`;
}

/**
 * Output fields as dotted paths.
 *
 * Flattened rather than nested because an expression is written as a path, and
 * a model reading a nested structure has to assemble one. Handing it
 * `employee.first_name` directly removes a step it can get wrong.
 */
export function flattenOutputs(
  shape: Readonly<Record<string, OutputField>> | undefined,
  prefix = "",
): string[] {
  if (shape === undefined) return [];

  const lines: string[] = [];
  for (const [name, field] of Object.entries(shape)) {
    const path = prefix === "" ? name : `${prefix}.${name}`;

    if (field.type === "object" && field.fields !== undefined) {
      lines.push(...flattenOutputs(field.fields, path));
      continue;
    }

    if (field.type === "array" && field.items !== undefined) {
      const item = field.items;
      if (item.type === "object" && item.fields !== undefined) {
        lines.push(...flattenOutputs(item.fields, `${path}[]`));
        continue;
      }
      lines.push(describeField(`${path}[]`, item));
      continue;
    }

    lines.push(describeField(path, field));
  }
  return lines;
}

function describeField(path: string, field: OutputField): string {
  return field.description === undefined
    ? `${path}: ${field.type}`
    : `${path}: ${field.type} — ${field.description}`;
}

/** Compact, and stable: no whitespace variation between runs. */
function format(value: ParameterValue): string {
  return JSON.stringify(value);
}
