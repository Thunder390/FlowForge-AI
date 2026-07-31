/**
 * Whole-build integrity: the properties no single artifact can have on its own.
 *
 * Schema conformance proves each file is well-formed. These checks prove the
 * files join into a registry. They are the load-side subset of the build
 * validation rules in NODE_REGISTRY.md, restricted to the ones whose violation
 * would corrupt the in-memory model silently:
 *
 * - a duplicate capability ID shadows one definition with another
 * - a binding for a capability that does not exist vanishes at join time
 * - a colliding alias makes retrieval pick arbitrarily between two capabilities
 * - a `parameter_map` naming an undeclared parameter maps nothing, and the
 *   compiler emits a workflow that imports cleanly and is missing configuration
 * - an `auth_required` naming no auth definition produces a credential with no
 *   setup instructions
 * - an index row disagreeing with its capability sends pass A a description of
 *   something other than what it will get
 *
 * The full seven-rule build gate belongs to `tools/registry-gen` and lands with
 * the generator in M20. This runs on every load because a published artifact is
 * still an input, and the architecture's fourth invariant is that validation
 * does not trust its input's origin.
 */

import {
  CAPABILITY_ID_PATTERN,
  CORE_CAPABILITIES,
  CORE_INTEGRATION,
  type BindingFile,
  type CapabilityFile,
  type RegistryIndex,
} from "./types.js";
import { sameParameterValue } from "./validate-params.js";

export const IntegrityCode = {
  CAPABILITY_ID_MALFORMED: "capability_id_malformed",
  DUPLICATE_CAPABILITY_ID: "duplicate_capability_id",
  CAPABILITY_INTEGRATION_MISMATCH: "capability_integration_mismatch",
  DUPLICATE_INTEGRATION: "duplicate_integration",
  BINDING_WITHOUT_CAPABILITY: "binding_without_capability",
  BINDING_FILE_PLATFORM_MISMATCH: "binding_file_platform_mismatch",
  ALIAS_COLLISION: "alias_collision",
  PARAMETER_MAP_UNKNOWN_PARAMETER: "parameter_map_unknown_parameter",
  TRANSFORM_UNKNOWN_PARAMETER: "transform_unknown_parameter",
  AUTH_REQUIRED_MISSING: "auth_required_missing",
  AUTH_SCOPE_UNDECLARED: "auth_scope_undeclared",
  PATTERN_UNCOMPILABLE: "pattern_uncompilable",
  ENUM_DEFAULT_NOT_IN_VALUES: "enum_default_not_in_values",
  CONDITIONAL_REQUIRED_UNKNOWN_PARAMETER: "conditional_required_unknown_parameter",
  REPLACED_BY_UNKNOWN: "replaced_by_unknown",
  CORE_CAPABILITY_MISSING: "core_capability_missing",
  CORE_CAPABILITY_UNBOUND: "core_capability_unbound",
  INDEX_ENTRY_WITHOUT_CAPABILITY: "index_entry_without_capability",
  INDEX_ENTRY_MISSING: "index_entry_missing",
  INDEX_ENTRY_STALE: "index_entry_stale",
  INDEX_VERSION_MISMATCH: "index_version_mismatch",
} as const;

export type IntegrityCode = (typeof IntegrityCode)[keyof typeof IntegrityCode];

export interface IntegrityIssue {
  code: IntegrityCode;
  /** The artifact the fault is attributable to, as a path within the version. */
  artifact: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface IntegrityInput {
  version: string;
  capabilityFiles: readonly CapabilityFile[];
  /** Keyed by platform, then holding that platform's files. */
  bindingFiles: ReadonlyMap<string, readonly BindingFile[]>;
  index: RegistryIndex;
}

/**
 * Runs every check and returns all failures.
 *
 * Collecting rather than throwing on the first one matters here more than in
 * most validators: a curator who has just hand-edited six capability files
 * wants the whole list, not six consecutive load attempts.
 */
export function checkIntegrity(input: IntegrityInput): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];

  const capabilities = collectCapabilities(input.capabilityFiles, issues);
  checkIntegrations(input.capabilityFiles, issues);
  checkAliases(input.capabilityFiles, issues);
  checkParameterRules(input.capabilityFiles, issues);
  checkAuthReferences(input.capabilityFiles, issues);
  checkReplacements(input.capabilityFiles, capabilities, issues);
  checkCoreCoverage(capabilities, input.bindingFiles, issues);
  checkBindings(input.bindingFiles, capabilities, issues);
  checkIndex(input.index, input.version, input.capabilityFiles, issues);

  return issues;
}

interface CapabilityLocation {
  integration: string;
  artifact: string;
  parameterNames: ReadonlySet<string>;
}

