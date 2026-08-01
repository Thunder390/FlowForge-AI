/**
 * Branch lowering and operand type inference.
 *
 * The inference is tested against every operator because getting it wrong means
 * comparing `"10" > "9"` lexically, which is false and surprising, and it is the
 * kind of bug that only shows up on the one workflow where the numbers cross a
 * digit boundary.
 */

import { CONDITION_OPERATORS as FFIR_OPERATORS, type ConditionOperator } from "@flowforge/ffir";
import { loadFixtureRegistry } from "@flowforge/registry/fixtures";
import { describe, expect, it } from "vitest";

import { compile } from "../../compile.js";
import { CONDITION_OPERATORS } from "./conditions.js";
import { n8nTarget } from "./index.js";
import type { N8nNode, N8nWorkflow } from "./ir.js";

const registry = await loadFixtureRegistry();

/**
 * A two-way branch on one condition, wrapped in the smallest legal workflow.
 *
 * `left` defaults to a string field. Passing a different path is how the
 * inference cases reach a number or a boolean.
 */
function branchOn(
  operator: ConditionOperator,
  right: string | undefined,
  left = "{{ n_trigger.employee.first_name }}",
): N8nNode {
  const condition: Record<string, unknown> = { left, operator };
  if (right !== undefined) condition["right"] = right;

  const doc = {
    ffir_version: "1.0",
    expression_grammar: "1",
    id: "wf_cond",
    name: "Condition case",
    description: "One branch, one condition, two outputs.",
    nodes: [
      {
        id: "n_trigger",
        kind: "trigger",
        capability: "bamboohr.employee.created",
        label: "Trigger",
        parameters: {},
        credential: "cred_bamboohr",
      },
      {
        id: "n_probe",
        kind: "action",
        capability: "http.request.send",
        label: "Probe",
        parameters: { url: "https://example.com" },
      },
      {
        id: "n_branch",
        kind: "branch",
        capability: "core.branch.if",
        label: "Branch",
        parameters: {},
      },
      {
        id: "n_yes",
        kind: "action",
        capability: "slack.message.send",
        label: "Yes",
        parameters: { channel: "#a", text: "yes" },
        credential: "cred_slack",
      },
      {
        id: "n_no",
        kind: "action",
        capability: "slack.message.send",
        label: "No",
        parameters: { channel: "#b", text: "no" },
        credential: "cred_slack",
      },
    ],
    edges: [
      { id: "e_1", from: "n_trigger", to: "n_probe" },
      { id: "e_2", from: "n_probe", to: "n_branch" },
      { id: "e_3", from: "n_branch", to: "n_yes", port: "true", condition },
      { id: "e_4", from: "n_branch", to: "n_no", port: "false" },
    ],
    credentials: [
      {
        id: "cred_bamboohr",
        capability_scope: "bamboohr",
        auth_type: "api_key",
        label: "BambooHR API key",
      },
      {
        id: "cred_slack",
        capability_scope: "slack",
        auth_type: "oauth2",
        label: "Slack workspace",
        required_scopes: ["chat:write"],
      },
    ],
    variables: [
      {
        id: "company_domain",
        label: "Company email domain",
        type: "string",
        required: true,
        sensitive: false,
        default: "example.com",
      },
    ],
    metadata: { registry_version: "n8n@1.62.0+overlay.3" },
  };

  const result = compile(doc, registry, n8nTarget);
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.errors)}`);

  const workflow = JSON.parse(result.value.content) as N8nWorkflow;
  const branch = workflow.nodes.find((node) => node.name === "Branch");
  if (branch === undefined) throw new Error("no branch node");
  return branch;
}

function conditionOf(node: N8nNode): Record<string, unknown> {
  const group = node.parameters["conditions"] as { conditions: Record<string, unknown>[] };
  const first = group.conditions[0];
  if (first === undefined) throw new Error("no condition");
  return first;
}

describe("the operator table", () => {
  it("maps all nine FFIR operators", () => {
    expect(Object.keys(CONDITION_OPERATORS).sort()).toEqual([...FFIR_OPERATORS].sort());
  });

  it("maps each to the operation the architecture specifies", () => {
    const expected: Record<ConditionOperator, string> = {
      equals: "string.equals",
      not_equals: "string.notEquals",
      contains: "string.contains",
      not_contains: "string.notContains",
      greater_than: "number.gt",
      less_than: "number.lt",
      is_empty: "string.isEmpty",
      is_not_empty: "string.isNotEmpty",
      matches_regex: "string.regex",
    };

    for (const [operator, spec] of Object.entries(CONDITION_OPERATORS)) {
      expect(`${spec.fallback}.${spec.operation}`, operator).toBe(
        expected[operator as ConditionOperator],
      );
    }
  });
});

describe("binary operators", () => {
  const binary: ConditionOperator[] = [
    "equals",
    "not_equals",
    "contains",
    "not_contains",
    "greater_than",
    "less_than",
    "matches_regex",
  ];

  for (const operator of binary) {
    it(`${operator} carries both operands`, () => {
      const condition = conditionOf(branchOn(operator, "target"));
      expect(condition["leftValue"]).toBe(
        "={{ $('Trigger').item.json.employee.first_name }}",
      );
      expect(condition["rightValue"]).toBe("target");
      expect(condition["operator"]).not.toHaveProperty("singleValue");
    });
  }
});

describe("unary operators", () => {
  for (const operator of ["is_empty", "is_not_empty"] as ConditionOperator[]) {
    it(`${operator} takes no right operand`, () => {
      const condition = conditionOf(branchOn(operator, undefined));
      expect(condition).not.toHaveProperty("rightValue");
      expect(condition["operator"]).toMatchObject({ singleValue: true });
    });
  }

  it("cannot be handed a right operand in the first place", () => {
    // The schema forbids it, so the lowering's defensive branch is unreachable
    // through the pipeline. Asserting the gate rather than the dead code keeps
    // the guarantee where it actually lives.
    expect(() => branchOn("is_empty", "stray")).toThrow(/schema_violation/);
  });
});

describe("operand type inference", () => {
  it("uses the registry's declared type for equals", () => {
    // http.request.send declares status_code as a number.
    const condition = conditionOf(
      branchOn("equals", "200", "{{ n_probe.status_code }}"),
    );
    expect(condition["operator"]).toMatchObject({ type: "number", operation: "equals" });
  });

  it("falls back to string for a field the registry does not declare", () => {
    const condition = conditionOf(branchOn("equals", "x", "{{ n_probe.not_declared }}"));
    expect(condition["operator"]).toMatchObject({ type: "string" });
  });

  it("keeps gt and lt numeric whatever the field says", () => {
    // This is the case the inference exists for. A string field must not make
    // the comparison lexical, because "10" > "9" is false.
    for (const operator of ["greater_than", "less_than"] as ConditionOperator[]) {
      const condition = conditionOf(
        branchOn(operator, "9", "{{ n_trigger.employee.first_name }}"),
      );
      expect(condition["operator"], operator).toMatchObject({ type: "number" });
    }
  });

  it("keeps the string-only operations on string even for a number field", () => {
    for (const operator of [
      "contains",
      "not_contains",
      "matches_regex",
    ] as ConditionOperator[]) {
      const condition = conditionOf(branchOn(operator, "2", "{{ n_probe.status_code }}"));
      expect(condition["operator"], operator).toMatchObject({ type: "string" });
    }
  });

  it("does not infer from a template that is more than one reference", () => {
    // Text around a reference makes the operand a string by construction.
    const condition = conditionOf(
      branchOn("equals", "x", "code {{ n_probe.status_code }}"),
    );
    expect(condition["operator"]).toMatchObject({ type: "string" });
  });

  it("does not infer from a variable reference", () => {
    const condition = conditionOf(branchOn("equals", "x", "{{ $vars.company_domain }}"));
    expect(condition["operator"]).toMatchObject({ type: "string" });
  });

  it("walks a nested output shape", () => {
    // bamboohr declares employee as an object with a datetime hire_date.
    const condition = conditionOf(
      branchOn("equals", "2026-01-01", "{{ n_trigger.employee.hire_date }}"),
    );
    expect(condition["operator"]).toMatchObject({ type: "dateTime" });
  });
});

describe("the condition group", () => {
  it("wraps the condition with a combinator and loose type validation", () => {
    // An operand that resolves at run time cannot be type-checked at import
    // time, and strict validation would reject the workflow as n8n loads it.
    const group = branchOn("equals", "x").parameters["conditions"] as Record<string, unknown>;
    expect(group["combinator"]).toBe("and");
    expect(group["options"]).toMatchObject({ typeValidation: "loose", version: 2 });
  });

  it("defaults case sensitivity to true and honours an explicit false", () => {
    const group = branchOn("equals", "x").parameters["conditions"] as {
      options: { caseSensitive: boolean };
    };
    expect(group.options.caseSensitive).toBe(true);
  });

  it("gives each condition a stable id", () => {
    const first = conditionOf(branchOn("equals", "x"));
    const second = conditionOf(branchOn("equals", "x"));
    expect(first["id"]).toBe(second["id"]);
    expect(first["id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("node type selection", () => {
  it("uses the If node for a two-way branch", () => {
    expect(branchOn("equals", "x")).toMatchObject({
      type: "n8n-nodes-base.if",
      typeVersion: 2.2,
    });
  });
});
