import { describe, expect, it } from "vitest";

import { cloneOnboarding, onboardingExample } from "../__fixtures__/index.js";
import type {
  Edge,
  FFIRDocument,
  Node,
  Parameters,
  Variable,
} from "../types.js";
import { ErrorCode } from "./codes.js";
import { checkGraph, GRAPH_RULES, RULE_OWNERSHIP } from "./graph.js";
import { classOf } from "./result.js";

/** The codes a document produces, in order. Every rule test asserts on this. */
function codes(doc: FFIRDocument): ErrorCode[] {
  return checkGraph(doc).errors.map((error) => error.code);
}

function node(id: string, overrides: Partial<Node> = {}): Node {
  return {
    id,
    kind: "action",
    capability: "slack.message.send",
    label: `Node ${id}`,
    parameters: {},
    ...overrides,
  };
}

function edge(id: string, from: string, to: string, port?: string): Edge {
  return port === undefined ? { id, from, to } : { id, from, to, port };
}

function workflow(nodes: Node[], edges: Edge[], variables?: Variable[]): FFIRDocument {
  const base: FFIRDocument = {
    ffir_version: "1.0",
    expression_grammar: "1",
    id: "wf_test",
    name: "Test workflow",
    description: "A workflow built for one assertion.",
    nodes,
    edges,
    credentials: [],
  };
  return variables === undefined ? base : { ...base, variables };
}

function loopNode(id: string, parameters: Parameters): Node {
  return node(id, { kind: "loop", capability: "core.loop.for_each", parameters });
}

describe("the worked example", () => {
  it("passes every stage 4 rule", () => {
    expect(checkGraph(onboardingExample)).toEqual({ ok: true, errors: [] });
  });

  it("is not mutated by validation", () => {
    const before = JSON.stringify(onboardingExample);
    checkGraph(onboardingExample);
    expect(JSON.stringify(onboardingExample)).toBe(before);
  });

  it("produces identical output on repeated runs", () => {
    const doc = cloneOnboarding();
    doc.nodes[3]!.credential = "cred_nope";
    doc.edges.push(edge("e_cycle", "n_slack_welcome", "n_build_email"));
    expect(checkGraph(doc)).toEqual(checkGraph(doc));
  });
});

describe("rule ownership", () => {
  it("accounts for all eighteen rules", () => {
    expect(Object.keys(RULE_OWNERSHIP).map(Number)).toEqual(
      Array.from({ length: 18 }, (_, i) => i + 1),
    );
  });

  it("assigns exactly rules 7, 8, and 13 to the registry", () => {
    // They resolve capabilities and parameter schemas against the node
    // registry, and `ffir` must not depend on it. They are stages 2 and 3.
    const registryRules = Object.keys(RULE_OWNERSHIP)
      .map(Number)
      .filter((rule) => RULE_OWNERSHIP[rule] === "registry");
    expect(registryRules).toEqual([7, 8, 13]);
  });

  it("checks the other fifteen here", () => {
    expect(GRAPH_RULES).toEqual([1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 14, 15, 16, 17, 18]);
  });
});

// ---------------------------------------------------------------------------
// One document per rule, violating only that rule.
// ---------------------------------------------------------------------------

describe("rule 1: edge endpoints name existing nodes", () => {
  it("rejects an edge into a node that does not exist", () => {
    const doc = cloneOnboarding();
    doc.edges.push(edge("e_bad", "n_slack_welcome", "n_nope"));
    expect(codes(doc)).toEqual([ErrorCode.EDGE_ENDPOINT_MISSING]);
  });

  it("reports from and to separately", () => {
    const doc = cloneOnboarding();
    doc.edges.push(edge("e_bad", "n_gone", "n_also_gone"));
    const errors = checkGraph(doc).errors.filter(
      (e) => e.code === ErrorCode.EDGE_ENDPOINT_MISSING,
    );
    expect(errors.map((e) => e.path)).toEqual(["/edges/4/from", "/edges/4/to"]);
  });

  it("excludes the broken edge from the graph so later rules stay meaningful", () => {
    // A dangling edge must not make the whole graph unanalysable.
    const doc = cloneOnboarding();
    doc.edges.push(edge("e_bad", "n_nope", "n_slack_welcome"));
    expect(codes(doc)).toEqual([ErrorCode.EDGE_ENDPOINT_MISSING]);
  });
});

