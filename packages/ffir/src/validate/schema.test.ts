import { describe, expect, it } from "vitest";

import { cloneOnboarding, onboardingExample } from "../__fixtures__/index.js";
import { ErrorCode } from "./codes.js";
import { checkSchema, isFFIRDocument } from "./schema.js";

/** Every code produced, so a test can assert on the set rather than on ordering. */
function codes(input: unknown): string[] {
  return checkSchema(input).errors.map((e) => e.code);
}

function paths(input: unknown): string[] {
  return checkSchema(input).errors.map((e) => e.path);
}

describe("stage 1: a valid document", () => {
  it("accepts the worked example from WORKFLOW_SCHEMA.md", () => {
    const result = checkSchema(onboardingExample);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("narrows the type once it has passed", () => {
    expect(isFFIRDocument(onboardingExample)).toBe(true);
  });

  it("accepts a document with no variables and no metadata, both optional", () => {
    const doc = cloneOnboarding();
    delete doc.variables;
    delete doc.metadata;
    expect(checkSchema(doc).ok).toBe(true);
  });
});

describe("stage 1: required fields", () => {
  it.each([
    "ffir_version",
    "expression_grammar",
    "id",
    "name",
    "description",
    "nodes",
    "edges",
    "credentials",
  ])("rejects a document missing %s", (field) => {
    const doc = cloneOnboarding() as unknown as Record<string, unknown>;
    delete doc[field];

    const result = checkSchema(doc);
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain(ErrorCode.SCHEMA_VIOLATION);
    expect(result.errors.some((e) => e.message.includes(field))).toBe(true);
  });

  it.each(["id", "kind", "capability", "label", "parameters"])(
    "rejects a node missing %s",
    (field) => {
      const doc = cloneOnboarding();
      delete (doc.nodes[0] as unknown as Record<string, unknown>)[field];

      const result = checkSchema(doc);
      expect(result.ok).toBe(false);
      expect(paths(doc)).toContain("/nodes/0");
    },
  );

  it("rejects a variable missing sensitive, which the merge always sets", () => {
    const doc = cloneOnboarding();
    delete (doc.variables![0] as unknown as Record<string, unknown>)["sensitive"];

    const result = checkSchema(doc);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes("sensitive"))).toBe(true);
  });
});

describe("stage 1: closed objects", () => {
  it("rejects an unrecognised document property", () => {
    const doc = cloneOnboarding() as unknown as Record<string, unknown>;
    doc["n8n_export"] = { nodes: [] };

    const result = checkSchema(doc);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes("n8n_export"))).toBe(true);
  });

  it("rejects an unrecognised node property, which is how platform vocabulary leaks in", () => {
    const doc = cloneOnboarding();
    (doc.nodes[0] as unknown as Record<string, unknown>)["typeVersion"] = 2;

    const result = checkSchema(doc);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes("typeVersion"))).toBe(true);
  });

  it("allows arbitrary keys inside parameters, whose shape the registry owns", () => {
    const doc = cloneOnboarding();
    doc.nodes[0]!.parameters["anything_at_all"] = { nested: [1, 2, 3] };
    expect(checkSchema(doc).ok).toBe(true);
  });

  it("allows arbitrary keys inside metadata, which is non-semantic", () => {
    const doc = cloneOnboarding();
    doc.metadata!["some_future_annotation"] = "fine";
    expect(checkSchema(doc).ok).toBe(true);
  });
});

describe("stage 1: closed enums", () => {
  it("rejects an unknown node kind", () => {
    const doc = cloneOnboarding();
    (doc.nodes[0] as unknown as Record<string, unknown>)["kind"] = "webhook";

    const result = checkSchema(doc);
    expect(result.ok).toBe(false);
    expect(paths(doc)).toContain("/nodes/0/kind");
  });

  it("rejects an unknown condition operator", () => {
    const doc = cloneOnboarding();
    doc.edges[0]!.condition = {
      left: "{{ n_trigger.status }}",
      operator: "starts_with" as never,
      right: "a",
    };

    expect(checkSchema(doc).ok).toBe(false);
  });

  it("rejects an unknown on_error value", () => {
    const doc = cloneOnboarding();
    doc.nodes[2]!.error_policy!.on_error = "retry_forever" as never;

    const result = checkSchema(doc);
    expect(result.ok).toBe(false);
    expect(paths(doc)).toContain("/nodes/2/error_policy/on_error");
  });

  it("rejects an unknown auth_type", () => {
    const doc = cloneOnboarding();
    doc.credentials[0]!.auth_type = "kerberos" as never;
    expect(checkSchema(doc).ok).toBe(false);
  });

  it("rejects an unknown variable type", () => {
    const doc = cloneOnboarding();
    doc.variables![0]!.type = "date" as never;
    expect(checkSchema(doc).ok).toBe(false);
  });
});

