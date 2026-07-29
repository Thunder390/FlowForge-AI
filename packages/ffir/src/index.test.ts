import { describe, expect, it } from "vitest";

import { onboardingExample } from "./__fixtures__/index.js";
import {
  DOCUMENT_LIMITS,
  ErrorCode,
  checkGraph,
  findSecret,
  isLiteralTemplate,
  parseTemplate,
  validateStructure,
  validateWithoutRegistry,
} from "./index.js";

/**
 * The package barrel re-exports four modules with `export *`. A name defined in
 * two of them is dropped silently rather than reported, so the entry point gets
 * a test of its own: nothing else in the package imports it.
 */
describe("package entry point", () => {
  it("exposes the validators", () => {
    expect(validateStructure(onboardingExample).ok).toBe(true);
    expect(DOCUMENT_LIMITS.max_nodes).toBe(150);
    expect(ErrorCode.EXPRESSION_PARSE_ERROR).toBe("expression_parse_error");
  });

  it("exposes the graph validator and the secret scanner", () => {
    expect(checkGraph(onboardingExample).ok).toBe(true);
    expect(validateWithoutRegistry(onboardingExample).ok).toBe(true);
    expect(findSecret("AKIAIOSFODNN7EXAMPLE")?.pattern).toBe("aws_access_key_id");
  });

  it("exposes the expression parser", () => {
    const result = parseTemplate("Hi {{ n_trigger.name }}", "1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isLiteralTemplate(result.template)).toBe(false);
  });
});