function collectCapabilities(
  files: readonly CapabilityFile[],
  issues: IntegrityIssue[],
): Map<string, CapabilityLocation> {
  const seen = new Map<string, CapabilityLocation>();

  for (const file of files) {
    const artifact = capabilityArtifact(file.integration);
    for (const capability of file.capabilities) {
      if (!CAPABILITY_ID_PATTERN.test(capability.id)) {
        issues.push({
          code: IntegrityCode.CAPABILITY_ID_MALFORMED,
          artifact,
          message: `Capability ID "${capability.id}" is not <integration>.<resource>.<operation> in lowercase snake_case.`,
          details: { capability_id: capability.id },
        });
        continue;
      }

      const integrationSegment = capability.id.slice(0, capability.id.indexOf("."));
      if (integrationSegment !== file.integration) {
        issues.push({
          code: IntegrityCode.CAPABILITY_INTEGRATION_MISMATCH,
          artifact,
          message: `Capability "${capability.id}" is declared in the "${file.integration}" file but its integration segment is "${integrationSegment}".`,
          details: { capability_id: capability.id, integration: file.integration },
        });
        continue;
      }

      const existing = seen.get(capability.id);
      if (existing !== undefined) {
        issues.push({
          code: IntegrityCode.DUPLICATE_CAPABILITY_ID,
          artifact,
          message: `Capability "${capability.id}" is defined in both ${existing.artifact} and ${artifact}.`,
          details: { capability_id: capability.id, also_in: existing.artifact },
        });
        continue;
      }

      seen.set(capability.id, {
        integration: file.integration,
        artifact,
        parameterNames: new Set(Object.keys(capability.parameters)),
      });
    }
  }

  return seen;
}

function checkIntegrations(
  files: readonly CapabilityFile[],
  issues: IntegrityIssue[],
): void {
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.integration)) {
      issues.push({
        code: IntegrityCode.DUPLICATE_INTEGRATION,
        artifact: capabilityArtifact(file.integration),
        message: `Integration "${file.integration}" is defined by more than one capability file.`,
        details: { integration: file.integration },
      });
      continue;
    }
    seen.add(file.integration);
  }
}

/**
 * Build validation rule 7.
 *
 * An alias that names two capabilities makes rung 1 of the unknown-capability
 * ladder pick one of them for reasons the curator cannot see. Integration-level
 * aliases are checked against each other for the same reason, but not against
 * capability aliases: "slack" naming both the integration and nothing in
 * particular is the normal case.
 */
function checkAliases(files: readonly CapabilityFile[], issues: IntegrityIssue[]): void {
  const capabilityAliases = new Map<string, string>();
  const integrationAliases = new Map<string, string>();

  for (const file of files) {
    const artifact = capabilityArtifact(file.integration);

    for (const alias of file.aliases) {
      const key = normalizeAlias(alias);
      const owner = integrationAliases.get(key);
      if (owner !== undefined && owner !== file.integration) {
        issues.push({
          code: IntegrityCode.ALIAS_COLLISION,
          artifact,
          message: `Alias "${alias}" is claimed by integrations "${owner}" and "${file.integration}".`,
          details: { alias, owners: [owner, file.integration] },
        });
        continue;
      }
      integrationAliases.set(key, file.integration);
    }

    for (const capability of file.capabilities) {
      for (const alias of capability.aliases) {
        const key = normalizeAlias(alias);
        const owner = capabilityAliases.get(key);
        if (owner !== undefined && owner !== capability.id) {
          issues.push({
            code: IntegrityCode.ALIAS_COLLISION,
            artifact,
            message: `Alias "${alias}" is claimed by both "${owner}" and "${capability.id}".`,
            details: { alias, owners: [owner, capability.id] },
          });
          continue;
        }
        capabilityAliases.set(key, capability.id);
      }
    }
  }
}

/**
 * Parameter-level rules that JSON Schema cannot express: that a `pattern`
 * compiles, that an enum's default is one of its values, and that a
 * `conditional_required` names a real sibling.
 */
