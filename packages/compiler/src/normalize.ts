/**
 * Stage 3: target-independent cleanup, producing the intermediate
 * compilation representation.
 *
 * A `NormalizedGraph` is what every target's stage 4 consumes. Five things
 * happen here, all of them once:
 *
 * 1. Registry `default` values fill absent optional parameters.
 * 2. An absent `error_policy` gets the workflow default: stop, no retry.
 * 3. Every expression string is parsed into an AST.
 * 4. Nodes are topologically sorted from the trigger.
 * 5. Node ids are mapped to stable display names.
 *
 * ## Why the expression parse belongs here
 *
 * Because it must happen exactly once. If each target rewrote expression
 * strings with its own regex, escaping bugs would be per-target and would be
 * found by users rather than by tests. Downstream stages receive structured
 * references and never see raw text, so a target cannot accidentally invent a
 * fourth interpretation of `{{`.
 *
 * Templates are built for *every* string a node carries, not only the ones with
 * braces in them. A target that prefixes expression-bearing parameters, as n8n
 * does with `=`, has to be able to tell a template carrying a reference from
 * one that is only text, and asking it to re-scan the raw string for `{{` would
 * put the parse back in the target.
 *
 * ## Determinism
 *
 * Same input, same graph, always. Three specific guarantees, each with a test:
 *
 * - Node order comes from a topological sort whose ties break on node id, so
 *   independent branches cannot swap.
 * - Parameter keys are emitted in the registry's declaration order rather than
 *   the document's, so two documents differing only in JSON key order normalize
 *   to the same thing.
 * - Display names are assigned in document order, not topological order. That
 *   is the weaker-looking choice and the right one: rewiring an edge changes
 *   the topological order, and if names followed it then adding a connection
 *   could rename an unrelated node, breaking every expression that referenced
 *   it by name.
 */

import {
  buildGraphModel,
  parseTemplate,
  type Condition,
  type ConditionOperator,
  type Edge,
  type ErrorPolicy,
  type FFIRDocument,
  type Node,
  type ParameterValue,
  type Parameters,
  type Template,
} from "@flowforge/ffir";
import type {
  Binding,
  Capability,
  ParameterDefinition,
  Registry,
  ResolvedTargetCapability,
} from "@flowforge/registry";

import {
  failed,
  ok,
  type CompileError,
  type CompileResult,
  type CompileWarning,
} from "./errors.js";
import type { ResolvedNode } from "./resolve.js";

/**
 * The workflow default applied to any node that declares no policy of its own.
 *
 * Stop, and do not retry. The conservative choice: a node that failed and was
 * silently continued past produces a workflow that half-ran, which is harder to
 * diagnose than one that stopped where the problem is.
 */
export const DEFAULT_ERROR_POLICY: ErrorPolicy = { on_error: "stop" };

export interface NormalizedCondition {
  operator: ConditionOperator;
  left: Template;
  /** Absent for `is_empty` and `is_not_empty`, which take no right operand. */
  right?: Template;
}

export interface NormalizedEdge {
  edge: Edge;
  /** Index into `doc.edges`. */
  index: number;
  from: string;
  to: string;
  /** `edge.port` with the `"main"` default applied. */
  port: string;
  /**
   * True when this edge closes a loop: it runs from inside a loop's body back
   * into the loop node. Excluded from the topological sort, which would
   * otherwise not terminate.
   */
  backEdge: boolean;
  condition?: NormalizedCondition;
}

export interface NormalizedNode {
  id: string;
  /** The original FFIR node, unmodified. */
  node: Node;
  /** Index into `doc.nodes`, so document order survives the sort. */
  index: number;
  /** Position in topological order, equal to this node's index in `graph.nodes`. */
  order: number;
  resolved: ResolvedTargetCapability;
  /** The binding lowering will use: the fallback's when this node degraded. */
  binding: Binding;
  degraded: boolean;
  boundCapability: string;
  /** Registry defaults applied, keys in registry declaration order. */
  parameters: Parameters;
  /**
   * Every string in `parameters`, parsed, keyed by JSON Pointer relative to the
   * parameters object. `"/text"`, `"/assignments/0/value"`.
   */
  templates: ReadonlyMap<string, Template>;
  errorPolicy: ErrorPolicy;
  /** Unique across the workflow. What a target references this node by. */
  displayName: string;
}