describe("rule 2: ids are unique within their collection", () => {
  it("rejects a duplicate edge id", () => {
    const doc = cloneOnboarding();
    doc.edges.push(edge("e_1", "n_slack_welcome", "n_alert_it"));
    expect(codes(doc)).toEqual([ErrorCode.DUPLICATE_ID]);
  });

  it("rejects a duplicate node id", () => {
    const doc = workflow(
      [node("n_trigger", { kind: "trigger" }), node("n_a"), node("n_a")],
      [edge("e_1", "n_trigger", "n_a")],
    );
    expect(codes(doc)).toEqual([ErrorCode.DUPLICATE_ID]);
  });

  it("rejects a duplicate credential id", () => {
    const doc = cloneOnboarding();
    doc.credentials.push({ ...doc.credentials[2]!, label: "A second Slack" });
    expect(codes(doc)).toEqual([ErrorCode.DUPLICATE_ID]);
  });

  it("names the first occurrence so the author knows which one to change", () => {
    const doc = cloneOnboarding();
    doc.edges.push(edge("e_1", "n_slack_welcome", "n_alert_it"));
    expect(checkGraph(doc).errors[0]?.details).toMatchObject({
      collection: "edges",
      id: "e_1",
      first_index: 0,
      duplicate_index: 4,
    });
  });

  it("allows a node and an edge to share an id, which are separate namespaces", () => {
    const doc = workflow(
      [node("x", { kind: "trigger" }), node("n_a")],
      [edge("x", "x", "n_a")],
    );
    expect(codes(doc)).toEqual([]);
  });
});

describe("rule 3: exactly one trigger", () => {
  it("rejects a workflow with no trigger", () => {
    const doc = cloneOnboarding();
    doc.nodes[0]!.kind = "action";
    expect(codes(doc)).toEqual([ErrorCode.TRIGGER_COUNT_INVALID]);
  });

  it("rejects a workflow with two triggers", () => {
    const doc = cloneOnboarding();
    doc.nodes.push(node("n_trigger_2", { kind: "trigger" }));
    expect(codes(doc)).toEqual([ErrorCode.TRIGGER_COUNT_INVALID]);
  });

  it("reports the count and the offending ids", () => {
    const doc = cloneOnboarding();
    doc.nodes.push(node("n_trigger_2", { kind: "trigger" }));
    expect(checkGraph(doc).errors[0]?.details).toEqual({
      count: 2,
      trigger_ids: ["n_trigger", "n_trigger_2"],
    });
  });
});

describe("rule 4: the trigger has no inbound edges", () => {
  it("rejects an edge into the trigger", () => {
    // Rule 4 cannot be violated in isolation. An edge into the entry point
    // comes either from a node the trigger reaches, which is a cycle, or from
    // one it does not, which is unreachable. The cycle is the smaller
    // companion, so it is the one asserted here.
    const doc = cloneOnboarding();
    doc.edges.push(edge("e_back", "n_slack_welcome", "n_trigger"));
    expect(codes(doc)).toEqual([
      ErrorCode.TRIGGER_HAS_INBOUND_EDGE,
      ErrorCode.GRAPH_CYCLE,
    ]);
  });

  it("points at the offending edge", () => {
    const doc = cloneOnboarding();
    doc.edges.push(edge("e_back", "n_slack_welcome", "n_trigger"));
    expect(checkGraph(doc).errors[0]).toMatchObject({
      code: ErrorCode.TRIGGER_HAS_INBOUND_EDGE,
      path: "/edges/4",
      details: { edge_id: "e_back", trigger_id: "n_trigger" },
    });
  });
});

