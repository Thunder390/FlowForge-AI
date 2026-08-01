/**
 * Canvas positions, by layered graph layout.
 *
 * 1. Each node's layer is its longest path from the trigger.
 * 2. Nodes within a layer are ordered to reduce edge crossings.
 * 3. `x = layer * 220`, `y = index * 160`, both multiples of the design
 *    system's dot grid.
 * 4. Error handlers are pushed down so they read as a separate track.
 *
 * Longest path rather than shortest, because a node should sit to the right of
 * everything that can reach it. With shortest paths a step that is reachable in
 * one hop and also at the end of a five-step branch would be drawn at layer 1,
 * on top of the branch it is supposed to follow.
 *
 * The same positions go into the exported file and into `metadata.layout`, so
 * the React Flow canvas and n8n agree. A user who sees one shape in FlowForge
 * and a different one after importing loses confidence in both.
 */

import type { NormalizedGraph, NormalizedNode } from "../../normalize.js";

/** Horizontal distance between layers. A multiple of the dot grid. */
export const LAYER_WIDTH = 220;

/** Vertical distance between nodes in a layer. */
export const ROW_HEIGHT = 160;

/**
 * Extra drop applied to error handlers.
 *
 * They already sort to the bottom of their layer, so one more row of gap is
 * what turns "last in the column" into "visibly a different track".
 */
export const ERROR_TRACK_OFFSET = 160;

export interface Position {
  x: number;
  y: number;
}

/**
 * Positions for every node, keyed by FFIR node id.
 *
 * Deterministic throughout: layers come from the topological order stage 3
 * fixed, and every ordering decision inside a layer breaks ties on node id.
 */
export function layoutGraph(graph: NormalizedGraph): Record<string, Position> {
  const layers = assignLayers(graph);
  const byLayer = groupByLayer(graph, layers);

  const positions: Record<string, Position> = {};

  for (const [layer, nodes] of [...byLayer.entries()].sort(([a], [b]) => a - b)) {
    const ordered = orderWithinLayer(nodes, graph, positions);

    ordered.forEach((node, index) => {
      positions[node.id] = {
        x: layer * LAYER_WIDTH,
        y: index * ROW_HEIGHT + (isErrorHandler(node) ? ERROR_TRACK_OFFSET : 0),
      };
    });
  }

  return positions;
}

/**
 * Longest path from the trigger, in topological order.
 *
 * Back-edges are skipped: a loop's closing edge would otherwise make the
 * longest path unbounded. Stage 3 already identified them, so this reads the
 * flag rather than rediscovering which edges close a loop.
 */
export function assignLayers(graph: NormalizedGraph): Map<string, number> {
  const layers = new Map<string, number>();
  for (const node of graph.nodes) layers.set(node.id, 0);

  // graph.nodes is topologically sorted, so every predecessor of a node has its
  // final layer by the time the node is reached.
  for (const node of graph.nodes) {
    for (const edge of graph.outbound.get(node.id) ?? []) {
      if (edge.backEdge) continue;
      const candidate = (layers.get(node.id) ?? 0) + 1;
      if (candidate > (layers.get(edge.to) ?? 0)) layers.set(edge.to, candidate);
    }
  }

  return layers;
}

function groupByLayer(
  graph: NormalizedGraph,
  layers: Map<string, number>,
): Map<number, NormalizedNode[]> {
  const grouped = new Map<number, NormalizedNode[]>();

  for (const node of graph.nodes) {
    const layer = layers.get(node.id) ?? 0;
    const bucket = grouped.get(layer);
    if (bucket === undefined) grouped.set(layer, [node]);
    else bucket.push(node);
  }

  return grouped;
}

/**
 * Orders one layer: main track first, error handlers last.
 *
 * Within each track, nodes sort by the average vertical position of the
 * predecessors already placed, which is the barycentre heuristic and is what
 * keeps edges from crossing when a branch fans out. A node with no placed
 * predecessor keeps its topological position, and every tie breaks on node id
 * so the result cannot depend on iteration order.
 *
 * One pass rather than iterating to a fixed point. Layers are placed
 * left to right and each one is ordered against predecessors that are already
 * final, which is enough for the shapes a workflow actually takes, and a
 * multi-pass sweep would trade determinism that is easy to explain for a
 * marginally tidier diagram.
 */
function orderWithinLayer(
  nodes: readonly NormalizedNode[],
  graph: NormalizedGraph,
  placed: Record<string, Position>,
): NormalizedNode[] {
  const barycentres = new Map<string, number | undefined>();

  for (const node of nodes) {
    const sources = (graph.inbound.get(node.id) ?? [])
      .filter((edge) => !edge.backEdge)
      .map((edge) => placed[edge.from]?.y)
      .filter((y): y is number => y !== undefined);

    barycentres.set(
      node.id,
      sources.length === 0
        ? undefined
        : sources.reduce((total, y) => total + y, 0) / sources.length,
    );
  }

  return [...nodes].sort((a, b) => {
    const trackDifference = Number(isErrorHandler(a)) - Number(isErrorHandler(b));
    if (trackDifference !== 0) return trackDifference;

    const left = barycentres.get(a.id);
    const right = barycentres.get(b.id);
    if (left !== undefined && right !== undefined && left !== right) return left - right;
    if (left === undefined && right !== undefined) return 1;
    if (left !== undefined && right === undefined) return -1;

    if (a.order !== b.order) return a.order - b.order;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function isErrorHandler(node: NormalizedNode): boolean {
  return node.node.kind === "error_handler";
}