/**
 * The intermediate compilation representation.
 *
 * Contains no platform vocabulary. If a reader can tell which automation
 * platform this compiles to from this interface, the abstraction has leaked.
 */
export interface NormalizedGraph {
  doc: FFIRDocument;
  /** The target key this was resolved for. Bindings are already target-specific. */
  target: string;
  registryVersion: string;
  /** Topologically sorted from the trigger. */
  nodes: readonly NormalizedNode[];
  byId: ReadonlyMap<string, NormalizedNode>;
  /** In document order, including back-edges. */
  edges: readonly NormalizedEdge[];
  outbound: ReadonlyMap<string, readonly NormalizedEdge[]>;
  inbound: ReadonlyMap<string, readonly NormalizedEdge[]>;
  trigger: NormalizedNode;
  /** Node id to display name. Every reference to a node goes through this. */
  displayNames: ReadonlyMap<string, string>;
}

export function normalize(
  doc: FFIRDocument,
  resolvedNodes: readonly ResolvedNode[],
  registry: Registry,
  target: string,
): CompileResult<NormalizedGraph> {
  const errors: CompileError[] = [];
  const warnings: CompileWarning[] = [];

  const model = buildGraphModel(doc);
  const displayNames = assignDisplayNames(resolvedNodes);

  const built = new Map<string, NormalizedNode>();
  for (const entry of resolvedNodes) {
    const parameters = applyDefaults(entry.node.parameters, entry.resolved.capability);
    const templates = parseParameters(parameters, doc.expression_grammar, errors, entry.node);

    built.set(entry.node.id, {
      id: entry.node.id,
      node: entry.node,
      index: entry.index,
      order: 0, // Replaced once the sort runs.
      resolved: entry.resolved,
      binding: entry.binding,
      degraded: entry.degraded,
      boundCapability: entry.boundCapability,
      parameters,
      templates,
      errorPolicy: entry.node.error_policy ?? DEFAULT_ERROR_POLICY,
      displayName: displayNames.get(entry.node.id) ?? entry.node.id,
    });
  }

  const edges = model.edges.map((entry) =>
    normalizeEdge(entry.edge, entry.index, entry.port, model.backEdges.has(entry.index), doc, errors),
  );

  const trigger = resolvedNodes.find((entry) => entry.node.kind === "trigger");
  if (trigger === undefined) {
    errors.push({
      stage: "validate",
      code: "missing_trigger",
      message:
        "The workflow has no trigger node, so there is no node to sort from. Stage 4 of validation should have caught this.",
    });
  }

  if (errors.length > 0) return failed(errors, warnings);

  const order = topologicalOrder(built, edges, trigger?.node.id);
  const nodes = order.map((id, position) => {
    const node = built.get(id);
    if (node === undefined) throw new Error(`unreachable: ${id} was sorted but not built`);
    return { ...node, order: position };
  });

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const triggerNode = trigger === undefined ? undefined : byId.get(trigger.node.id);
  if (triggerNode === undefined) {
    return failed([
      {
        stage: "verify",
        code: "internal_inconsistency",
        detail: "the trigger node did not survive normalization",
      },
    ], warnings);
  }

  return ok(
    {
      doc,
      target,
      registryVersion: registry.version,
      nodes,
      byId,
      edges,
      outbound: groupBy(edges, (edge) => edge.from),
      inbound: groupBy(edges, (edge) => edge.to),
      trigger: triggerNode,
      displayNames,
    },
    warnings,
  );
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/**
 * Fills absent optional parameters from the registry, and pins key order.
 *
 * Declared parameters come first, in the registry's declaration order, which is
 * what makes two documents that differ only in JSON key order normalize
 * identically. Anything the node carries that the registry does not declare is
 * appended in its original order; validation stage 3 rejects those, so in a
 * document that reached here there are none, and dropping them silently would
 * be a worse way to handle a case that cannot happen.
 *
 * Defaults recurse into declared `object` parameters that are present, so a
 * partially specified options block gets the rest of its defaults. They do not
 * recurse into arrays: there is no principled answer to how many times an
 * element default should apply.
 */
export function applyDefaults(
  parameters: Parameters,
  capability: Capability,
): Parameters {
  return fillObject(parameters, capability.parameters);
}

function fillObject(
  value: Parameters,
  declared: Record<string, ParameterDefinition>,
): Parameters {
  const filled: Parameters = {};

  for (const [name, definition] of Object.entries(declared)) {
    const present = Object.prototype.hasOwnProperty.call(value, name);
    const current = present ? value[name] : undefined;

    if (!present) {
      if (definition.default !== undefined) filled[name] = definition.default;
      continue;
    }

    filled[name] =
      definition.fields !== undefined && isPlainObject(current)
        ? fillObject(current as Parameters, definition.fields)
        : (current as ParameterValue);
  }

  for (const name of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(filled, name)) {
      filled[name] = value[name] as ParameterValue;
    }
  }

  return filled;
}