describe("rule 5: every non-trigger node is reachable from the trigger", () => {
  it("rejects an orphan node", () => {
    const doc = cloneOnboarding();
    doc.nodes.push(node("n_orphan"));
    expect(codes(doc)).toEqual([ErrorCode.NODE_UNREACHABLE]);
  });

  it("rejects a node reachable only backwards", () => {
    const doc = cloneOnboarding();
    doc.nodes.push(node("n_upstream"));
    doc.edges.push(edge("e_up", "n_upstream", "n_slack_welcome"));
    expect(codes(doc)).toEqual([ErrorCode.NODE_UNREACHABLE]);
  });

  it("is skipped when the trigger count is already wrong", () => {
    // Without a single entry point every node is trivially unreachable, and
    // burying one real error under a hundred derived ones makes the repair
    // prompt useless.
    const doc = cloneOnboarding();
    doc.nodes[0]!.kind = "action";
    expect(codes(doc)).toEqual([ErrorCode.TRIGGER_COUNT_INVALID]);
  });
});

describe("rule 6: acyclic except for loop back-edges", () => {
  it("rejects a cycle between ordinary nodes", () => {
    const doc = cloneOnboarding();
    doc.edges.push(edge("e_cycle", "n_slack_welcome", "n_build_email"));
    expect(codes(doc)).toEqual([ErrorCode.GRAPH_CYCLE]);
  });

  it("reports the cycle once, naming the edge that closes it", () => {
    const doc = cloneOnboarding();
    doc.edges.push(edge("e_cycle", "n_slack_welcome", "n_build_email"));
    expect(checkGraph(doc).errors[0]).toMatchObject({
      path: "/edges/4",
      details: {
        edge_id: "e_cycle",
        cycle: ["n_build_email", "n_create_account", "n_slack_welcome", "n_build_email"],
      },
    });
  });

  it("rejects a self-loop", () => {
    const doc = workflow(
      [node("n_trigger", { kind: "trigger" }), node("n_a")],
      [edge("e_1", "n_trigger", "n_a"), edge("e_2", "n_a", "n_a")],
    );
    expect(codes(doc)).toEqual([ErrorCode.GRAPH_CYCLE]);
  });

  it("accepts a loop back-edge", () => {
    const doc = workflow(
      [
        node("n_trigger", { kind: "trigger" }),
        loopNode("n_loop", { items: "{{ n_trigger.rows }}", max_iterations: 100 }),
        node("n_body"),
        node("n_after"),
      ],
      [
        edge("e_1", "n_trigger", "n_loop"),
        edge("e_2", "n_loop", "n_body", "each"),
        edge("e_3", "n_body", "n_loop"),
        edge("e_4", "n_loop", "n_after", "done"),
      ],
    );
    expect(codes(doc)).toEqual([]);
  });

  it("rejects a cycle through a loop node that is not a body back-edge", () => {
    // The reason a back-edge is defined by body membership rather than by "any
    // main edge into a loop node": the looser rule would remove this edge too
    // and call an arbitrary cycle legal.
    const doc = workflow(
      [
        node("n_trigger", { kind: "trigger" }),
        loopNode("n_loop", { max_iterations: 5 }),
        node("n_x"),
      ],
      [
        edge("e_1", "n_trigger", "n_loop"),
        edge("e_2", "n_loop", "n_x", "done"),
        edge("e_3", "n_x", "n_loop"),
      ],
    );
    expect(codes(doc)).toEqual([ErrorCode.GRAPH_CYCLE]);
  });

  it("reports two independent cycles separately", () => {
    const doc = workflow(
      [
        node("n_trigger", { kind: "trigger" }),
        node("n_a"),
        node("n_b"),
        node("n_c"),
        node("n_d"),
      ],
      [
        edge("e_1", "n_trigger", "n_a"),
        edge("e_2", "n_a", "n_b"),
        edge("e_3", "n_b", "n_a"),
        edge("e_4", "n_trigger", "n_c"),
        edge("e_5", "n_c", "n_d"),
        edge("e_6", "n_d", "n_c"),
      ],
    );
    expect(codes(doc)).toEqual([ErrorCode.GRAPH_CYCLE, ErrorCode.GRAPH_CYCLE]);
  });
});

