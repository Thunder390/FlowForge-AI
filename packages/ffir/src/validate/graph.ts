/**
 * Validation stage 4: the graph-level invariants.
 *
 * Implements the rules from docs/WORKFLOW_SCHEMA.md that need only the document
 * itself. Rules 7, 8, and 13 are deliberately absent: they resolve capabilities
 * and parameter schemas against the node registry, and `ffir` must not depend on
 * `registry`. They are stages 2 and 3, owned by `ai`. `RULE_OWNERSHIP` below
 * records that split in code so it cannot quietly drift.
 *
 * Two properties this module is built around:
 *
 * **Every failure is collected.** The repair prompt needs the complete list to
 * fix everything in one retry, and a validator that stops at the first error
 * turns one repair cycle into five.
 *
 * **The output is deterministic.** Rules run in rule-number order and each one
 * iterates the document's own arrays, so the same document always produces the
 * same errors in the same order. A repair prompt that reorders itself between
 * runs makes a caching layer and a regression test both useless.
 *
 * Stage 4 assumes stages 0 and 1 have passed, which is what earns the
 * `FFIRDocument` parameter type rather than `unknown`.
 */

import { referenceDepth, type Reference } from "../expression/ast.js";
import { checkGrammar, parseTemplate } from "../expression/parse.js";
import { pointer } from "../pointer.js";
import type { FFIRDocument, Node, ParameterValue } from "../types.js";
import { ErrorCode } from "./codes.js";
import {
  buildGraphModel,
  ERROR_PORT,
  inboundOf,
  integrationOf,
  outboundOf,
  predecessorsOf,
  reachableFrom,
  type GraphModel,
} from "./graph-model.js";
import { invalid, type ValidationError, type ValidationResult } from "./result.js";
import { findSecret } from "./secrets.js";

/**
 * Which package owns each numbered rule in WORKFLOW_SCHEMA.
 *
 * Rules 7, 8, and 13 need the registry, and the architecture's third invariant
 * is that the layers holding registry knowledge stay separate from `ffir`. This
 * table exists so that "stage 4 implements rules 1 through 18" is not read as a
 * promise this module breaks silently.
 */
export const RULE_OWNERSHIP: Readonly<Record<number, "ffir" | "registry">> = {
  1: "ffir",
  2: "ffir",
  3: "ffir",
  4: "ffir",
  5: "ffir",
  6: "ffir",
  7: "registry",
  8: "registry",
  9: "ffir",
  10: "ffir",
  11: "ffir",
  12: "ffir",
  13: "registry",
  14: "ffir",
  15: "ffir",
  16: "ffir",
  17: "ffir",
  18: "ffir",
};

/** The rule numbers this module checks, in the order it checks them. */
export const GRAPH_RULES: readonly number[] = Object.keys(RULE_OWNERSHIP)
  .map(Number)
  .filter((rule) => RULE_OWNERSHIP[rule] === "ffir")
  .sort((a, b) => a - b);

/**
 * Runs every stage 4 rule and returns all failures.
 *
 * The document must already have passed stages 0 and 1.
 */
export function checkGraph(doc: FFIRDocument): ValidationResult {
  const model = buildGraphModel(doc);
  const errors: ValidationError[] = [];

  checkEdgeEndpoints(model, errors); // 1
  checkDuplicateIds(model, errors); // 2
  checkTriggerCount(model, errors); // 3
  checkTriggerInbound(model, errors); // 4
  checkReachability(model, errors); // 5
  checkAcyclic(model, errors); // 6
  checkCredentialRefs(model, errors); // 9
  checkCapabilityScopes(model, errors); // 10
  checkExpressions(model, errors); // 11, 12
  checkSecrets(model, errors); // 14
  checkSensitiveDefaults(model, errors); // 15
  checkLoopBounds(model, errors); // 16
  checkErrorRoutes(model, errors); // 17
  checkBranchOutbound(model, errors); // 18

  return invalid(errors);
}

// ---------------------------------------------------------------------------
// Structural: rules 1 to 6
// ---------------------------------------------------------------------------