describe("stage 1: formats", () => {
  it("rejects a capability that is not three dot-separated segments", () => {
    const doc = cloneOnboarding();
    doc.nodes[0]!.capability = "slack.send";

    const result = checkSchema(doc);
    expect(result.ok).toBe(false);
    expect(paths(doc)).toContain("/nodes/0/capability");
  });

  it("rejects a capability carrying platform vocabulary", () => {
    const doc = cloneOnboarding();
    doc.nodes[0]!.capability = "n8n-nodes-base.slack";
    expect(checkSchema(doc).ok).toBe(false);
  });

  it("rejects a node id that an expression could not reference", () => {
    const doc = cloneOnboarding();
    doc.nodes[0]!.id = "1-trigger";

    const result = checkSchema(doc);
    expect(result.ok).toBe(false);
    expect(paths(doc)).toContain("/nodes/0/id");
  });

  it("rejects an empty label", () => {
    const doc = cloneOnboarding();
    doc.nodes[0]!.label = "";
    expect(checkSchema(doc).ok).toBe(false);
  });
});

describe("stage 1: unary condition operators", () => {
  it("accepts is_empty with no right operand", () => {
    const doc = cloneOnboarding();
    doc.edges[0]!.condition = {
      left: "{{ n_trigger.employee.email }}",
      operator: "is_empty",
    };
    expect(checkSchema(doc).ok).toBe(true);
  });

  it("rejects is_empty carrying a right operand", () => {
    const doc = cloneOnboarding();
    doc.edges[0]!.condition = {
      left: "{{ n_trigger.employee.email }}",
      operator: "is_empty",
      right: "",
    };
    expect(checkSchema(doc).ok).toBe(false);
  });

  it("rejects a binary operator with no right operand", () => {
    const doc = cloneOnboarding();
    doc.edges[0]!.condition = {
      left: "{{ n_trigger.employee.role }}",
      operator: "equals",
    };
    expect(checkSchema(doc).ok).toBe(false);
  });
});

describe("stage 1: version support", () => {
  it("rejects a document from a future FFIR version rather than guessing", () => {
    const doc = cloneOnboarding();
    doc.ffir_version = "2.0";

    const result = checkSchema(doc);
    expect(result.ok).toBe(false);
    expect(codes(doc)).toContain(ErrorCode.FFIR_VERSION_UNSUPPORTED);
  });

  it("names the versions it does support", () => {
    const doc = cloneOnboarding();
    doc.ffir_version = "9.9";

    const error = checkSchema(doc).errors.find(
      (e) => e.code === ErrorCode.FFIR_VERSION_UNSUPPORTED,
    );
    expect(error?.details).toMatchObject({ declared: "9.9", supported: ["1.0"] });
  });

  it("rejects a malformed version string on format as well as support", () => {
    const doc = cloneOnboarding();
    doc.ffir_version = "one";

    const result = checkSchema(doc);
    expect(result.ok).toBe(false);
    expect(codes(doc)).toContain(ErrorCode.FFIR_VERSION_UNSUPPORTED);
    expect(codes(doc)).toContain(ErrorCode.SCHEMA_VIOLATION);
  });
});

describe("stage 1: collects every failure", () => {
  it("reports all three defects in one pass, not just the first", () => {
    const doc = cloneOnboarding() as unknown as Record<string, unknown>;
    delete doc["name"];
    (doc["nodes"] as Array<Record<string, unknown>>)[0]!["kind"] = "not_a_kind";
    (doc["credentials"] as Array<Record<string, unknown>>)[0]!["auth_type"] = "nope";

    const result = checkSchema(doc);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
    expect(paths(doc)).toEqual(
      expect.arrayContaining(["", "/nodes/0/kind", "/credentials/0/auth_type"]),
    );
  });
});
