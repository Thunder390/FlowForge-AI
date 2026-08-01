/**
 * FFIR plus `metadata.layout` to the nodes and edges a React Flow canvas draws.
 *
 * ## This renderer does not compute a layout
 *
 * It reads one. COMPILER_ARCHITECTURE gives this renderer's input as "FFIR +
 * `metadata.layout`", and the reason is worth stating because it looks like a
 * missing feature: the positions have to be the *same* positions the exported
 * n8n file uses. A user who arranges a workflow in FlowForge, exports it, and
 * finds a different shape in n8n stops trusting both views.
 *
 * There is exactly one producer of those positions, the n8n target's layered
 * layout, and `metadata.layout` is the channel it publishes them through. A
 * second layout algorithm living here would be a second answer to a question
 * that must have one, and it would drift the first time either changed.
 *
 * So a node with no recorded position is reported rather than invented. The
 * caller has not compiled yet, and the honest response is to say so.
 */

import {
  DEFAULT_PORT,
  ERROR_PORT,
  portOf,
  type Condition,
  type FFIRDocument,
  type NodeKind,
} from "@flowforge/ffir";

import { colorOf } from "./mermaid.js";
import { graphOf } from "./order.js";

export interface CanvasPosition {
  x: number;
  y: number;
}

/**
 * A React Flow node.
 *
 * `type` is the canvas component to render, keyed off the FFIR kind so the
 * design system can give a trigger a different card from a branch. Everything a
 * card shows lives under `data`, which is React Flow's convention.
 */
export interface CanvasNode {
  id: string;
  type: NodeKind;
  position: CanvasPosition;
  data: {
    label: string;
    kind: NodeKind;
    capability: string;
    /** The integration segment, for the icon. */
    integration: string;
    notes?: string;
    credential?: string;
    /** Warning messages recorded against this node, for the badge. */
    warnings: string[];
  };
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  /** The FFIR port, which the node component uses to pick an output handle. */
  sourceHandle: string;
  label?: string;
  /** Dashed for the error path, matching the mermaid diagram. */
  animated: boolean;
  style: { stroke: string };
  data: {
    port: string;
    condition?: Condition;
  };
}

export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /**
   * Node ids with no recorded position, in document order.
   *
   * Non-empty means the document has not been compiled, so the canvas should
   * say so rather than draw everything on top of itself at the origin.
   */
  missingPositions: string[];
}

export interface ReactFlowOptions {
  /**
   * Positions to use. Defaults to `metadata.layout`, which is where the
   * pipeline records what the compiler computed.
   */
  layout?: Record<string, CanvasPosition>;
}

export function toReactFlow(
  doc: FFIRDocument,
  options: ReactFlowOptions = {},
): CanvasData {
  const layout = options.layout ?? doc.metadata?.layout ?? {};
  const warnings = warningsByNode(doc);
  const missingPositions: string[] = [];

  const nodes: CanvasNode[] = doc.nodes.map((node) => {
    const position = layout[node.id];
    if (position === undefined) missingPositions.push(node.id);

    return {
      id: node.id,
      type: node.kind,
      position: position ?? { x: 0, y: 0 },
      data: {
        label: node.label,
        kind: node.kind,
        capability: node.capability,
        integration: integrationSegment(node.capability),
        ...(node.notes === undefined ? {} : { notes: node.notes }),
        ...(node.credential === undefined ? {} : { credential: node.credential }),
        warnings: warnings.get(node.id) ?? [],
      },
    };
  });

  // Only well-formed edges reach the canvas. An edge naming a node that does not
  // exist is validation rule 1's problem, and React Flow throws on one rather
  // than skipping it.
  const edges: CanvasEdge[] = graphOf(doc).edges.map((entry) => {
    const port = portOf(entry.edge);
    const label = edgeLabel(entry.edge.condition, port);

    return {
      id: entry.edge.id,
      source: entry.edge.from,
      target: entry.edge.to,
      sourceHandle: port,
      ...(label === undefined ? {} : { label }),
      animated: port === ERROR_PORT,
      style: { stroke: colorOf(port) },
      data: {
        port,
        ...(entry.edge.condition === undefined ? {} : { condition: entry.edge.condition }),
      },
    };
  });

  return { nodes, edges, missingPositions };
}

/** True when every node has a position, which is what the canvas needs to draw. */
export function hasLayout(doc: FFIRDocument, layout?: Record<string, CanvasPosition>): boolean {
  const positions = layout ?? doc.metadata?.layout ?? {};
  return doc.nodes.every((node) => positions[node.id] !== undefined);
}

function edgeLabel(condition: Condition | undefined, port: string): string | undefined {
  if (condition !== undefined) return port;
  return port === DEFAULT_PORT ? undefined : port;
}

function warningsByNode(doc: FFIRDocument): Map<string, string[]> {
  const grouped = new Map<string, string[]>();

  for (const warning of doc.metadata?.warnings ?? []) {
    if (warning.node_id === undefined) continue;
    const list = grouped.get(warning.node_id);
    if (list === undefined) grouped.set(warning.node_id, [warning.message]);
    else list.push(warning.message);
  }

  return grouped;
}

function integrationSegment(capability: string): string {
  const dot = capability.indexOf(".");
  return dot === -1 ? capability : capability.slice(0, dot);
}
