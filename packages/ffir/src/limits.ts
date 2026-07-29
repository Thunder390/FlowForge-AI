/**
 * FFIR document limits.
 *
 * The validator, compiler, and renderers are pure functions with no internal
 * bounds, so an unbounded document is a denial-of-service vector the moment
 * untrusted FFIR can reach them. That happens on the day the marketplace opens,
 * and retrofitting limits after documents exist that exceed them is a migration
 * rather than a config change.
 *
 * These are enforced on every document regardless of origin, before any other
 * processing. Exceeding one is terminal, not a repair trigger.
 *
 * Values are from the limits table in docs/WORKFLOW_SCHEMA.md.
 */
export const DOCUMENT_LIMITS = {
  /** Above this a workflow is unmaintainable by a human anyway. */
  max_nodes: 150,
  /** Bounds branch fan-out. */
  max_edges: 300,
  /** Single reference plus surrounding literal text. */
  max_expression_length: 500,
  /** Bounds parse cost. */
  max_expression_path_depth: 10,
  max_expressions_per_parameter: 20,
  /** Bytes, per node. */
  max_parameter_payload_bytes: 64 * 1024,
  /** Bytes, whole document. */
  max_document_bytes: 1024 * 1024,
  max_variables: 50,
  max_credentials: 25,
} as const;

export type DocumentLimits = typeof DOCUMENT_LIMITS;
export type LimitName = keyof DocumentLimits;