/** Rule 1. Every `from` and `to` names an existing node. */
function checkEdgeEndpoints(model: GraphModel, errors: ValidationError[]): void {
  model.doc.edges.forEach((edge, index) => {
    for (const end of ["from", "to"] as const) {
      const id = edge[end];
      if (model.nodesById.has(id)) continue;
      errors.push({
        code: ErrorCode.EDGE_ENDPOINT_MISSING,
        path: pointer("edges", index, end),
        message: `Edge "${edge.id}" points ${end} node "${id}", which does not exist.`,
        details: { edge_id: edge.id, end, node_id: id },
      });
    }
  });
}

/**
 * Rule 2. Node, edge, and credential ids are each unique.
 *
 * Three separate namespaces, as the rule states them. A node and an edge
 * sharing an id is legal and harmless: nothing resolves an id without already
 * knowing which collection it belongs to.
 */
function checkDuplicateIds(model: GraphModel, errors: ValidationError[]): void {
  reportDuplicates(model.doc.nodes, "nodes", "Node", errors);
  reportDuplicates(model.doc.edges, "edges", "Edge", errors);
  reportDuplicates(model.doc.credentials, "credentials", "Credential", errors);
}

function reportDuplicates(
  items: readonly { id: string }[],
  collection: string,
  what: string,
  errors: ValidationError[],
): void {
  const firstIndex = new Map<string, number>();
  items.forEach((item, index) => {
    const first = firstIndex.get(item.id);
    if (first === undefined) {
      firstIndex.set(item.id, index);
      return;
    }
    errors.push({
      code: ErrorCode.DUPLICATE_ID,
      path: pointer(collection, index, "id"),
      message: `${what} id "${item.id}" is already used at ${collection}[${first}]. Ids must be unique within their collection.`,
      details: { collection, id: item.id, first_index: first, duplicate_index: index },
    });
  });
}

/** Rule 3. Exactly one trigger. */
function checkTriggerCount(model: GraphModel, errors: ValidationError[]): void {
  const triggers = triggerNodes(model);
  if (triggers.length === 1) return;

  errors.push({
    code: ErrorCode.TRIGGER_COUNT_INVALID,
    path: pointer("nodes"),
    message:
      triggers.length === 0
        ? "A workflow needs exactly one trigger node and has none, so nothing would ever start it."
        : `A workflow needs exactly one trigger node and has ${triggers.length}: ${triggers.map((n) => `"${n.id}"`).join(", ")}. Multi-trigger workflows are post-MVP and are rejected rather than compiled ambiguously.`,
    details: { count: triggers.length, trigger_ids: triggers.map((n) => n.id) },
  });
}

/** Rule 4. The trigger has no inbound edges. */
function checkTriggerInbound(model: GraphModel, errors: ValidationError[]): void {
  for (const trigger of triggerNodes(model)) {
    for (const entry of inboundOf(model, trigger.id)) {
      errors.push({
        code: ErrorCode.TRIGGER_HAS_INBOUND_EDGE,
        path: pointer("edges", entry.index),
        message: `Edge "${entry.edge.id}" runs into trigger "${trigger.id}". A trigger is an entry point and takes no inbound edges.`,
        details: { edge_id: entry.edge.id, trigger_id: trigger.id },
      });
    }
  }
}

/**
 * Rule 5. Every non-trigger node is reachable from the trigger.
 *
 * Skipped when rule 3 has already failed. Without a single entry point every
 * node is trivially unreachable, and burying one real error under a hundred
 * derived ones is how a repair prompt stops being useful.
 */
function checkReachability(model: GraphModel, errors: ValidationError[]): void {
  const triggers = triggerNodes(model);
  const trigger = triggers.length === 1 ? triggers[0] : undefined;
  if (trigger === undefined) return;

  const reachable = reachableFrom(model, trigger.id);
  model.doc.nodes.forEach((node, index) => {
    if (node.id === trigger.id || reachable.has(node.id)) return;
    errors.push({
      code: ErrorCode.NODE_UNREACHABLE,
      path: pointer("nodes", index),
      message: `Node "${node.id}" is not reachable from trigger "${trigger.id}", so it would never run.`,
      details: { node_id: node.id, trigger_id: trigger.id },
    });
  });
}