describe("rule 9: credential references resolve", () => {
  it("rejects an undeclared credential", () => {
    const doc = cloneOnboarding();
    doc.nodes[3]!.credential = "cred_nope";
    expect(codes(doc)).toEqual([ErrorCode.CREDENTIAL_REF_MISSING]);
  });

  it("does not also report a scope mismatch for a credential that is absent", () => {
    const doc = cloneOnboarding();
    doc.nodes[3]!.credential = "cred_nope";
    expect(checkGraph(doc).errors).toHaveLength(1);
  });
});

describe("rule 10: capability scope matches the capability's integration", () => {
  it("rejects a credential whose scope is for another integration", () => {
    const doc = cloneOnboarding();
    doc.nodes[3]!.credential = "cred_bamboohr";
    expect(codes(doc)).toEqual([ErrorCode.CAPABILITY_SCOPE_MISMATCH]);
  });

  it("names both the expected and the actual scope", () => {
    const doc = cloneOnboarding();
    doc.nodes[3]!.credential = "cred_bamboohr";
    expect(checkGraph(doc).errors[0]?.details).toMatchObject({
      capability: "slack.message.send",
      expected_scope: "slack",
      actual_scope: "bamboohr",
    });
  });

  it("reports once per referencing node, since one credential can be wrong twice", () => {
    const doc = cloneOnboarding();
    doc.credentials[2]!.capability_scope = "discord";
    expect(codes(doc)).toEqual([
      ErrorCode.CAPABILITY_SCOPE_MISMATCH,
      ErrorCode.CAPABILITY_SCOPE_MISMATCH,
    ]);
  });
});

