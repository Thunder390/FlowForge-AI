/**
 * The registry's error vocabulary.
 *
 * Loading throws rather than returning a result object, which is the opposite
 * of how `ffir` reports validation failures, and the difference is deliberate.
 * A validation failure is an expected outcome the repair loop consumes. A
 * registry that will not load is an infrastructure fault: there is no document
 * to repair and no useful way to continue, and a caller that ignores it would
 * proceed with a registry that is silently missing capabilities.
 */

import type { SchemaViolation } from "./schema.js";

export const RegistryErrorCode = {
  /** The requested version is not published. Never a silent fallback to current. */
  VERSION_NOT_FOUND: "registry_version_not_found",
  /** The artifact source could not produce a file it listed. */
  ARTIFACT_UNREADABLE: "registry_artifact_unreadable",
  /** An artifact is not valid JSON, or does not match its schema. */
  ARTIFACT_INVALID: "registry_artifact_invalid",
  /** The artifacts are individually well-formed but do not join into a valid registry. */
  INTEGRITY_FAILED: "registry_integrity_failed",
} as const;

export type RegistryErrorCode =
  (typeof RegistryErrorCode)[keyof typeof RegistryErrorCode];

export class RegistryError extends Error {
  readonly code: RegistryErrorCode;
  readonly version: string;
  /** The artifact path within the version, when the fault is attributable to one. */
  readonly artifact?: string;

  constructor(
    code: RegistryErrorCode,
    version: string,
    message: string,
    options: { artifact?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RegistryError";
    this.code = code;
    this.version = version;
    if (options.artifact !== undefined) this.artifact = options.artifact;
  }
}

/** Thrown when an artifact fails its JSON Schema. Carries every violation, not the first. */
export class RegistryArtifactError extends RegistryError {
  readonly violations: readonly SchemaViolation[];

  constructor(version: string, artifact: string, violations: readonly SchemaViolation[]) {
    super(
      RegistryErrorCode.ARTIFACT_INVALID,
      version,
      `Registry artifact ${artifact} in ${version} does not match its schema:\n` +
        violations.map((v) => `  ${v.path || "/"}: ${v.message}`).join("\n"),
      { artifact },
    );
    this.name = "RegistryArtifactError";
    this.violations = violations;
  }
}