/**
 * Rule 6. The graph is acyclic except for loop back-edges.
 *
 * Depth-first search with the loop back-edges removed. A cycle is reported
 * once, at the edge that closes it, and is not traversed: following it would
 * either loop forever or report the same cycle once per member node.
 */
function checkAcyclic(model: GraphModel, errors: ValidationError[]): void {
  // Absent means unvisited. "open" means on the current search path, which is
  // exactly the condition that makes an edge into it a cycle.
  const color = new Map<string, "open" | "closed">();
  const reported = new Set<string>();

  const adjacency = (id: string) =>
    outboundOf(model, id).filter((entry) => !model.backEdges.has(entry.index));

  for (const root of model.doc.nodes) {
    if (color.has(root.id)) continue;

    const path: string[] = [root.id];
    const stack = [{ id: root.id, edges: adjacency(root.id), next: 0 }];
    color.set(root.id, "open");

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.next >= frame.edges.length) {
        color.set(frame.id, "closed");
        path.pop();
        stack.pop();
        continue;
      }

      const entry = frame.edges[frame.next++]!;
      const next = entry.edge.to;
      const state = color.get(next);

      if (state === "open") {
        const cycle = [...path.slice(path.indexOf(next)), next];
        const key = canonicalCycle(cycle);
        if (!reported.has(key)) {
          reported.add(key);
          errors.push({
            code: ErrorCode.GRAPH_CYCLE,
            path: pointer("edges", entry.index),
            message: `Edge "${entry.edge.id}" closes a cycle: ${cycle.join(" -> ")}. Only a loop node's back-edge may form a cycle.`,
            details: { edge_id: entry.edge.id, cycle },
          });
        }
        continue;
      }

      if (state === "closed") continue;

      color.set(next, "open");
      path.push(next);
      stack.push({ id: next, edges: adjacency(next), next: 0 });
    }
  }
}

/** Rotation-independent key, so one cycle is reported once however it is entered. */
function canonicalCycle(cycle: string[]): string {
  const members = cycle.slice(0, -1);
  let start = 0;
  members.forEach((id, index) => {
    if (id < members[start]!) start = index;
  });
  return [...members.slice(start), ...members.slice(0, start)].join(">");
}

// ---------------------------------------------------------------------------
// Semantic: rules 9 to 12
// ---------------------------------------------------------------------------

/** Rule 9. Every `nodes[].credential` names an existing credential. */
function checkCredentialRefs(model: GraphModel, errors: ValidationError[]): void {
  model.doc.nodes.forEach((node, index) => {
    if (node.credential === undefined) return;
    if (model.credentialsById.has(node.credential)) return;
    errors.push({
      code: ErrorCode.CREDENTIAL_REF_MISSING,
      path: pointer("nodes", index, "credential"),
      message: `Node "${node.id}" references credential "${node.credential}", which is not declared in credentials.`,
      details: { node_id: node.id, credential_id: node.credential },
    });
  });
}

/**
 * Rule 10. A credential's `capability_scope` matches the integration segment of
 * every capability that references it.
 *
 * Reported at the referencing node rather than at the credential: the node is
 * where the mismatch is introduced and where it has to be fixed, and one
 * credential can be wrong from several nodes at once.
 */
function checkCapabilityScopes(model: GraphModel, errors: ValidationError[]): void {
  model.doc.nodes.forEach((node, index) => {
    if (node.credential === undefined) return;
    const credential = model.credentialsById.get(node.credential);
    if (credential === undefined) return; // Rule 9 owns this.

    const integration = integrationOf(node.capability);
    if (credential.capability_scope === integration) return;

    errors.push({
      code: ErrorCode.CAPABILITY_SCOPE_MISMATCH,
      path: pointer("nodes", index, "credential"),
      message: `Node "${node.id}" uses capability "${node.capability}" with credential "${credential.id}", whose capability_scope is "${credential.capability_scope}". The scope must be the capability's integration segment, "${integration}".`,
      details: {
        node_id: node.id,
        credential_id: credential.id,
        capability: node.capability,
        expected_scope: integration,
        actual_scope: credential.capability_scope,
      },
    });
  });
}