function checkParameterRules(
  files: readonly CapabilityFile[],
  issues: IntegrityIssue[],
): void {
  for (const file of files) {
    const artifact = capabilityArtifact(file.integration);
    for (const capability of file.capabilities) {
      const names = new Set(Object.keys(capability.parameters));

      for (const [name, parameter] of Object.entries(capability.parameters)) {
        const pattern = parameter.validation?.pattern;
        if (pattern !== undefined && !compiles(pattern)) {
          issues.push({
            code: IntegrityCode.PATTERN_UNCOMPILABLE,
            artifact,
            message: `Parameter "${name}" of "${capability.id}" has a validation pattern that is not a valid regular expression: ${pattern}`,
            details: { capability_id: capability.id, parameter: name, pattern },
          });
        }

        if (
          parameter.type === "enum" &&
          parameter.default !== undefined &&
          parameter.values !== undefined &&
          !parameter.values.some((value) =>
            sameParameterValue(value, parameter.default),
          )
        ) {
          issues.push({
            code: IntegrityCode.ENUM_DEFAULT_NOT_IN_VALUES,
            artifact,
            message: `Parameter "${name}" of "${capability.id}" defaults to a value outside its own enum.`,
            details: {
              capability_id: capability.id,
              parameter: name,
              default: parameter.default,
            },
          });
        }

        for (const sibling of Object.keys(parameter.conditional_required?.when ?? {})) {
          if (names.has(sibling)) continue;
          issues.push({
            code: IntegrityCode.CONDITIONAL_REQUIRED_UNKNOWN_PARAMETER,
            artifact,
            message: `Parameter "${name}" of "${capability.id}" is conditionally required on "${sibling}", which that capability does not declare.`,
            details: { capability_id: capability.id, parameter: name, sibling },
          });
        }
      }
    }
  }
}

/** Build validation rule 5, plus the scope check the setup guide depends on. */
function checkAuthReferences(
  files: readonly CapabilityFile[],
  issues: IntegrityIssue[],
): void {
  for (const file of files) {
    const artifact = capabilityArtifact(file.integration);
    const byId = new Map(file.auth.map((auth) => [auth.id, auth]));

    for (const capability of file.capabilities) {
      if (capability.auth_required === undefined) continue;

      const auth = byId.get(capability.auth_required);
      if (auth === undefined) {
        issues.push({
          code: IntegrityCode.AUTH_REQUIRED_MISSING,
          artifact,
          message: `Capability "${capability.id}" requires auth "${capability.auth_required}", which "${file.integration}" does not define.`,
          details: {
            capability_id: capability.id,
            auth_required: capability.auth_required,
          },
        });
        continue;
      }

      const available = auth.scopes_available;
      if (available === undefined) continue;
      for (const scope of capability.required_scopes ?? []) {
        if (available.includes(scope)) continue;
        issues.push({
          code: IntegrityCode.AUTH_SCOPE_UNDECLARED,
          artifact,
          message: `Capability "${capability.id}" requires scope "${scope}", which auth "${auth.id}" does not list as available.`,
          details: { capability_id: capability.id, auth_id: auth.id, scope },
        });
      }
    }
  }
}

/** A deprecated capability points somewhere, and somewhere has to exist. */
function checkReplacements(
  files: readonly CapabilityFile[],
  capabilities: ReadonlyMap<string, CapabilityLocation>,
  issues: IntegrityIssue[],
): void {
  for (const file of files) {
    for (const capability of file.capabilities) {
      const replacement = capability.replaced_by;
      if (replacement === undefined || capabilities.has(replacement)) continue;
      issues.push({
        code: IntegrityCode.REPLACED_BY_UNKNOWN,
        artifact: capabilityArtifact(file.integration),
        message: `Capability "${capability.id}" is replaced by "${replacement}", which this registry does not contain.`,
        details: { capability_id: capability.id, replaced_by: replacement },
      });
    }
  }
}

/**
 * Build validation rule 6, the important one.
 *
 * `core.*` capabilities are what FFIR itself depends on, so a target that
 * cannot express `core.branch.if` cannot be a target at all. Learning that at
 * load time is the whole point; learning it at compile time means a user is
 * already waiting.
 */
function checkCoreCoverage(
  capabilities: ReadonlyMap<string, CapabilityLocation>,
  bindingFiles: ReadonlyMap<string, readonly BindingFile[]>,
  issues: IntegrityIssue[],
): void {
  const coreArtifact = capabilityArtifact(CORE_INTEGRATION);

  for (const required of CORE_CAPABILITIES) {
    if (capabilities.has(required)) continue;
    issues.push({
      code: IntegrityCode.CORE_CAPABILITY_MISSING,
      artifact: coreArtifact,
      message: `Core capability "${required}" is absent. FFIR depends on it, so every registry must define it.`,
      details: { capability_id: required },
    });
  }

  for (const [platform, files] of bindingFiles) {
    const bound = new Set<string>();
    for (const file of files) {
      for (const [id, binding] of Object.entries(file.bindings)) {
        if (binding !== null) bound.add(id);
      }
    }
    for (const required of CORE_CAPABILITIES) {
      if (!capabilities.has(required) || bound.has(required)) continue;
      issues.push({
        code: IntegrityCode.CORE_CAPABILITY_UNBOUND,
        artifact: bindingArtifact(platform, CORE_INTEGRATION),
        message: `Target "${platform}" has no binding for core capability "${required}". A target that cannot express it cannot be a target.`,
        details: { capability_id: required, platform },
      });
    }
  }
}

