/**
 * Stage 4: the normalized graph becomes n8n's node and connection model.
 *
 * Every one of the nine FFIR node kinds has a defined lowering. A kind absent
 * from the table below cannot be compiled, and adding a kind to FFIR means
 * adding a row here.
 *
 * | FFIR kind | n8n node type | Connection semantics |
 * | --- | --- | --- |
 * | `trigger` | From the binding. | No inbound. One `main` output. |
 * | `action` | From the binding. | One inbound, `main` output, optional `error` output. |
 * | `transform` | `n8n-nodes-base.set` | One inbound, one `main` output. |
 * | `branch` | `n8n-nodes-base.if` or `.switch` | Two outputs, or one per case. |
 * | `merge` | `n8n-nodes-base.merge` | N inbound mapped to numbered inputs. |
 * | `loop` | `n8n-nodes-base.splitInBatches` | `done` is output 0, `each` is output 1. |
 * | `ai` | From the binding. | One inbound, one `main` output. |
 * | `wait` | `n8n-nodes-base.wait` | One inbound, one `main` output. |
 * | `error_handler` | From the binding. | Inbound only from `error` ports. |
 *
 * Most rows say "from the binding", which is the point: the registry already
 * knows what a capability is on this platform, and a lowering that switched on
 * the integration would be re-deciding it. Only `branch` overrides the binding,
 * because whether a branch is an If or a Switch is a property of the *graph*,
 * not of the capability.
 *
 * `error_handler` is not a distinct n8n node type. It lowers exactly like an
 * action, and what makes it an error handler is purely that its inbound edges
 * carry `port: "error"`. The kind exists in FFIR so the canvas can draw it on a
 * separate track and so validation rule 17 has something to enforce.
 *
 * ## Known weak claims, for M9's manual import gate
 *
 * Two things here are written from n8n's documented shapes rather than from a
 * running instance, and the manual import gate is what settles them.
 *
 * The first is the `error` connection key. COMPILER_ARCHITECTURE's connections
 * example shows an error output as a sibling of `main`, and that is what this
 * emits. Recent n8n also expresses an error output as `main[1]` on a node whose
 * `onError` is `continueErrorOutput`. The frozen document is followed here
 * because it is the specification, and if the import gate disagrees the fix is
 * one line in `connectionsOf` plus a golden-file update.
 *
 * The second is that the fixture bindings themselves are hand-written. A wrong
 * `parameter_map` path produces a workflow that imports cleanly and is missing
 * configuration, which no unit test can catch.
 */

import { DEFAULT_PORT, ERROR_PORT, type ErrorPolicy } from "@flowforge/ffir";
import type { Registry } from "@flowforge/registry";
import { isN8nBinding } from "@flowforge/registry";

import type { CompileWarning } from "../../errors.js";
import type { NormalizedEdge, NormalizedGraph, NormalizedNode } from "../../normalize.js";
import type { CompileContext } from "../../target.js";
import { nodeUuid } from "../../uuid.js";
import { lowerCondition, type ConditionContext } from "./conditions.js";
import type { ExpressionContext } from "./expression.js";
import {
  N8N_ON_ERROR,
  N8N_TARGET_KEY,
  type N8nConnection,
  type N8nConnections,
  type N8nIR,
  type N8nNode,
  type N8nNodeConnections,
} from "./ir.js";
import { layoutGraph } from "./layout.js";
import { mapParameters } from "./parameters.js";

/**
 * The Switch node, which no binding names.
 *
 * `core.branch.if` binds to the If node, because that is what a branch usually
 * is. A branch with three or more cases is a Switch, and since the registry has
 * no capability for it the type has to live here. That is legitimate
 * target-specific knowledge: it is a fact about n8n, in the n8n target.
 */
const SWITCH_NODE = { node_type: "n8n-nodes-base.switch", type_version: 3.2 };

/** n8n's Merge node takes a fixed number of numbered inputs. */
const MERGE_MAX_INPUTS = 10;

/** The placeholder id every emitted credential carries. Never a real value. */
export const CREDENTIAL_PLACEHOLDER = "REPLACE_ME";

