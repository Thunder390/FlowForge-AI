/**
 * n8n's own workflow model.
 *
 * This is the only file in the compiler allowed to describe what an n8n
 * workflow looks like, and everything above stage 4 is written so that it never
 * needs to. Stage 5 serializes these shapes and does nothing else; every
 * decision was already made by the time one of these objects exists.
 */

import type { PlatformIR } from "../../target.js";

export const N8N_TARGET_KEY = "n8n";

/** n8n's `onError`, which FFIR's `error_policy.on_error` maps onto. */
export const N8N_ON_ERROR = {
  stop: "stopWorkflow",
  continue: "continueRegularOutput",
  route: "continueErrorOutput",
} as const;

export type N8nOnError = (typeof N8N_ON_ERROR)[keyof typeof N8N_ON_ERROR];

/**
 * A connection target.
 *
 * `index` is the *input* index on the receiving node. It is 0 for everything
 * except a Merge node, whose inputs are numbered and whose inbound edges are
 * assigned to them in sorted order.
 */
export interface N8nConnection {
  node: string;
  type: "main";
  index: number;
}

/**
 * One source node's outgoing connections, keyed by output name.
 *
 * The nesting is `[outputIndex][connectionIndex]`: the outer array selects
 * which output of the source node, and the inner array holds every node that
 * output feeds. A branch's false path is `main[1]`; a loop's `each` port is
 * `main[1]` on a Split In Batches node, which is inverted relative to intuition
 * and is why the mapping is stated explicitly in the lowering table.
 */
export type N8nNodeConnections = Record<string, (N8nConnection[] | null)[]>;

export type N8nConnections = Record<string, N8nNodeConnections>;

/** A credential placeholder. Never a value: the export is inert until connected. */
export interface N8nCredentialRef {
  id: string;
  name: string;
}

export interface N8nNode {
  /** Deterministic UUIDv5 of the workflow id and the FFIR node id. */
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  credentials?: Record<string, N8nCredentialRef>;
  onError?: N8nOnError;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
}

export interface N8nWorkflow {
  name: string;
  nodes: N8nNode[];
  connections: N8nConnections;
  settings: { executionOrder: "v1" };
  pinData: Record<string, never>;
  meta: { instanceId: string };
}

export interface N8nIR extends PlatformIR {
  target: typeof N8N_TARGET_KEY;
  workflow: N8nWorkflow;
  /**
   * Node id to canvas position, the same numbers the nodes carry.
   *
   * Written out so a caller can put them in `metadata.layout` and have the
   * React Flow canvas agree with the exported file. A user who sees one shape
   * in FlowForge and a different one in n8n stops trusting the tool.
   */
  layout: Record<string, { x: number; y: number }>;
}

export function isN8nIR(ir: PlatformIR): ir is N8nIR {
  return ir.target === N8N_TARGET_KEY;
}
