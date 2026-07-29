import { describe, expect, it } from "vitest";

import { cloneOnboarding, onboardingExample } from "../__fixtures__/index.js";
import { DOCUMENT_LIMITS, type LimitName } from "../limits.js";
import type { Edge, Node, Variable, CredentialRef } from "../types.js";
import { ErrorCode } from "./codes.js";
import { checkLimits, scanExpressions } from "./limits.js";
import { isTerminal } from "./result.js";

/** The limit names reported by a check, so a test can name the limit it means. */
function breachedLimits(input: unknown): LimitName[] {
  return checkLimits(input).errors.map((e) => e.details?.["limit"] as LimitName);
}

function makeNode(id: string): Node {
  return {
    id,
    kind: "action",
    capability: "slack.message.send",
    label: "Filler",
    parameters: { channel: "#general", text: "hi" },
  };
}

function makeEdge(id: string): Edge {
  return { id, from: "n_trigger", to: "n_build_email" };
}

function makeVariable(id: string): Variable {
  return { id, label: "Filler", type: "string", required: false, sensitive: false };
}

function makeCredential(id: string): CredentialRef {
  return { id, capability_scope: "slack", auth_type: "oauth2", label: "Filler" };
}

describe("stage 0: gross shape", () => {
  it.each([
    ["null", null],
    ["an array", [] as unknown],
    ["a string", "not a document"],
    ["a number", 42],
    ["undefined", undefined],
  ])("rejects %s as malformed rather than throwing", (_label, input) => {
    const result = checkLimits(input);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe(ErrorCode.DOCUMENT_MALFORMED);
  });

  it("does not throw on a document whose collections are the wrong type", () => {
    // Stage 1 owns reporting this. Stage 0 must simply survive it.
    expect(() =>
      checkLimits({ nodes: "not an array", edges: 7, variables: null }),
    ).not.toThrow();
  });
});

