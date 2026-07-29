import { describe, expect, it } from "vitest";

import { cloneOnboarding, onboardingExample } from "../__fixtures__/index.js";
import { DOCUMENT_LIMITS } from "../limits.js";
import { ErrorCode } from "./codes.js";
import { validateStructure, validateStructureFromText } from "./index.js";

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
