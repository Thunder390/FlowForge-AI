import onboarding from "./onboarding.ffir.json" with { type: "json" };

import type { FFIRDocument } from "../types.js";

/**
 * The BambooHR onboarding example from docs/WORKFLOW_SCHEMA.md, byte for byte.
 * It is the reference document for every stage of the pipeline: if it stops
 * validating, either the schema drifted from the spec or the spec changed and
 * this fixture did not.
 */
export const onboardingExample = onboarding as unknown as FFIRDocument;

/** A deep clone, so a test that mutates does not poison the next one. */
export function cloneOnboarding(): FFIRDocument {
  return structuredClone(onboardingExample);
}