/**
 * Rules 11 and 12, plus the expression parse itself.
 *
 * One pass because all three need the same parse, and parsing every expression
 * three times to keep the rule functions symmetrical would be a poor trade.
 *
 * An unsupported grammar produces one terminal error and stops the pass. It is
 * not a per-string failure: the grammar is a property of the document, and
 * repeating "this build cannot read grammar 2" once per parameter would bury
 * every other finding.
 */
function checkExpressions(model: GraphModel, errors: ValidationError[]): void {
  const grammar = model.doc.expression_grammar;
  const supported = checkGrammar(grammar, pointer("expression_grammar"));
  if (!supported.ok) {
    errors.push(...supported.errors);
    return;
  }

  const predecessorCache = new Map<string, Set<string>>();
  const predecessors = (nodeId: string): Set<string> => {
    const cached = predecessorCache.get(nodeId);
    if (cached !== undefined) return cached;
    const computed = predecessorsOf(model, nodeId);
    predecessorCache.set(nodeId, computed);
    return computed;
  };

  for (const site of expressionSites(model)) {
    const parsed = parseTemplate(site.value, grammar, { path: site.path });
    if (!parsed.ok) {
      errors.push(...parsed.errors);
      continue;
    }

    for (const part of parsed.template.parts) {
      if (part.type !== "expression") continue;
      checkReference(model, site, part.reference, predecessors, errors);
    }
  }
}

/**
 * A string that may carry expressions, and the node whose vantage point its
 * references are judged from.
 */
interface ExpressionSite {
  path: string;
  value: string;
  /** The node whose predecessors bound what may be referenced. */
  scopeNodeId: string | undefined;
  /**
   * Whether the scope node itself is referenceable.
   *
   * False inside a node's own parameters: a node cannot read its own output.
   * True for an edge condition, which is evaluated on the source node's result
   * and so may read it.
   */
  scopeNodeReadable: boolean;
  /** Human-readable location for the message. */
  where: string;
}

function checkReference(
  model: GraphModel,
  site: ExpressionSite,
  reference: Reference,
  predecessors: (nodeId: string) => Set<string>,
  errors: ValidationError[],
): void {
  // Rule 12.
  if (reference.type === "var_ref") {
    if (model.variableIds.has(reference.variable_id)) return;
    errors.push({
      code: ErrorCode.UNKNOWN_VARIABLE_REF,
      path: site.path,
      message: `${site.where} references variable "${reference.variable_id}", which is not declared in variables.`,
      details: { variable_id: reference.variable_id },
    });
    return;
  }

  // Rule 11.
  if (reference.type !== "node_ref") return;
  const target = reference.node_id;
  const scope = site.scopeNodeId;
  if (scope === undefined) return;

  if (!model.nodesById.has(target)) {
    errors.push({
      code: ErrorCode.EXPRESSION_REF_NOT_PREDECESSOR,
      path: site.path,
      message: `${site.where} references node "${target}", which does not exist.`,
      details: { node_id: target, from_node_id: scope, reason: "missing" },
    });
    return;
  }

  if (site.scopeNodeReadable && target === scope) return;
  if (predecessors(scope).has(target)) return;

  errors.push({
    code: ErrorCode.EXPRESSION_REF_NOT_PREDECESSOR,
    path: site.path,
    message: `${site.where} references node "${target}", which is not a transitive predecessor of "${scope}". A reference to a later step, or to a sibling branch that may not have run, is an error rather than a runtime surprise.`,
    details: {
      node_id: target,
      from_node_id: scope,
      reason: target === scope ? "self" : "not_a_predecessor",
      depth: referenceDepth(reference),
    },
  });
}