describe("rule 11: expression node references are transitive predecessors", () => {
  it("rejects a forward reference", () => {
    const doc = cloneOnboarding();
    setAssignment(doc, "{{ n_slack_welcome.text }}");
    expect(codes(doc)).toEqual([ErrorCode.EXPRESSION_REF_NOT_PREDECESSOR]);
  });

  it("rejects a reference to a sibling branch that may not have run", () => {
    const doc = workflow(
      [
        node("n_trigger", { kind: "trigger" }),
        node("n_branch", { kind: "branch", capability: "core.branch.if" }),
        node("n_left"),
        node("n_right", { parameters: { text: "{{ n_left.result }}" } }),
      ],
      [
        edge("e_1", "n_trigger", "n_branch"),
        edge("e_2", "n_branch", "n_left", "true"),
        edge("e_3", "n_branch", "n_right", "false"),
      ],
    );
    expect(codes(doc)).toEqual([ErrorCode.EXPRESSION_REF_NOT_PREDECESSOR]);
  });

  it("rejects a node referencing its own output", () => {
    const doc = cloneOnboarding();
    setAssignment(doc, "{{ n_build_email.email }}");
    expect(checkGraph(doc).errors[0]?.details).toMatchObject({ reason: "self" });
  });

  it("rejects a reference to a node that does not exist", () => {
    const doc = cloneOnboarding();
    setAssignment(doc, "{{ n_ghost.field }}");
    expect(checkGraph(doc).errors[0]).toMatchObject({
      code: ErrorCode.EXPRESSION_REF_NOT_PREDECESSOR,
      details: { reason: "missing" },
    });
  });

  it("accepts a reference reached through an error port", () => {
    // The handler sits on the error branch and still reads the trigger,
    // because the trigger genuinely ran before the failure.
    const doc = workflow(
      [
        node("n_trigger", { kind: "trigger" }),
        node("n_risky", { error_policy: { on_error: "route" } }),
        node("n_handler", {
          kind: "error_handler",
          parameters: { text: "{{ n_trigger.employee.email }} failed" },
        }),
      ],
      [
        edge("e_1", "n_trigger", "n_risky"),
        edge("e_2", "n_risky", "n_handler", "error"),
      ],
    );
    expect(codes(doc)).toEqual([]);
  });

  it("accepts a loop body reading the loop's current item", () => {
    const doc = workflow(
      [
        node("n_trigger", { kind: "trigger" }),
        loopNode("n_loop", { items: "{{ n_trigger.rows }}", max_iterations: 10 }),
        node("n_body", { parameters: { text: "{{ n_loop.row.name }}" } }),
      ],
      [
        edge("e_1", "n_trigger", "n_loop"),
        edge("e_2", "n_loop", "n_body", "each"),
        edge("e_3", "n_body", "n_loop"),
      ],
    );
    expect(codes(doc)).toEqual([]);
  });

  it("accepts a node after a loop reading a node inside it", () => {
    // Once the done port fires, the body has run.
    const doc = workflow(
      [
        node("n_trigger", { kind: "trigger" }),
        loopNode("n_loop", { max_iterations: 10 }),
        node("n_body"),
        node("n_after", { parameters: { text: "{{ n_body.result }}" } }),
      ],
      [
        edge("e_1", "n_trigger", "n_loop"),
        edge("e_2", "n_loop", "n_body", "each"),
        edge("e_3", "n_body", "n_loop"),
        edge("e_4", "n_loop", "n_after", "done"),
      ],
    );
    expect(codes(doc)).toEqual([]);
  });

  it("checks edge conditions too", () => {
    const doc = conditionWorkflow("{{ n_later.status }}");
    expect(codes(doc)).toEqual([ErrorCode.EXPRESSION_REF_NOT_PREDECESSOR]);
  });

  it("lets an edge condition read the node it leaves, which has already run", () => {
    const doc = conditionWorkflow("{{ n_branch.status }}");
    expect(codes(doc)).toEqual([]);
  });
});

describe("rule 12: variable references resolve", () => {
  it("rejects an undeclared variable", () => {
    const doc = cloneOnboarding();
    setAssignment(doc, "{{ $vars.not_declared }}");
    expect(codes(doc)).toEqual([ErrorCode.UNKNOWN_VARIABLE_REF]);
  });

  it("checks edge conditions too", () => {
    const doc = conditionWorkflow("{{ $vars.missing }}");
    expect(codes(doc)).toEqual([ErrorCode.UNKNOWN_VARIABLE_REF]);
  });

  it("accepts a declared variable", () => {
    const doc = cloneOnboarding();
    setAssignment(doc, "{{ $vars.company_domain }}");
    expect(codes(doc)).toEqual([]);
  });
});

describe("expression parsing inside stage 4", () => {
  it("reports a malformed expression rather than ignoring it", () => {
    const doc = cloneOnboarding();
    setAssignment(doc, "{{ n_trigger.employee.first_name * 2 }}");
    expect(codes(doc)).toEqual([ErrorCode.EXPRESSION_PARSE_ERROR]);
  });

  it("skips the reference rules for a string it could not parse", () => {
    const doc = cloneOnboarding();
    setAssignment(doc, "{{ n_ghost.field + 1 }}");
    expect(codes(doc)).toEqual([ErrorCode.EXPRESSION_PARSE_ERROR]);
  });

  it("reports an unreadable grammar once, not once per string", () => {
    const doc = cloneOnboarding();
    doc.expression_grammar = "2";
    const errors = checkGraph(doc).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe(ErrorCode.EXPRESSION_GRAMMAR_UNSUPPORTED);
    expect(errors[0]?.path).toBe("/expression_grammar");
  });

  it("treats an unreadable grammar as terminal", () => {
    const doc = cloneOnboarding();
    doc.expression_grammar = "2";
    expect(classOf(checkGraph(doc).errors[0]!)).toBe("terminal");
  });

  it("still runs the non-expression rules when the grammar is unreadable", () => {
    const doc = cloneOnboarding();
    doc.expression_grammar = "2";
    doc.nodes[3]!.credential = "cred_nope";
    expect(codes(doc)).toEqual([
      ErrorCode.CREDENTIAL_REF_MISSING,
      ErrorCode.EXPRESSION_GRAMMAR_UNSUPPORTED,
    ]);
  });
});

