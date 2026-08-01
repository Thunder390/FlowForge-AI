/**
 * Recorded provider responses.
 *
 * Exported under the `./fixtures` subpath rather than from the main entry, so
 * the orchestrator's tests can drive a full generation without recordings
 * becoming part of this package's public surface.
 */

export {
  onboardingFixture,
  ONBOARDING_DOCUMENT_ID,
  ONBOARDING_GENERATED_AT,
  ONBOARDING_PARAMETERS,
  ONBOARDING_PLAN,
  ONBOARDING_PROMPT,
  type OnboardingFixture,
} from "./onboarding.js";
