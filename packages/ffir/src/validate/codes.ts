/**
 * The shared error-code vocabulary.
 *
 * Every validation rule maps to exactly one machine-readable code so the repair
 * prompt can tell the model precisely what to fix, and so a support
 * conversation does not become archaeology. Codes for stages this package does
 * not yet implement are declared here anyway: this file is the vocabulary, and
 * three independent error dictionaries is the failure mode it exists to
 * prevent.
 *
 * Rule numbers refer to the validation rules in docs/WORKFLOW_SCHEMA.md.
 */
export const ErrorCode = {
  // Stage 0: document limits and gross shape.
  /** Input is not a JSON object at all. */
  DOCUMENT_MALFORMED: "document_malformed",
  /** Rule 19. Terminal, never repaired. */
  DOCUMENT_LIMIT_EXCEEDED: "document_limit_exceeded",

  // Stage 1: schema conformance.
  SCHEMA_VIOLATION: "schema_violation",
  /** Document declares an FFIR version this build does not implement. */
  FFIR_VERSION_UNSUPPORTED: "ffir_version_unsupported",

  // Stage 4 structural: rules 1 to 6.
  EDGE_ENDPOINT_MISSING: "edge_endpoint_missing",
  DUPLICATE_ID: "duplicate_id",
  TRIGGER_COUNT_INVALID: "trigger_count_invalid",
  TRIGGER_HAS_INBOUND_EDGE: "trigger_has_inbound_edge",
  NODE_UNREACHABLE: "node_unreachable",
  GRAPH_CYCLE: "graph_cycle",

  // Stages 2 and 3, registry-dependent: rules 7, 8, 13.
  UNKNOWN_CAPABILITY: "unknown_capability",
  /**
   * A `credentials[].capability_scope` naming an integration the registry does
   * not contain. Not a numbered rule: rule 10 checks a scope against the
   * capabilities that reference it, which says nothing about a credential no
   * node uses, and the merge step joins every scope against the registry's auth
   * definitions to build the setup guide.
   */
  UNKNOWN_CAPABILITY_SCOPE: "unknown_capability_scope",
  INVALID_PARAMETER_VALUE: "invalid_parameter_value",
  /**
   * Rule 13. The independent parameter-name check. It exists because the AI
   * layer's strongest guarantee, a synthesized schema with
   * `additionalProperties: false`, is a property of one model provider rather
   * than a universal one.
   */
  UNKNOWN_PARAMETER_NAME: "unknown_parameter_name",

  // Stage 4 semantic: rules 9 to 12.
  CREDENTIAL_REF_MISSING: "credential_ref_missing",
  /** Rule 10. Named for `capability_scope`, the field it checks. */
  CAPABILITY_SCOPE_MISMATCH: "capability_scope_mismatch",
  EXPRESSION_REF_NOT_PREDECESSOR: "expression_ref_not_predecessor",
  UNKNOWN_VARIABLE_REF: "unknown_variable_ref",

  // Stage 4 safety: rules 14 to 18.
  SECRET_IN_PARAMETER: "secret_in_parameter",
  SENSITIVE_VARIABLE_HAS_DEFAULT: "sensitive_variable_has_default",
  LOOP_UNBOUNDED: "loop_unbounded",
  ERROR_ROUTE_MISSING_EDGE: "error_route_missing_edge",
  BRANCH_INSUFFICIENT_EDGES: "branch_insufficient_edges",

  // Expression grammar.
  EXPRESSION_GRAMMAR_UNSUPPORTED: "expression_grammar_unsupported",
  EXPRESSION_PARSE_ERROR: "expression_parse_error",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * How the pipeline should react to a failure.
 *
 * `repairable_prompt_signal` failures are repairable like any other, but are
 * logged separately because they indicate the model ignored an explicit system
 * prompt instruction, which is a prompt-quality signal worth tracking.
 */
export type ErrorClass = "terminal" | "repairable" | "repairable_prompt_signal";

export const ERROR_CLASS: Record<ErrorCode, ErrorClass> = {
  [ErrorCode.DOCUMENT_MALFORMED]: "terminal",
  [ErrorCode.DOCUMENT_LIMIT_EXCEEDED]: "terminal",
  [ErrorCode.FFIR_VERSION_UNSUPPORTED]: "terminal",
  [ErrorCode.EXPRESSION_GRAMMAR_UNSUPPORTED]: "terminal",

  [ErrorCode.SCHEMA_VIOLATION]: "repairable",
  [ErrorCode.EDGE_ENDPOINT_MISSING]: "repairable",
  [ErrorCode.DUPLICATE_ID]: "repairable",
  [ErrorCode.TRIGGER_COUNT_INVALID]: "repairable",
  [ErrorCode.TRIGGER_HAS_INBOUND_EDGE]: "repairable",
  [ErrorCode.NODE_UNREACHABLE]: "repairable",
  [ErrorCode.GRAPH_CYCLE]: "repairable",
  [ErrorCode.UNKNOWN_CAPABILITY]: "repairable",
  [ErrorCode.UNKNOWN_CAPABILITY_SCOPE]: "repairable",
  [ErrorCode.INVALID_PARAMETER_VALUE]: "repairable",
  [ErrorCode.UNKNOWN_PARAMETER_NAME]: "repairable",
  [ErrorCode.CREDENTIAL_REF_MISSING]: "repairable",
  [ErrorCode.CAPABILITY_SCOPE_MISMATCH]: "repairable",
  [ErrorCode.EXPRESSION_REF_NOT_PREDECESSOR]: "repairable",
  [ErrorCode.UNKNOWN_VARIABLE_REF]: "repairable",
  [ErrorCode.EXPRESSION_PARSE_ERROR]: "repairable",

  [ErrorCode.SECRET_IN_PARAMETER]: "repairable_prompt_signal",
  [ErrorCode.SENSITIVE_VARIABLE_HAS_DEFAULT]: "repairable_prompt_signal",
  [ErrorCode.LOOP_UNBOUNDED]: "repairable_prompt_signal",
  [ErrorCode.ERROR_ROUTE_MISSING_EDGE]: "repairable_prompt_signal",
  [ErrorCode.BRANCH_INSUFFICIENT_EDGES]: "repairable_prompt_signal",
};

/** Maps a WORKFLOW_SCHEMA rule number to the code it produces. */
export const RULE_CODES: Record<number, ErrorCode> = {
  1: ErrorCode.EDGE_ENDPOINT_MISSING,
  2: ErrorCode.DUPLICATE_ID,
  3: ErrorCode.TRIGGER_COUNT_INVALID,
  4: ErrorCode.TRIGGER_HAS_INBOUND_EDGE,
  5: ErrorCode.NODE_UNREACHABLE,
  6: ErrorCode.GRAPH_CYCLE,
  7: ErrorCode.UNKNOWN_CAPABILITY,
  8: ErrorCode.INVALID_PARAMETER_VALUE,
  9: ErrorCode.CREDENTIAL_REF_MISSING,
  10: ErrorCode.CAPABILITY_SCOPE_MISMATCH,
  11: ErrorCode.EXPRESSION_REF_NOT_PREDECESSOR,
  12: ErrorCode.UNKNOWN_VARIABLE_REF,
  13: ErrorCode.UNKNOWN_PARAMETER_NAME,
  14: ErrorCode.SECRET_IN_PARAMETER,
  15: ErrorCode.SENSITIVE_VARIABLE_HAS_DEFAULT,
  16: ErrorCode.LOOP_UNBOUNDED,
  17: ErrorCode.ERROR_ROUTE_MISSING_EDGE,
  18: ErrorCode.BRANCH_INSUFFICIENT_EDGES,
  19: ErrorCode.DOCUMENT_LIMIT_EXCEEDED,
};