describe("rule 14: no parameter value matches a secret pattern", () => {
  it("rejects a token in a parameter", () => {
    const doc = cloneOnboarding();
    doc.nodes[3]!.parameters["text"] = "use xoxb-123456789012-abcdefghijkl to post";
    expect(codes(doc)).toEqual([ErrorCode.SECRET_IN_PARAMETER]);
  });

  it("rejects a secret nested inside an array parameter", () => {
    const doc = cloneOnboarding();
    doc.nodes[1]!.parameters["assignments"] = [
      { field: "key", value: "AKIAIOSFODNN7EXAMPLE" },
    ];
    expect(codes(doc)).toEqual([ErrorCode.SECRET_IN_PARAMETER]);
  });

  it("rejects a secret in a variable default", () => {
    // Rule 15 only blocks a default on a variable marked sensitive, so an
    // unmarked variable holding a live key would otherwise pass everything.
    const doc = cloneOnboarding();
    doc.variables![0]!.default = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(codes(doc)).toEqual([ErrorCode.SECRET_IN_PARAMETER]);
  });

  it("never puts the secret in the error", () => {
    const doc = cloneOnboarding();
    doc.nodes[3]!.parameters["text"] = "AKIAIOSFODNN7EXAMPLE";
    const error = checkGraph(doc).errors[0]!;
    expect(JSON.stringify(error)).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(error.details).toMatchObject({ pattern: "aws_access_key_id" });
  });

  it("accepts a sensitive variable referenced from a password parameter", () => {
    // This is the shape the architecture tells authors to use, so the scanner
    // rejecting it would push people back toward putting the secret inline.
    const doc = cloneOnboarding();
    expect(doc.nodes[2]!.parameters["password"]).toBe("{{ $vars.temp_password }}");
    expect(codes(doc)).toEqual([]);
  });
});

describe("rule 15: a sensitive variable carries no default", () => {
  it("rejects a sensitive variable with a default", () => {
    const doc = cloneOnboarding();
    doc.variables![1]!.default = "hunter2";
    expect(codes(doc)).toEqual([ErrorCode.SENSITIVE_VARIABLE_HAS_DEFAULT]);
  });

  it("rejects an empty default too", () => {
    // The field table forbids a default outright when sensitive is true, and a
    // rule with no edge case is a rule nobody has to reason about later.
    const doc = cloneOnboarding();
    doc.variables![1]!.default = "";
    expect(codes(doc)).toEqual([ErrorCode.SENSITIVE_VARIABLE_HAS_DEFAULT]);
  });

  it("allows a default on a variable that is not sensitive", () => {
    const doc = workflow(
      [node("n_trigger", { kind: "trigger" })],
      [],
      [
        {
          id: "company_domain",
          label: "Company domain",
          type: "string",
          required: true,
          sensitive: false,
          default: "example.com",
        },
      ],
    );
    expect(codes(doc)).toEqual([]);
  });

  it("is logged as a prompt-quality signal, not an ordinary repair", () => {
    const doc = cloneOnboarding();
    doc.variables![1]!.default = "hunter2";
    expect(classOf(checkGraph(doc).errors[0]!)).toBe("repairable_prompt_signal");
  });
});

