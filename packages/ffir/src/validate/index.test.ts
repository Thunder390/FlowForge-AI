import { describe, expect, it } from "vitest";

import { cloneOnboarding, onboardingExample } from "../__fixtures__/index.js";
import { DOCUMENT_LIMITS } from "../limits.js";
import { ErrorCode } from "./codes.js";
import {
  validateStructure,
  validateStructureFromText,
  validateWithoutRegistry,
} from "./index.js";

describe("validateStructure", () => {
  it("accepts the worked example", () => {
    expect(validateStructure(onboardingExample)).toEqual({ ok: true, errors: [] });
  });

  it("runs stage 0 before stage 1", () => {
    // The document breaches a limit and is also schema-invalid. Only the limit
    // should be reported: handing an oversized document to the schema validator
    // is the attack the limits exist to stop.
    const doc = cloneOnboarding() as unknown as Record<string, unknown>;
    delete doc["name"];
    doc["nodes"] = Array.from({ length: DOCUMENT_LIMITS.max_nodes + 1 }, (_, i) => ({
      id: `n_${i}`,
      kind: "action",
      capability: "slack.message.send",
      label: "Filler",
      parameters: {},
    }));

    const result = validateStructure(doc);
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toEqual([ErrorCode.DOCUMENT_LIMIT_EXCEEDED]);
  });

  it("reaches stage 1 when the document is within limits", () => {
    const doc = cloneOnboarding() as unknown as Record<string, unknown>;
    delete doc["name"];

    const result = validateStructure(doc);
    expect(result.errors.map((e) => e.code)).toContain(ErrorCode.SCHEMA_VIOLATION);
  });
});

describe("validateWithoutRegistry", () => {
  it("accepts the worked example", () => {
    expect(validateWithoutRegistry(onboardingExample)).toEqual({ ok: true, errors: [] });
  });

  it("runs stage 4, which validateStructure does not", () => {
    const doc = cloneOnboarding();
    doc.nodes[3]!.credential = "cred_nope";

    expect(validateStructure(doc).ok).toBe(true);
    expect(validateWithoutRegistry(doc).errors.map((e) => e.code)).toEqual([
      ErrorCode.CREDENTIAL_REF_MISSING,
    ]);
  });

  it("does not reach stage 4 when the schema fails", () => {
    // The graph rules assume a document whose shape has already been proven,
    // so running them on one that failed stage 1 would mean guessing.
    const doc = cloneOnboarding() as unknown as Record<string, unknown>;
    delete doc["credentials"];

    const codes = validateWithoutRegistry(doc).errors.map((e) => e.code);
    expect(codes).toContain(ErrorCode.SCHEMA_VIOLATION);
    expect(codes).not.toContain(ErrorCode.CREDENTIAL_REF_MISSING);
  });

  it("does not reach stage 4 when a limit is breached", () => {
    const result = validateWithoutRegistry(onboardingExample, {
      rawByteLength: DOCUMENT_LIMITS.max_document_bytes + 1,
    });
    expect(result.errors.map((e) => e.code)).toEqual([ErrorCode.DOCUMENT_LIMIT_EXCEEDED]);
  });
});

describe("validateStructureFromText", () => {
  it("accepts the serialized worked example", () => {
    expect(validateStructureFromText(JSON.stringify(onboardingExample)).ok).toBe(true);
  });

  it("reports unparseable JSON as malformed rather than throwing", () => {
    const result = validateStructureFromText("{ not json");
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe(ErrorCode.DOCUMENT_MALFORMED);
  });

  it("bounds on the raw wire bytes, including whitespace a reparse would discard", () => {
    const padded =
      "{" + " ".repeat(DOCUMENT_LIMITS.max_document_bytes) + '"ffir_version": "1.0"}';

    const result = validateStructureFromText(padded);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.details).toMatchObject({ limit: "max_document_bytes" });
  });
});