/**
 * The loop port mapping, stated explicitly because it is inverted.
 *
 * n8n's Split In Batches puts `done` on output 0 and the loop body on output 1,
 * which is the opposite of both intuition and FFIR's ordering. Writing it as a
 * table rather than as two magic numbers in a branch is the difference between
 * a reader checking it and a reader trusting it.
 */
const LOOP_OUTPUT_INDEX: Record<string, number> = { done: 0, each: 1 };

export function lowerToN8n(graph: NormalizedGraph, ctx: CompileContext): N8nIR {
  const layout = layoutGraph(graph);
  const switchCases = collectSwitchCases(graph);

  const nodes = graph.nodes.map((node) =>
    lowerNode(node, graph, ctx, layout[node.id] ?? { x: 0, y: 0 }, switchCases),
  );

  return {
    target: N8N_TARGET_KEY,
    workflow: {
      name: graph.doc.name,
      nodes,
      connections: connectionsOf(graph, switchCases),
      settings: { executionOrder: "v1" },
      pinData: {},
      meta: { instanceId: "flowforge" },
    },
    layout,
  };
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

function lowerNode(
  node: NormalizedNode,
  graph: NormalizedGraph,
  ctx: CompileContext,
  position: { x: number; y: number },
  switchCases: ReadonlyMap<string, string[]>,
): N8nNode {
  const binding = node.binding;
  if (!isN8nBinding(binding)) {
    // Unreachable through the pipeline: stage 2 resolves against the n8n target
    // and a binding for another platform cannot come back. Failing loudly beats
    // reading `node_type` off something that does not have one.
    throw new Error(`node ${node.id} resolved to a binding that is not an n8n binding`);
  }

  const isSwitch = (switchCases.get(node.id)?.length ?? 0) > 0;
  const workflowId = graph.doc.id;

  const predecessor = immediatePredecessorOf(node, graph);
  const expressions: ExpressionContext = {
    displayNames: graph.displayNames,
    ...(predecessor === undefined ? {} : { immediatePredecessor: predecessor }),
  };

  const mapped = mapParameters({
    parameters: node.parameters,
    templates: node.templates,
    binding,
    workflowId,
    nodeId: node.id,
    expressions,
  });

  for (const warning of parameterWarnings(node, mapped.unmapped)) ctx.warn(warning);
  for (const name of mapped.unknownTransforms) {
    throw new Error(
      `binding for ${node.boundCapability} names transform "${name}", which is not in the closed table`,
    );
  }

  const parameters: Record<string, unknown> = { ...mapped.parameters };
  if (node.node.kind === "branch") {
    Object.assign(
      parameters,
      branchParameters(node, graph, ctx.registry, expressions, switchCases),
    );
    // Both node types want an `options` object. Whatever the binding mapped into
    // it is left alone: `core.branch.if` maps `case_sensitive` to
    // `options.caseSensitive`, which does not look like where n8n's If node
    // reads it from, but second-guessing registry data is not the compiler's
    // job. The condition group carries the same flag where n8n does read it,
    // and M9's manual import gate is what settles the binding.
    if (parameters["options"] === undefined) parameters["options"] = {};
  }
  if (node.node.kind === "merge") {
    Object.assign(parameters, mergeParameters(node, graph));
  }

  triggerWarnings(node, ctx);

  const lowered: N8nNode = {
    id: nodeUuid(workflowId, node.id),
    name: node.displayName,
    type: isSwitch ? SWITCH_NODE.node_type : binding.node_type,
    typeVersion: isSwitch ? SWITCH_NODE.type_version : binding.type_version,
    position: [position.x, position.y],
    parameters,
  };

  const credentials = credentialsOf(node, graph, binding.credential_key);
  if (credentials !== undefined) lowered.credentials = credentials;

  return { ...lowered, ...errorHandling(node, graph, ctx) };
}

/**
 * The node whose output arrives on this one's input, when there is exactly one.
 *
 * A reference to it compiles to `$json` rather than `$('Name').item.json`. With
 * two or more inbound edges there is no single "previous node" and `$json`
 * would silently mean whichever branch happened to arrive.
 */
function immediatePredecessorOf(
  node: NormalizedNode,
  graph: NormalizedGraph,
): string | undefined {
  const inbound = (graph.inbound.get(node.id) ?? []).filter((edge) => !edge.backEdge);
  return inbound.length === 1 ? inbound[0]?.from : undefined;
}

/**
 * A credential placeholder, keyed by the platform's credential type name.
 *
 * `name` comes from the FFIR credential's label, so on import n8n shows an
 * unconfigured credential the user recognizes and can point at a real one. The
 * id is always the placeholder: the compiler emits credential *references*, and
 * the export is intentionally non-functional until someone connects them.
 */
function credentialsOf(
  node: NormalizedNode,
  graph: NormalizedGraph,
  credentialKey: string | undefined,
): Record<string, { id: string; name: string }> | undefined {
  if (credentialKey === undefined || node.node.credential === undefined) return undefined;

  const credential = graph.doc.credentials.find(
    (candidate) => candidate.id === node.node.credential,
  );
  if (credential === undefined) return undefined;

  return { [credentialKey]: { id: CREDENTIAL_PLACEHOLDER, name: credential.label } };
}

/**
 * `onError`, `retryOnFail`, and the retry fields.
 *
 * `stop` is n8n's own default and is left off rather than written out, which
 * keeps a golden file to the decisions the workflow actually made. A node with
 * an outbound error edge is routed regardless of what its policy says, because
 * the edge is the stronger statement: rule 17 required it to exist, and a node
 * whose failures feed a handler has to be told to continue on its error output
 * or the handler never runs.
 */
function errorHandling(
  node: NormalizedNode,
  graph: NormalizedGraph,
  ctx: CompileContext,
): Partial<N8nNode> {
  const policy: ErrorPolicy = node.errorPolicy;
  const routes =
    policy.on_error === "route" ||
    (graph.outbound.get(node.id) ?? []).some((edge) => edge.port === ERROR_PORT);

  const onError = routes ? N8N_ON_ERROR.route : N8N_ON_ERROR[policy.on_error];
  const fields: Partial<N8nNode> = onError === N8N_ON_ERROR.stop ? {} : { onError };

  if (policy.timeout_ms !== undefined) {
    ctx.warn({
      code: "policy_unsupported",
      nodeId: node.id,
      message: `n8n has no per-step timeout, so the ${policy.timeout_ms}ms limit on "${node.displayName}" will not be exported. The step will run until it finishes or the workflow is stopped.`,
    });
  }

  if (policy.retry === undefined) return fields;

  if (policy.retry.backoff === "exponential") {
    ctx.warn({
      code: "policy_unsupported",
      nodeId: node.id,
      message: `n8n waits the same amount before every retry, so the exponential backoff on "${node.displayName}" will be exported as a fixed ${policy.retry.initial_delay_ms}ms wait. The number of attempts is unchanged.`,
    });
  }

  return {
    ...fields,
    retryOnFail: true,
    maxTries: policy.retry.attempts,
    waitBetweenTries: policy.retry.initial_delay_ms,
  };
}

/**
 * The warnings the architecture specifies for parameters n8n cannot carry.
 *
 * Only two cases are named, and only those two are raised. A loop's bound has
 * no n8n equivalent, so it is recorded as advisory rather than pretended; a
 * trigger whose capability polls but whose binding is a webhook has changed
 * mechanism, which makes its polling interval moot.
 *
 * Everything else unmapped is dropped in silence. That is not an oversight: the
 * warning vocabulary is a closed set of five codes with no member for it, and
 * registry build rule 4 only requires a mapping to name a real parameter, not
 * every parameter to have a mapping. `core.loop.for_each`'s `items` is the case
 * that costs something, since n8n's Split In Batches iterates whatever arrives
 * on its input rather than a collection named by the step.
 */
function parameterWarnings(node: NormalizedNode, unmapped: readonly string[]): CompileWarning[] {
  const warnings: CompileWarning[] = [];

  if (node.node.kind === "loop" && unmapped.includes("max_iterations")) {
    warnings.push({
      code: "loop_bound_advisory",
      nodeId: node.id,
      message: `n8n has no maximum-iteration setting, so the limit of ${String(
        node.parameters["max_iterations"],
      )} on "${node.displayName}" is advisory. The loop will run until its input is exhausted, so make sure whatever feeds it is bounded.`,
    });
  }

  return warnings;
}

/**
 * A trigger whose platform mechanism differs from the capability's.
 *
 * BambooHR's capability polls; n8n's binding is a webhook, which is the
 * capability's own declared fallback. The user has to know, because a webhook
 * needs a URL registered with the upstream service and a poller does not.
 */
function triggerWarnings(node: NormalizedNode, ctx: CompileContext): void {
  if (node.node.kind !== "trigger") return;

  const trigger = node.resolved.capability.trigger;
  if (trigger?.fallback === undefined || trigger.fallback === trigger.mechanism) return;

  ctx.warn({
    code: "trigger_mechanism_changed",
    nodeId: node.id,
    message: `"${node.displayName}" is described as a ${trigger.mechanism} trigger, but n8n implements it as a ${trigger.fallback}. You will need to register the workflow's ${trigger.fallback} URL with the service rather than setting a polling interval.`,
  });
}

// ---------------------------------------------------------------------------
// Branch and merge
// ---------------------------------------------------------------------------

/**
 * Which outbound ports of each branch node are switch cases.
 *
 * A branch with exactly the two boolean ports is an If. Anything else is a
 * Switch, and the case order is document edge order: a switch's rules are
 * evaluated in the order they are listed, so this is one of the few arrays
 * whose order is semantically meaningful and must not be sorted.
 */
function collectSwitchCases(graph: NormalizedGraph): ReadonlyMap<string, string[]> {
  const cases = new Map<string, string[]>();

  for (const node of graph.nodes) {
    if (node.node.kind !== "branch") continue;

    const ports = (graph.outbound.get(node.id) ?? [])
      .filter((edge) => edge.port !== ERROR_PORT)
      .map((edge) => edge.port);

    const isBoolean =
      ports.length <= 2 && ports.every((port) => port === "true" || port === "false");
    cases.set(node.id, isBoolean ? [] : distinct(ports));
  }

  return cases;
}

function branchParameters(
  node: NormalizedNode,
  graph: NormalizedGraph,
  registry: Registry,
  expressions: ExpressionContext,
  switchCases: ReadonlyMap<string, string[]>,
): Record<string, unknown> {
  const ctx: ConditionContext = {
    graph,
    registry,
    expressions,
    workflowId: graph.doc.id,
    nodeId: node.id,
    caseSensitive: node.parameters["case_sensitive"] !== false,
  };

  const outbound = (graph.outbound.get(node.id) ?? []).filter(
    (edge) => edge.port !== ERROR_PORT,
  );
  const cases = switchCases.get(node.id) ?? [];

  if (cases.length === 0) {
    // An If node carries the condition from its `true` edge. The `false` edge is
    // the complement and does not restate it.
    const trueEdge = outbound.find((edge) => edge.port === "true");
    const condition = trueEdge?.condition;
    if (condition === undefined) return {};
    return { conditions: lowerCondition(condition, "true", ctx) };
  }

  return {
    rules: {
      values: cases.map((port) => {
        const edge = outbound.find((candidate) => candidate.port === port);
        const condition = edge?.condition;
        return {
          conditions:
            condition === undefined
              ? emptyConditionGroup(ctx.caseSensitive)
              : lowerCondition(condition, port, ctx),
          renameOutput: true,
          outputKey: port,
        };
      }),
    },
  };
}

function emptyConditionGroup(caseSensitive: boolean): unknown {
  return {
    options: { caseSensitive, leftValue: "", typeValidation: "loose", version: 2 },
    conditions: [],
    combinator: "and",
  };
}

/**
 * The Merge node's input count.
 *
 * n8n needs to be told how many inputs to draw. The FFIR `mode` parameter is
 * already mapped by the binding; this only adds the arity, which is a property
 * of the graph rather than of the capability.
 */
function mergeParameters(
  node: NormalizedNode,
  graph: NormalizedGraph,
): Record<string, unknown> {
  const inbound = mergeInputsOf(node.id, graph);
  return { numberInputs: Math.max(2, Math.min(inbound.length, MERGE_MAX_INPUTS)) };
}

/**
 * A merge node's inbound edges, sorted by source node id.
 *
 * Edge *i* connects to input index *i*. Sorting by source id rather than by
 * document edge order means reordering the edge list cannot silently swap which
 * branch lands on input 1, which for a `chooseBranch` merge changes what the
 * workflow does.
 */
function mergeInputsOf(nodeId: string, graph: NormalizedGraph): NormalizedEdge[] {
  return [...(graph.inbound.get(nodeId) ?? [])]
    .filter((edge) => !edge.backEdge)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.index - b.index));
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