describe("rule 16: every loop has a finite max_iterations", () => {
  const withLoop = (parameters: Parameters): FFIRDocument =>
    workflow(
      [node("n_trigger", { kind: "trigger" }), loopNode("n_loop", parameters)],
      [edge("e_1", "n_trigger", "n_loop")],
    );

  it("rejects a loop with no bound", () => {
    expect(codes(withLoop({ item_alias: "row" }))).toEqual([ErrorCode.LOOP_UNBOUNDED]);
  });

  it.each([
    ["zero", 0],
    ["a negative bound", -1],
    ["a fraction", 1.5],
    ["a string", "500"],
    ["null", null],
  ])("rejects %s", (_label, value) => {
    expect(codes(withLoop({ max_iterations: value }))).toEqual([ErrorCode.LOOP_UNBOUNDED]);
  });

  it("rejects an expression, which is not a bound known at compile time", () => {
    const doc = workflow(
      [
        node("n_trigger", { kind: "trigger" }),
        loopNode("n_loop", { max_iterations: "{{ $vars.limit }}" }),
      ],
      [edge("e_1", "n_trigger", "n_loop")],
      [{ id: "limit", label: "Limit", type: "number", required: true, sensitive: false }],
    );
    expect(codes(doc)).toEqual([ErrorCode.LOOP_UNBOUNDED]);
  });

  it("accepts a positive whole number", () => {
    expect(codes(withLoop({ max_iterations: 500 }))).toEqual([]);
  });

  it("leaves non-loop nodes alone", () => {
    const doc = workflow(
      [node("n_trigger", { kind: "trigger" }), node("n_a")],
      [edge("e_1", "n_trigger", "n_a")],
    );
    expect(codes(doc)).toEqual([]);
  });
});

describe("rule 17: on_error route has an error edge", () => {
  it("rejects a route with nowhere to go", () => {
    const doc = cloneOnboarding();
    doc.nodes[3]!.error_policy = { on_error: "route" };
    expect(codes(doc)).toEqual([ErrorCode.ERROR_ROUTE_MISSING_EDGE]);
  });

  it("accepts a route that has somewhere to go", () => {
    const doc = workflow(
      [
        node("n_trigger", { kind: "trigger" }),
        node("n_risky", { error_policy: { on_error: "route" } }),
        node("n_handler", { kind: "error_handler" }),
      ],
      [
        edge("e_1", "n_trigger", "n_risky"),
        edge("e_2", "n_risky", "n_handler", "error"),
      ],
    );
    expect(codes(doc)).toEqual([]);
  });

  it("does not accept an ordinary outbound edge as the error route", () => {
    const doc = cloneOnboarding();
    doc.edges[3]!.port = "main";
    expect(codes(doc)).toEqual([ErrorCode.ERROR_ROUTE_MISSING_EDGE]);
  });

  it("leaves stop and continue alone", () => {
    const doc = cloneOnboarding();
    doc.nodes[2]!.error_policy = { on_error: "continue" };
    // Drop the error route entirely: the edge, and the handler it fed.
    doc.edges.splice(3, 1);
    doc.nodes.splice(4, 1);
    expect(codes(doc)).toEqual([]);
  });
});

