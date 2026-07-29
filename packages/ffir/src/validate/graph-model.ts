/**
 * The read-only graph view every stage 4 rule shares.
 *
 * Built once per document so that fifteen rules do not each rebuild an
 * adjacency map, and so that they all agree on what the graph *is*. Two rules
 * disagreeing about whether a broken edge counts is how a validator starts
 * contradicting itself.
 *
 * Three construction decisions the rules depend on:
 *
 * 1. **Only well-formed edges enter the graph.** An edge naming a node that
 *    does not exist is reported by rule 1 and then excluded, so reachability
 *    and cycle detection work on a graph that is actually a graph.
 * 2. **Duplicate ids resolve to the first occurrence.** Rule 2 reports them.
 *    Every other rule needs a single answer for "what is node `n_x`", and
 *    first-wins is the only choice that does not depend on iteration order.
 * 3. **Everything is built by iterating the document's own arrays in order**,
 *    so the errors a document produces are the same on every run.
 */

import type { CredentialRef, Edge, FFIRDocument, Node } from "../types.js";

/** The port an edge leaves from. Absent means `"main"`. */
export const DEFAULT_PORT = "main";

/** The port reserved for `on_error: "route"` traffic, on any node kind. */
export const ERROR_PORT = "error";

/** The loop body port. Edges from it form the iterated section. */
export const EACH_PORT = "each";

export interface EdgeEntry {
  edge: Edge;
  /** Index into `doc.edges`, so an error can point at the original. */
  index: number;
  /** `edge.port` with the default applied. */
  port: string;
}

export interface GraphModel {
  doc: FFIRDocument;
  nodesById: ReadonlyMap<string, Node>;
  credentialsById: ReadonlyMap<string, CredentialRef>;
  variableIds: ReadonlySet<string>;
  /** Edges whose endpoints both resolve. The graph rules use only these. */
  edges: readonly EdgeEntry[];
  outbound: ReadonlyMap<string, EdgeEntry[]>;
  inbound: ReadonlyMap<string, EdgeEntry[]>;
  /**
   * Indices into `doc.edges` of edges that close a loop.
   *
   * A back-edge is an edge into a `loop` node, on the `main` port, from a node
   * inside that loop's body. Rule 6 removes exactly these before looking for
   * cycles, which is what "acyclic except for loop back-edges" means. Defining
   * it by body membership rather than by "any main edge into a loop node"
   * matters: the latter would also remove the loop's ordinary inbound edge and
   * would mask a genuine cycle that happens to pass through a loop node.
   */
  backEdges: ReadonlySet<number>;
}

export function buildGraphModel(doc: FFIRDocument): GraphModel {
  const nodesById = new Map<string, Node>();
  for (const node of doc.nodes) {
    if (!nodesById.has(node.id)) nodesById.set(node.id, node);
  }

  const credentialsById = new Map<string, CredentialRef>();
  for (const credential of doc.credentials) {
    if (!credentialsById.has(credential.id)) credentialsById.set(credential.id, credential);
  }

  const variableIds = new Set((doc.variables ?? []).map((variable) => variable.id));

  const edges: EdgeEntry[] = [];
  const outbound = new Map<string, EdgeEntry[]>();
  const inbound = new Map<string, EdgeEntry[]>();

  doc.edges.forEach((edge, index) => {
    if (!nodesById.has(edge.from) || !nodesById.has(edge.to)) return;
    const entry: EdgeEntry = { edge, index, port: portOf(edge) };
    edges.push(entry);
    push(outbound, edge.from, entry);
    push(inbound, edge.to, entry);
  });

  return {
    doc,
    nodesById,
    credentialsById,
    variableIds,
    edges,
    outbound,
    inbound,
    backEdges: findBackEdges(doc, nodesById, outbound, inbound),
  };
}

export function portOf(edge: Edge): string {
  return edge.port ?? DEFAULT_PORT;
}

/** The integration segment of a capability id: `slack` in `slack.message.send`. */
export function integrationOf(capability: string): string {
  return capability.split(".")[0] ?? capability;
}

export function outboundOf(model: GraphModel, nodeId: string): readonly EdgeEntry[] {
  return model.outbound.get(nodeId) ?? [];
}

export function inboundOf(model: GraphModel, nodeId: string): readonly EdgeEntry[] {
  return model.inbound.get(nodeId) ?? [];
}

/** Nodes reachable from `startId` following every port. */
export function reachableFrom(model: GraphModel, startId: string): Set<string> {
  return traverse(startId, (id) => outboundOf(model, id).map((entry) => entry.edge.to));
}

/**
 * Transitive predecessors of `nodeId`: every node from which execution can
 * arrive here.
 *
 * Loop back-edges are included rather than removed. Once a loop's `done` port
 * fires, its body has run, so a node after the loop may legitimately reference
 * one inside it.
 */
export function predecessorsOf(model: GraphModel, nodeId: string): Set<string> {
  return traverse(nodeId, (id) => inboundOf(model, id).map((entry) => entry.edge.from));
}

/** Breadth-first closure over `next`, excluding the start unless it recurs. */
function traverse(start: string, next: (id: string) => string[]): Set<string> {
  const seen = new Set<string>();
  const queue = next(start);

  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    queue.push(...next(id));
  }

  return seen;
}

/**
 * Nodes in a loop's body: everything reachable from its `each` port without
 * passing back through the loop node itself.
 */
export function loopBody(model: GraphModel, loopId: string): Set<string> {
  return loopBodyFrom(model.outbound, loopId);
}

function loopBodyFrom(
  outbound: ReadonlyMap<string, EdgeEntry[]>,
  loopId: string,
): Set<string> {
  const body = new Set<string>();
  const queue = (outbound.get(loopId) ?? [])
    .filter((entry) => entry.port === EACH_PORT)
    .map((entry) => entry.edge.to);

  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || id === loopId || body.has(id)) continue;
    body.add(id);
    for (const entry of outbound.get(id) ?? []) queue.push(entry.edge.to);
  }

  return body;
}

function findBackEdges(
  doc: FFIRDocument,
  nodesById: ReadonlyMap<string, Node>,
  outbound: ReadonlyMap<string, EdgeEntry[]>,
  inbound: ReadonlyMap<string, EdgeEntry[]>,
): Set<number> {
  const backEdges = new Set<number>();
  const seenLoops = new Set<string>();
  for (const node of doc.nodes) {
    if (node.kind !== "loop") continue;
    if (nodesById.get(node.id) !== node) continue;
    if (seenLoops.has(node.id)) continue;
    seenLoops.add(node.id);

    const body = loopBodyFrom(outbound, node.id);
    for (const entry of inbound.get(node.id) ?? []) {
      if (entry.port === DEFAULT_PORT && body.has(entry.edge.from)) {
        backEdges.add(entry.index);
      }
    }
  }

  return backEdges;
}

function push(map: Map<string, EdgeEntry[]>, key: string, entry: EdgeEntry): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [entry]);
  else existing.push(entry);
}