function isPlainObject(value: unknown): value is Record<string, ParameterValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses every string in a parameter tree, keyed by pointer.
 *
 * A parse failure here should be unreachable: validation stage 4 parses the
 * same strings under the same grammar and rejects the document. It is reported
 * as a `validate` error rather than thrown, because the alternative is a stack
 * trace escaping a function documented as pure.
 */
function parseParameters(
  parameters: Parameters,
  grammar: string,
  errors: CompileError[],
  node: Node,
): ReadonlyMap<string, Template> {
  const templates = new Map<string, Template>();

  walkStrings(parameters, "", (pointer, value) => {
    const parsed = parseTemplate(value, grammar, { path: pointer });
    if (!parsed.ok) {
      for (const error of parsed.errors) {
        errors.push({
          stage: "validate",
          code: error.code,
          nodeId: node.id,
          message: error.message,
          path: pointer,
        });
      }
      return;
    }
    templates.set(pointer, parsed.template);
  });

  return templates;
}

/**
 * Visits every string in a JSON value, depth first, in a fixed order.
 *
 * Object keys are visited in insertion order, which `applyDefaults` has already
 * pinned to the registry's declaration order, so the pointer set a node
 * produces does not depend on how its JSON was written.
 */
function walkStrings(
  value: ParameterValue,
  pointer: string,
  visit: (pointer: string, value: string) => void,
): void {
  if (typeof value === "string") {
    visit(pointer, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, `${pointer}/${index}`, visit));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      walkStrings(child as ParameterValue, `${pointer}/${escapePointerSegment(key)}`, visit);
    }
  }
}

/** RFC 6901 escaping. `~` first, or the `/` escape would be re-escaped. */
function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

function normalizeEdge(
  edge: Edge,
  index: number,
  port: string,
  backEdge: boolean,
  doc: FFIRDocument,
  errors: CompileError[],
): NormalizedEdge {
  const normalized: NormalizedEdge = {
    edge,
    index,
    from: edge.from,
    to: edge.to,
    port,
    backEdge,
  };

  if (edge.condition === undefined) return normalized;

  const condition = normalizeCondition(edge.condition, index, doc, errors);
  return condition === undefined ? normalized : { ...normalized, condition };
}

/**
 * A condition's operands are expression sites like any other, and are parsed
 * here for the same reason parameters are: a target comparing raw strings would
 * be re-implementing the parser to find out whether the left side is a
 * reference.
 */
function normalizeCondition(
  condition: Condition,
  index: number,
  doc: FFIRDocument,
  errors: CompileError[],
): NormalizedCondition | undefined {
  const left = parseTemplate(condition.left, doc.expression_grammar, {
    path: `/edges/${index}/condition/left`,
  });
  if (!left.ok) {
    errors.push(...left.errors.map((error) => conditionError(error, index)));
    return undefined;
  }

  if (condition.right === undefined) {
    return { operator: condition.operator, left: left.template };
  }

  const right = parseTemplate(condition.right, doc.expression_grammar, {
    path: `/edges/${index}/condition/right`,
  });
  if (!right.ok) {
    errors.push(...right.errors.map((error) => conditionError(error, index)));
    return undefined;
  }

  return { operator: condition.operator, left: left.template, right: right.template };
}

function conditionError(
  error: { code: string; message: string; path: string },
  index: number,
): CompileError {
  return {
    stage: "validate",
    code: error.code,
    message: error.message,
    path: error.path === "" ? `/edges/${index}/condition` : error.path,
  };
}

// ---------------------------------------------------------------------------
// Display names
// ---------------------------------------------------------------------------

