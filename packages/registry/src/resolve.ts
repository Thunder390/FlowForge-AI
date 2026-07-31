/**
 * Capability ID to registry entry.
 *
 * The join key across the whole system arrives here as a string and leaves as
 * something typed. Two functions rather than one, split on whether the caller
 * cares about a platform:
 *
 * `resolve` is what the AI layer and the validator use. It returns the
 * capability, its integration, and its auth definition, and it never touches
 * bindings. That is not a convenience: the AI layer never reading bindings is
 * what keeps it platform-agnostic, and a resolver that handed them over would
 * make the boundary a matter of discipline rather than of types.
 *
 * `resolveForTarget` is what the compiler uses, and it adds the binding plus the
 * three-way status stage 2 of the compile pipeline switches on.
 */

import {
  CORE_INTEGRATION,
  type AuthDefinition,
  type Binding,
  type Capability,
  type IntegrationEntry,
  type Registry,
} from "./types.js";

export interface ResolvedCapability {
  id: string;
  capability: Capability;
  integration: IntegrationEntry;
  /** The auth definition named by `auth_required`. Absent for `core.*`. */
  auth?: AuthDefinition;
}

/**
 * What the compiler learns about a capability on one platform.
 *
 * | Status | Meaning | Compiler action |
 * | --- | --- | --- |
 * | `bound` | The platform implements this. | Proceed normally. |
 * | `unsupported` | Explicit `null`. The platform genuinely cannot. | Degrade to `http.request.send`, warn. |
 * | `missing` | The key is absent. A registry gap. | Degrade, warn, log for the backlog. |
 *
 * The last two produce the same output and are counted differently, which is
 * the point: one is a fact about a platform and the other is a fact about us.
 */
export type BindingStatus = "bound" | "unsupported" | "missing";

export interface ResolvedTargetCapability extends ResolvedCapability {
  target: string;
  status: BindingStatus;
  /** Present only when `status` is `"bound"`. */
  binding?: Binding;
}

/** Resolves a capability ID. Returns `undefined` for an ID the registry does not contain. */
export function resolve(
  registry: Registry,
  capabilityId: string,
): ResolvedCapability | undefined {
  const capability = registry.capabilities.get(capabilityId);
  if (capability === undefined) return undefined;

  const integration = registry.integrations.get(integrationSegment(capabilityId));
  if (integration === undefined) return undefined;

  const auth = resolveAuth(registry, capabilityId);
  return {
    id: capabilityId,
    capability,
    integration,
    ...(auth === undefined ? {} : { auth }),
  };
}

/** Resolves a capability together with its binding for one target. */
export function resolveForTarget(
  registry: Registry,
  capabilityId: string,
  target: string,
): ResolvedTargetCapability | undefined {
  const resolved = resolve(registry, capabilityId);
  if (resolved === undefined) return undefined;

  const { status, binding } = resolveBinding(registry, capabilityId, target);
  return {
    ...resolved,
    target,
    status,
    ...(binding === undefined ? {} : { binding }),
  };
}

/**
 * Looks up one binding, distinguishing "cannot" from "not yet".
 *
 * A target the registry has never heard of reports `missing` rather than
 * throwing, because that is the same situation as an unmapped capability from
 * the compiler's point of view and it should degrade the same way.
 */
export function resolveBinding(
  registry: Registry,
  capabilityId: string,
  target: string,
): { status: BindingStatus; binding?: Binding } {
  const forTarget = registry.bindings.get(target);
  if (forTarget === undefined || !forTarget.has(capabilityId)) {
    return { status: "missing" };
  }

  const binding = forTarget.get(capabilityId);
  if (binding === null || binding === undefined) return { status: "unsupported" };
  return { status: "bound", binding };
}

/**
 * The auth definition a capability needs.
 *
 * Resolved through the integration rather than stored on the capability,
 * because several capabilities share one credential and the setup guide asks
 * for it once.
 */
export function resolveAuth(
  registry: Registry,
  capabilityId: string,
): AuthDefinition | undefined {
  const capability = registry.capabilities.get(capabilityId);
  if (capability?.auth_required === undefined) return undefined;

  const integration = registry.integrations.get(integrationSegment(capabilityId));
  return integration?.auth.find((auth) => auth.id === capability.auth_required);
}

/**
 * Every capability an integration offers, sorted by ID.
 *
 * Rung 2 of the unknown-capability ladder hands this list to the model when the
 * integration segment resolves but the resource or operation does not. That is
 * the common case and it repairs reliably.
 */
export function capabilitiesOfIntegration(
  registry: Registry,
  integration: string,
): readonly Capability[] {
  return registry.integrations.get(integration)?.capabilities ?? [];
}

export function integrationOf(
  registry: Registry,
  integration: string,
): IntegrationEntry | undefined {
  return registry.integrations.get(integration);
}

/** True for the platform-agnostic primitives every target must implement. */
export function isCoreCapability(capabilityId: string): boolean {
  return integrationSegment(capabilityId) === CORE_INTEGRATION;
}

function integrationSegment(capabilityId: string): string {
  const dot = capabilityId.indexOf(".");
  return dot === -1 ? capabilityId : capabilityId.slice(0, dot);
}