/** Every expression-bearing string, in document order. */
function expressionSites(model: GraphModel): ExpressionSite[] {
  const sites: ExpressionSite[] = [];

  model.doc.nodes.forEach((node, index) => {
    for (const found of parameterStrings(node, index)) {
      sites.push({
        path: found.path,
        value: found.value,
        scopeNodeId: node.id,
        scopeNodeReadable: false,
        where: `Node "${node.id}" parameter "${found.parameter}"`,
      });
    }
  });

  model.doc.edges.forEach((edge, index) => {
    if (edge.condition === undefined) return;
    const operands = [
      { side: "left" as const, value: edge.condition.left },
      { side: "right" as const, value: edge.condition.right },
    ];
    for (const operand of operands) {
      if (typeof operand.value !== "string") continue;
      sites.push({
        path: pointer("edges", index, "condition", operand.side),
        value: operand.value,
        // A condition runs on the source node's output, so that node is
        // readable here even though it is not its own predecessor.
        scopeNodeId: model.nodesById.has(edge.from) ? edge.from : undefined,
        scopeNodeReadable: true,
        where: `Edge "${edge.id}" condition ${operand.side}`,
      });
    }
  });

  return sites;
}

interface FoundString {
  path: string;
  value: string;
  /** The top-level parameter name, for messages. */
  parameter: string;
  /** Every key on the path, for the secret scanner's field-name heuristic. */
  fieldNames: string[];
}