describe("stage 0: the worked example", () => {
  it("passes every limit", () => {
    const result = checkLimits(onboardingExample);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("stage 0: one case per limit", () => {
  it("rejects more than max_nodes nodes", () => {
    const doc = cloneOnboarding();
    doc.nodes = Array.from({ length: DOCUMENT_LIMITS.max_nodes + 1 }, (_, i) =>
      makeNode(`n_${i}`),
    );
    expect(breachedLimits(doc)).toContain("max_nodes");
  });

  it("accepts exactly max_nodes nodes, so the bound is inclusive", () => {
    const doc = cloneOnboarding();
    doc.nodes = Array.from({ length: DOCUMENT_LIMITS.max_nodes }, (_, i) =>
      makeNode(`n_${i}`),
    );
    expect(breachedLimits(doc)).not.toContain("max_nodes");
  });

  it("rejects more than max_edges edges", () => {
    const doc = cloneOnboarding();
    doc.edges = Array.from({ length: DOCUMENT_LIMITS.max_edges + 1 }, (_, i) =>
      makeEdge(`e_${i}`),
    );
    expect(breachedLimits(doc)).toContain("max_edges");
  });

  it("rejects more than max_variables variables", () => {
    const doc = cloneOnboarding();
    doc.variables = Array.from({ length: DOCUMENT_LIMITS.max_variables + 1 }, (_, i) =>
      makeVariable(`v_${i}`),
    );
    expect(breachedLimits(doc)).toContain("max_variables");
  });

  it("rejects more than max_credentials credentials", () => {
    const doc = cloneOnboarding();
    doc.credentials = Array.from(
      { length: DOCUMENT_LIMITS.max_credentials + 1 },
      (_, i) => makeCredential(`cred_${i}`),
    );
    expect(breachedLimits(doc)).toContain("max_credentials");
  });

  it("rejects an expression longer than max_expression_length", () => {
    const doc = cloneOnboarding();
    const padding = "a".repeat(DOCUMENT_LIMITS.max_expression_length);
    doc.nodes[3]!.parameters["text"] = `{{ n_trigger.${padding} }}`;
    expect(breachedLimits(doc)).toContain("max_expression_length");
  });

  it("rejects an expression deeper than max_expression_path_depth", () => {
    const doc = cloneOnboarding();
    const deep = Array.from(
      { length: DOCUMENT_LIMITS.max_expression_path_depth + 1 },
      (_, i) => `s${i}`,
    ).join(".");
    doc.nodes[3]!.parameters["text"] = `{{ n_trigger.${deep} }}`;
    expect(breachedLimits(doc)).toContain("max_expression_path_depth");
  });

  it("rejects more than max_expressions_per_parameter expressions in one parameter", () => {
    const doc = cloneOnboarding();
    doc.nodes[3]!.parameters["text"] = Array.from(
      { length: DOCUMENT_LIMITS.max_expressions_per_parameter + 1 },
      () => "{{ n_trigger.employee.first_name }}",
    ).join(" ");
    expect(breachedLimits(doc)).toContain("max_expressions_per_parameter");
  });

  it("rejects a node parameter payload over max_parameter_payload_bytes", () => {
    const doc = cloneOnboarding();
    doc.nodes[3]!.parameters["text"] = "x".repeat(
      DOCUMENT_LIMITS.max_parameter_payload_bytes + 1,
    );
    expect(breachedLimits(doc)).toContain("max_parameter_payload_bytes");
  });

  it("rejects a document over max_document_bytes", () => {
    const doc = cloneOnboarding();
    // Spread across many nodes so no single parameter payload breaches first.
    const chunk = "y".repeat(32 * 1024);
    doc.nodes = Array.from({ length: 40 }, (_, i) => ({
      ...makeNode(`n_pad_${i}`),
      parameters: { text: chunk },
    }));
    expect(breachedLimits(doc)).toContain("max_document_bytes");
  });

  it("measures document size in raw wire bytes when the caller supplies them", () => {
    const doc = cloneOnboarding();
    const result = checkLimits(doc, {
      rawByteLength: DOCUMENT_LIMITS.max_document_bytes + 1,
    });
    expect(breachedLimits(doc)).not.toContain("max_document_bytes");
    expect(result.errors.map((e) => e.details?.["limit"])).toContain("max_document_bytes");
  });

  it("covers every limit in the table", () => {
    // Guards against a limit being added to the table and never tested.
    const tested = new Set<LimitName>([
      "max_nodes",
      "max_edges",
      "max_variables",
      "max_credentials",
      "max_expression_length",
      "max_expression_path_depth",
      "max_expressions_per_parameter",
      "max_parameter_payload_bytes",
      "max_document_bytes",
    ]);
    expect([...Object.keys(DOCUMENT_LIMITS)].sort()).toEqual([...tested].sort());
  });
});

describe("stage 0: error shape", () => {
  it("reports document_limit_exceeded naming the limit, the max, and the actual", () => {
    const doc = cloneOnboarding();
    doc.nodes = Array.from({ length: DOCUMENT_LIMITS.max_nodes + 5 }, (_, i) =>
      makeNode(`n_${i}`),
    );

    const error = checkLimits(doc).errors[0]!;
    expect(error.code).toBe(ErrorCode.DOCUMENT_LIMIT_EXCEEDED);
    expect(error.path).toBe("/nodes");
    expect(error.details).toEqual({
      limit: "max_nodes",
      max: DOCUMENT_LIMITS.max_nodes,
      actual: DOCUMENT_LIMITS.max_nodes + 5,
    });
  });

  it("is terminal, because there is no repair for a document that is too big", () => {
    const doc = cloneOnboarding();
    doc.nodes = Array.from({ length: DOCUMENT_LIMITS.max_nodes + 1 }, (_, i) =>
      makeNode(`n_${i}`),
    );
    expect(isTerminal(checkLimits(doc))).toBe(true);
  });

  it("points at the offending parameter with a JSON pointer", () => {
    const doc = cloneOnboarding();
    doc.nodes[3]!.parameters["text"] = "x".repeat(
      DOCUMENT_LIMITS.max_parameter_payload_bytes + 1,
    );

    const error = checkLimits(doc).errors[0]!;
    expect(error.path).toBe("/nodes/3/parameters");
  });

  it("collects every breach rather than stopping at the first", () => {
    const doc = cloneOnboarding();
    doc.nodes = Array.from({ length: DOCUMENT_LIMITS.max_nodes + 1 }, (_, i) =>
      makeNode(`n_${i}`),
    );
    doc.edges = Array.from({ length: DOCUMENT_LIMITS.max_edges + 1 }, (_, i) =>
      makeEdge(`e_${i}`),
    );
    doc.credentials = Array.from(
      { length: DOCUMENT_LIMITS.max_credentials + 1 },
      (_, i) => makeCredential(`cred_${i}`),
    );

    expect(breachedLimits(doc)).toEqual(
      expect.arrayContaining(["max_nodes", "max_edges", "max_credentials"]),
    );
  });
});

describe("the expression scanner", () => {
  it("finds nothing in a literal string", () => {
    expect(scanExpressions("just text")).toEqual([]);
  });

  it("measures depth as components after the root plus bracket indices", () => {
    expect(scanExpressions("{{ n_http_1.body.items[0].id }}")[0]?.depth).toBe(4);
    expect(scanExpressions("{{ n_trigger.email }}")[0]?.depth).toBe(1);
    expect(scanExpressions("{{ $now }}")[0]?.depth).toBe(0);
  });

  it("finds every occurrence in a mixed literal", () => {
    const found = scanExpressions("Hi {{ a.b }}, your id is {{ c.d }}.");
    expect(found).toHaveLength(2);
  });

  it("measures length including the braces, against the length limit", () => {
    expect(scanExpressions("{{ a.b }}")[0]?.length).toBe(9);
  });

  it("finds expressions nested inside arrays and objects in a parameter value", () => {
    const doc = cloneOnboarding();
    doc.nodes[1]!.parameters["assignments"] = Array.from(
      { length: DOCUMENT_LIMITS.max_expressions_per_parameter + 1 },
      () => ({ field: "x", value: "{{ n_trigger.employee.first_name }}" }),
    );
    expect(breachedLimits(doc)).toContain("max_expressions_per_parameter");
  });
});