/**
 * Node id to a unique display name.
 *
 * Targets reference nodes by name rather than by id, n8n among them, so two
 * nodes sharing a label would produce a workflow whose references are
 * ambiguous. The first node to claim a label keeps it and later ones get a
 * numeric suffix; the counter skips past any suffix a document already uses
 * literally, so a workflow containing both "Notify" and "Notify 2" does not end
 * up with two nodes called "Notify 2".
 *
 * Assignment follows document order. See the module comment for why that beats
 * topological order.
 */
export function assignDisplayNames(
  nodes: readonly ResolvedNode[],
): ReadonlyMap<string, string> {
  const taken = new Set<string>();
  const names = new Map<string, string>();

  const inDocumentOrder = [...nodes].sort((a, b) => a.index - b.index);

  for (const entry of inDocumentOrder) {
    // A label that is absent or whitespace leaves nothing to reference the node
    // by, and the id is the one thing guaranteed unique.
    const base = entry.node.label.trim() === "" ? entry.node.id : entry.node.label.trim();

    let candidate = base;
    let suffix = 1;
    while (taken.has(candidate)) {
      suffix += 1;
      candidate = `${base} ${suffix}`;
    }

    taken.add(candidate);
    names.set(entry.node.id, candidate);
  }

  return names;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Kahn's algorithm, seeded at the trigger, ties broken on node id.
 *
 * Back-edges are excluded before counting in-degrees. A loop's back-edge is a
 * genuine cycle in the edge list and the graph validator permits exactly it, so
 * a sort that counted it would find no node of in-degree zero inside the loop
 * body and would stall.
 *
 * Nodes the trigger cannot reach are appended in id order rather than dropped.
 * Validation rule 3 rejects an unreachable node, so this cannot happen through
 * the pipeline; it matters because dropping a node silently is how a compiler
 * emits a workflow that is missing a step.
 */
export function topologicalOrder(
  nodes: ReadonlyMap<string, NormalizedNode>,
  edges: readonly NormalizedEdge[],
  triggerId: string | undefined,
): string[] {
  const forward = edges.filter((edge) => !edge.backEdge);

  const indegree = new Map<string, number>();
  for (const id of nodes.keys()) indegree.set(id, 0);
  for (const edge of forward) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const successors = new Map<string, string[]>();
  for (const edge of forward) {
    const list = successors.get(edge.from);
    if (list === undefined) successors.set(edge.from, [edge.to]);
    else list.push(edge.to);
  }

  // The trigger leads even if something else also has in-degree zero, because
  // the sort is specified as being *from the trigger*.
  const ready = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
    .sort(compareIds);
  if (triggerId !== undefined && ready.includes(triggerId)) {
    ready.splice(ready.indexOf(triggerId), 1);
    ready.unshift(triggerId);
  }

  const sorted: string[] = [];
  const emitted = new Set<string>();

  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined || emitted.has(id)) continue;
    emitted.add(id);
    sorted.push(id);

    const next: string[] = [];
    for (const successor of successors.get(id) ?? []) {
      const remaining = (indegree.get(successor) ?? 0) - 1;
      indegree.set(successor, remaining);
      if (remaining === 0 && !emitted.has(successor)) next.push(successor);
    }

    // Merge rather than push-then-sort: the ready list is already ordered, and
    // re-sorting it would let a newly freed node overtake one that has been
    // waiting, making order depend on when a node was freed.
    for (const candidate of next.sort(compareIds)) {
      const at = ready.findIndex((existing) => compareIds(candidate, existing) < 0);
      if (at === -1) ready.push(candidate);
      else ready.splice(at, 0, candidate);
    }
  }

  const stranded = [...nodes.keys()].filter((id) => !emitted.has(id)).sort(compareIds);
  return [...sorted, ...stranded];
}

/** Codepoint order. `localeCompare` answers differently on different machines. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function groupBy(
  edges: readonly NormalizedEdge[],
  key: (edge: NormalizedEdge) => string,
): ReadonlyMap<string, readonly NormalizedEdge[]> {
  const grouped = new Map<string, NormalizedEdge[]>();
  for (const edge of edges) {
    const id = key(edge);
    const list = grouped.get(id);
    if (list === undefined) grouped.set(id, [edge]);
    else list.push(edge);
  }
  return grouped;
}