/** Every string inside a node's parameters, at any depth, in key order. */
function parameterStrings(node: Node, nodeIndex: number): FoundString[] {
  const found: FoundString[] = [];

  const walk = (
    value: ParameterValue,
    path: string,
    parameter: string,
    fieldNames: string[],
  ): void => {
    if (typeof value === "string") {
      found.push({ path, value, parameter, fieldNames });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}/${index}`, parameter, fieldNames));
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const key of Object.keys(value)) {
        walk(value[key]!, path + pointer(key), parameter, [...fieldNames, key]);
      }
    }
  };

  for (const key of Object.keys(node.parameters)) {
    const base = pointer("nodes", nodeIndex, "parameters", key);
    walk(node.parameters[key]!, base, key, [key]);
  }

  return found;
}

// ---------------------------------------------------------------------------
// Safety: rules 14 to 18
// ---------------------------------------------------------------------------

/**
 * Rule 14. No parameter value matches a known secret pattern.
 *
 * Variable defaults are scanned too, which the rule's own wording does not say
 * but SECURITY.md and the Variables section both require. It closes a real
 * hole: rule 15 only blocks a default on a variable *marked* sensitive, so an
 * unmarked variable holding a live key as its default would otherwise pass
 * every check in the pipeline. The code is `secret_in_parameter` in both cases
 * because that is the vocabulary's one secret code, and the path says which
 * kind of field it was.
 */
function checkSecrets(model: GraphModel, errors: ValidationError[]): void {
  model.doc.nodes.forEach((node, index) => {
    for (const found of parameterStrings(node, index)) {
      const match = findSecret(found.value, { fieldNames: found.fieldNames });
      if (match === undefined) continue;
      errors.push({
        code: ErrorCode.SECRET_IN_PARAMETER,
        path: found.path,
        message: `Node "${node.id}" parameter "${found.parameter}" looks like ${match.describes} (${match.preview}). Move it into a variable marked sensitive; a parameter value is stored, exported, and publishable.`,
        details: { node_id: node.id, pattern: match.pattern, preview: match.preview },
      });
    }
  });

  (model.doc.variables ?? []).forEach((variable, index) => {
    if (variable.default === undefined) return;
    const match = findSecret(variable.default, {
      fieldNames: [variable.id, variable.label],
    });
    if (match === undefined) return;
    errors.push({
      code: ErrorCode.SECRET_IN_PARAMETER,
      path: pointer("variables", index, "default"),
      message: `Variable "${variable.id}" has a default that looks like ${match.describes} (${match.preview}). A secret must never be committed into a stored blueprint.`,
      details: { variable_id: variable.id, pattern: match.pattern, preview: match.preview },
    });
  });
}

/**
 * Rule 15. No variable with `sensitive: true` carries a `default`.
 *
 * Any present default fails, including an empty string. The field table says
 * "forbidden when sensitive is true" without qualification, and a rule with no
 * edge case is a rule nobody has to reason about at three in the morning.
 */
function checkSensitiveDefaults(model: GraphModel, errors: ValidationError[]): void {
  (model.doc.variables ?? []).forEach((variable, index) => {
    if (!variable.sensitive || variable.default === undefined) return;
    errors.push({
      code: ErrorCode.SENSITIVE_VARIABLE_HAS_DEFAULT,
      path: pointer("variables", index, "default"),
      message: `Variable "${variable.id}" is marked sensitive and carries a default. A sensitive variable holds a secret, and there is no legitimate case for committing one into a stored blueprint.`,
      details: { variable_id: variable.id },
    });
  });
}

/**
 * Rule 16. Every `loop` node has a finite `max_iterations`.
 *
 * "Finite" is read as a positive integer literal. An expression is not a static
 * bound, and a bound of zero or a fraction is not an iteration count. The
 * guardrail exists to stop a generated workflow burning a client's task quota
 * on a metered platform, and a bound that cannot be checked at compile time
 * does not provide it.
 */
function checkLoopBounds(model: GraphModel, errors: ValidationError[]): void {
  model.doc.nodes.forEach((node, index) => {
    if (node.kind !== "loop") return;

    const value = node.parameters["max_iterations"];
    if (typeof value === "number" && Number.isInteger(value) && value >= 1) return;

    errors.push({
      code: ErrorCode.LOOP_UNBOUNDED,
      path: pointer("nodes", index, "parameters", "max_iterations"),
      message:
        value === undefined
          ? `Loop node "${node.id}" has no max_iterations. An unbounded loop can burn a task quota on a metered platform, so the bound is required.`
          : `Loop node "${node.id}" has a max_iterations of ${JSON.stringify(value)}, which is not a finite iteration count. It must be a positive whole number known at compile time.`,
      details: { node_id: node.id, max_iterations: value ?? null },
    });
  });
}

/** Rule 17. Every node with `on_error: "route"` has an outbound `"error"` edge. */
function checkErrorRoutes(model: GraphModel, errors: ValidationError[]): void {
  model.doc.nodes.forEach((node, index) => {
    if (node.error_policy?.on_error !== "route") return;
    if (outboundOf(model, node.id).some((entry) => entry.port === ERROR_PORT)) return;

    errors.push({
      code: ErrorCode.ERROR_ROUTE_MISSING_EDGE,
      path: pointer("nodes", index, "error_policy", "on_error"),
      message: `Node "${node.id}" has on_error "route" but no outbound edge with port "error". A declared error route with nowhere to go is worse than no error handling, because it reads as safe. Add an error_handler node and an edge to it, or change on_error.`,
      details: { node_id: node.id },
    });
  });
}

/**
 * Rule 18. Every `branch` node has at least two outbound edges.
 *
 * Error-port edges do not count. The ports table lists `"error"` separately
 * from a branch's own outputs, so a branch with one case plus an error route
 * has one conditional output and does not branch.
 */
function checkBranchOutbound(model: GraphModel, errors: ValidationError[]): void {
  model.doc.nodes.forEach((node, index) => {
    if (node.kind !== "branch") return;

    const cases = outboundOf(model, node.id).filter((entry) => entry.port !== ERROR_PORT);
    if (cases.length >= 2) return;

    errors.push({
      code: ErrorCode.BRANCH_INSUFFICIENT_EDGES,
      path: pointer("nodes", index),
      message: `Branch node "${node.id}" has ${cases.length} conditional outbound edge${cases.length === 1 ? "" : "s"} and needs at least two. A branch with one output is not a branch. Edges on the "error" port do not count.`,
      details: { node_id: node.id, outbound_count: cases.length },
    });
  });
}

// ---------------------------------------------------------------------------

function triggerNodes(model: GraphModel): Node[] {
  return model.doc.nodes.filter((node) => node.kind === "trigger");
}