/**
 * n8n's `connections`, keyed by source node display name.
 *
 * The nesting is `[outputIndex][connectionIndex]`. Output index comes from the
 * FFIR port: `main` and `true` are 0, `false` is 1, a loop's `done` is 0 and its
 * `each` is 1, and a switch case is its position in the rules. The `error` port
 * gets its own key rather than an index, following the connections example in
 * COMPILER_ARCHITECTURE.
 *
 * A loop's back-edge is an ordinary `main` connection into the loop node. There
 * is nothing special to do: n8n closes the loop the same way FFIR does.
 */
function connectionsOf(
  graph: NormalizedGraph,
  switchCases: ReadonlyMap<string, string[]>,
): N8nConnections {
  const connections: N8nConnections = {};

  // Node order rather than insertion order, so the object's keys read top to
  // bottom the same way the nodes array does.
  for (const node of graph.nodes) {
    const outbound = graph.outbound.get(node.id) ?? [];
    if (outbound.length === 0) continue;

    const forNode: N8nNodeConnections = {};

    for (const edge of outbound) {
      const key = edge.port === ERROR_PORT ? ERROR_PORT : DEFAULT_PORT;
      const index =
        edge.port === ERROR_PORT ? 0 : outputIndexOf(node, edge, switchCases);

      const outputs = (forNode[key] ??= []);
      while (outputs.length <= index) outputs.push(null);

      const slot = outputs[index] ?? [];
      slot.push({
        node: graph.displayNames.get(edge.to) ?? edge.to,
        type: DEFAULT_PORT,
        index: inputIndexOf(edge, graph),
      });
      outputs[index] = slot;
    }

    // A gap left by a port that has no edges stays null, because the array
    // position is what identifies the output. Trailing nulls are trimmed: they
    // carry no information and would differ between two workflows that behave
    // identically.
    for (const key of Object.keys(forNode)) {
      const outputs = forNode[key] as (N8nConnection[] | null)[];
      while (outputs.length > 0 && outputs[outputs.length - 1] === null) outputs.pop();
    }

    connections[node.displayName] = forNode;
  }

  return connections;
}

function outputIndexOf(
  node: NormalizedNode,
  edge: NormalizedEdge,
  switchCases: ReadonlyMap<string, string[]>,
): number {
  if (node.node.kind === "loop") return LOOP_OUTPUT_INDEX[edge.port] ?? 0;

  if (node.node.kind === "branch") {
    const cases = switchCases.get(node.id) ?? [];
    if (cases.length > 0) return Math.max(0, cases.indexOf(edge.port));
    return edge.port === "false" ? 1 : 0;
  }

  return 0;
}

/**
 * The input index on the receiving node.
 *
 * Zero for everything except a Merge, whose inputs are numbered and whose
 * inbound edges are assigned to them in sorted order.
 */
function inputIndexOf(edge: NormalizedEdge, graph: NormalizedGraph): number {
  const target = graph.byId.get(edge.to);
  if (target?.node.kind !== "merge") return 0;

  const inputs = mergeInputsOf(edge.to, graph);
  const at = inputs.findIndex((candidate) => candidate.index === edge.index);
  return at === -1 ? 0 : Math.min(at, MERGE_MAX_INPUTS - 1);
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}