describe("rule 18: a branch has at least two outbound edges", () => {
  const branch = (edges: Edge[]): FFIRDocument =>
    workflow(
      [
        node("n_trigger", { kind: "trigger" }),
        node("n_branch", { kind: "branch", capability: "core.branch.if" }),
        node("n_a"),
        node("n_b"),
      ],
      [edge("e_1", "n_trigger", "n_branch"), ...edges],
    );

  it("rejects a branch with no outbound edges", () => {
    const doc = workflow(
      [
        node("n_trigger", { kind: "trigger" }),
        node("n_branch", { kind: "branch", capability: "core.branch.if" }),
      ],
      [edge("e_1", "n_trigger", "n_branch")],
    );
    expect(codes(doc)).toEqual([ErrorCode.BRANCH_INSUFFICIENT_EDGES]);
  });

  it("rejects a branch with one outbound edge", () => {
    const doc = branch([
      edge("e_2", "n_branch", "n_a", "true"),
      edge("e_3", "n_a", "n_b"),
    ]);
    expect(codes(doc)).toEqual([ErrorCode.BRANCH_INSUFFICIENT_EDGES]);
  });

  it("does not count an error edge toward the two", () => {
    // The ports table lists "error" separately from a branch's own outputs, so
    // one case plus an error route is still one conditional output.
    const doc = branch([
      edge("e_2", "n_branch", "n_a", "true"),
      edge("e_3", "n_branch", "n_b", "error"),
    ]);
    expect(codes(doc)).toEqual([ErrorCode.BRANCH_INSUFFICIENT_EDGES]);
  });

  it("accepts a true and a false edge", () => {
    const doc = branch([
      edge("e_2", "n_branch", "n_a", "true"),
      edge("e_3", "n_branch", "n_b", "false"),
    ]);
    expect(codes(doc)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("collecting every failure", () => {
  it("returns exactly three errors for a document violating three rules", () => {
    const doc = cloneOnboarding();
    doc.nodes[3]!.credential = "cred_nope"; // rule 9
    doc.variables![1]!.default = "hunter2"; // rule 15
    doc.nodes.push(node("n_branch", { kind: "branch", capability: "core.branch.if" }));
    doc.edges.push(edge("e_branch", "n_slack_welcome", "n_branch")); // rule 18

    expect(codes(doc)).toEqual([
      ErrorCode.CREDENTIAL_REF_MISSING,
      ErrorCode.SENSITIVE_VARIABLE_HAS_DEFAULT,
      ErrorCode.BRANCH_INSUFFICIENT_EDGES,
    ]);
  });

  it("reports every instance of a rule, not just the first", () => {
    const doc = cloneOnboarding();
    doc.nodes.push(node("n_orphan_1"), node("n_orphan_2"));
    expect(codes(doc)).toEqual([ErrorCode.NODE_UNREACHABLE, ErrorCode.NODE_UNREACHABLE]);
  });

  it("orders errors by rule number, then by document order", () => {
    const doc = cloneOnboarding();
    doc.nodes.push(node("n_orphan")); // rule 5
    doc.edges.push(edge("e_bad", "n_slack_welcome", "n_nope")); // rule 1
    expect(codes(doc)).toEqual([
      ErrorCode.EDGE_ENDPOINT_MISSING,
      ErrorCode.NODE_UNREACHABLE,
    ]);
  });

  it("gives every error a JSON pointer into the document", () => {
    const doc = cloneOnboarding();
    doc.nodes[3]!.credential = "cred_nope";
    doc.variables![1]!.default = "hunter2";
    for (const error of checkGraph(doc).errors) {
      expect(error.path).toMatch(/^(\/[^/]+)+$/);
    }
  });
});

// ---------------------------------------------------------------------------

/** Replaces the worked example's one nested expression-bearing parameter. */
function setAssignment(doc: FFIRDocument, value: string): void {
  doc.nodes[1]!.parameters["assignments"] = [{ field: "email", value }];
}

/** A branch whose outgoing condition carries the expression under test. */
function conditionWorkflow(left: string): FFIRDocument {
  const doc = workflow(
    [
      node("n_trigger", { kind: "trigger" }),
      node("n_branch", { kind: "branch", capability: "core.branch.if" }),
      node("n_a"),
      node("n_later"),
    ],
    [
      edge("e_1", "n_trigger", "n_branch"),
      edge("e_2", "n_branch", "n_a", "true"),
      edge("e_3", "n_branch", "n_later", "false"),
    ],
  );
  doc.edges[1]!.condition = { left, operator: "equals", right: "yes" };
  return doc;
}