/** Build validation rule 4, plus the join every binding file depends on. */
function checkBindings(
  bindingFiles: ReadonlyMap<string, readonly BindingFile[]>,
  capabilities: ReadonlyMap<string, CapabilityLocation>,
  issues: IntegrityIssue[],
): void {
  for (const [platform, files] of bindingFiles) {
    for (const file of files) {
      const artifact = bindingArtifact(platform, file.integration);

      if (file.platform !== platform) {
        issues.push({
          code: IntegrityCode.BINDING_FILE_PLATFORM_MISMATCH,
          artifact,
          message: `Binding file declares platform "${file.platform}" but sits in the "${platform}" directory.`,
          details: { declared: file.platform, directory: platform },
        });
      }

      for (const [capabilityId, binding] of Object.entries(file.bindings)) {
        const capability = capabilities.get(capabilityId);
        if (capability === undefined) {
          issues.push({
            code: IntegrityCode.BINDING_WITHOUT_CAPABILITY,
            artifact,
            message: `Binding names capability "${capabilityId}", which no capability file defines.`,
            details: { capability_id: capabilityId, platform },
          });
          continue;
        }
        if (binding === null) continue;

        for (const parameter of Object.keys(binding.parameter_map ?? {})) {
          if (capability.parameterNames.has(parameter)) continue;
          issues.push({
            code: IntegrityCode.PARAMETER_MAP_UNKNOWN_PARAMETER,
            artifact,
            message: `Binding for "${capabilityId}" maps parameter "${parameter}", which that capability does not declare.`,
            details: { capability_id: capabilityId, parameter, platform },
          });
        }

        for (const parameter of Object.keys(binding.transform ?? {})) {
          if (capability.parameterNames.has(parameter)) continue;
          issues.push({
            code: IntegrityCode.TRANSFORM_UNKNOWN_PARAMETER,
            artifact,
            message: `Binding for "${capabilityId}" transforms parameter "${parameter}", which that capability does not declare.`,
            details: { capability_id: capabilityId, parameter, platform },
          });
        }
      }
    }
  }
}

/**
 * The index is a derived artifact, so the only interesting question is whether
 * it still agrees with what it was derived from. Pass A reads the index and
 * nothing else, so a stale row is a description of something the model will not
 * get.
 */
function checkIndex(
  index: RegistryIndex,
  version: string,
  files: readonly CapabilityFile[],
  issues: IntegrityIssue[],
): void {
  const artifact = ARTIFACT_INDEX;

  if (index.version !== version) {
    issues.push({
      code: IntegrityCode.INDEX_VERSION_MISMATCH,
      artifact,
      message: `Index declares version "${index.version}" but was published under "${version}".`,
      details: { declared: index.version, published: version },
    });
  }

  const entriesById = new Map(index.entries.map((entry) => [entry.capability_id, entry]));
  const known = new Set<string>();

  for (const file of files) {
    for (const capability of file.capabilities) {
      known.add(capability.id);
      const entry = entriesById.get(capability.id);
      if (entry === undefined) {
        issues.push({
          code: IntegrityCode.INDEX_ENTRY_MISSING,
          artifact,
          message: `Capability "${capability.id}" has no index entry, so pass A cannot discover it.`,
          details: { capability_id: capability.id },
        });
        continue;
      }

      const stale =
        entry.integration !== file.integration ||
        entry.kind !== capability.kind ||
        entry.display_name !== capability.display_name ||
        entry.description !== capability.description ||
        !sameStrings(entry.aliases, capability.aliases) ||
        !sameStrings(entry.categories, file.categories);

      if (stale) {
        issues.push({
          code: IntegrityCode.INDEX_ENTRY_STALE,
          artifact,
          message: `Index entry for "${capability.id}" disagrees with its capability definition.`,
          details: { capability_id: capability.id },
        });
      }
    }
  }

  for (const entry of index.entries) {
    if (known.has(entry.capability_id)) continue;
    issues.push({
      code: IntegrityCode.INDEX_ENTRY_WITHOUT_CAPABILITY,
      artifact,
      message: `Index entry "${entry.capability_id}" names a capability no file defines.`,
      details: { capability_id: entry.capability_id },
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ARTIFACT_INDEX = "index.json";

function capabilityArtifact(integration: string): string {
  return `capabilities/${integration}.json`;
}

function bindingArtifact(platform: string, integration: string): string {
  return `bindings/${platform}/${integration}.json`;
}

/** Aliases collide on meaning, not on punctuation, so they compare case- and space-insensitively. */
function normalizeAlias(alias: string): string {
  return alias
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, position) => value === b[position]);
}
