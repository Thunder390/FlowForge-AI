/**
 * FFIR plus the registry to the integrations list the UI shows.
 *
 * Structured data rather than text, because this one is consumed by a component
 * and not read by a person. It answers "what does this workflow touch, and what
 * will I have to connect", which is the question a user asks before they decide
 * whether a generated workflow is worth importing at all.
 *
 * The two reserved namespaces are reported like any other. `http` in the list
 * is meaningful, not noise: it means a step is a raw HTTP call, either because
 * the workflow asked for one or because a capability degraded to it, and that
 * is precisely what a user wants to see before importing.
 */

import type { FFIRDocument } from "@flowforge/ffir";
import {
  CORE_INTEGRATION,
  resolve,
  type AuthDefinition,
  type Registry,
} from "@flowforge/registry";

export interface IntegrationUsage {
  /** The integration segment of the capability id. */
  integration: string;
  displayName: string;
  description?: string;
  docsUrl?: string;
  categories: string[];
  /** Capability ids used, sorted. */
  capabilities: string[];
  /** Labels of the nodes using this integration, in reading order of the node array. */
  nodeLabels: string[];
  /** True for `core`, the platform-agnostic primitives that need no account. */
  builtIn: boolean;
  /** Absent when nothing here needs credentials. */
  auth?: {
    type: AuthDefinition["type"];
    label: string;
    scopes: string[];
  };
  /** True when the registry does not know this integration. */
  unknown: boolean;
}

export interface IntegrationsList {
  /** Everything the workflow touches, sorted by integration id. */
  integrations: IntegrationUsage[];
  /** The subset the user has to connect an account for. */
  requiringAuth: IntegrationUsage[];
}

export function toIntegrations(doc: FFIRDocument, registry: Registry): IntegrationsList {
  const byIntegration = new Map<string, IntegrationUsage>();

  for (const node of doc.nodes) {
    const id = integrationSegment(node.capability);
    const entry = byIntegration.get(id) ?? blank(id, registry);

    if (!entry.capabilities.includes(node.capability)) {
      entry.capabilities.push(node.capability);
    }
    entry.nodeLabels.push(node.label);

    const resolved = resolve(registry, node.capability);
    for (const scope of resolved?.capability.required_scopes ?? []) {
      if (entry.auth !== undefined && !entry.auth.scopes.includes(scope)) {
        entry.auth.scopes.push(scope);
      }
    }

    byIntegration.set(id, entry);
  }

  const integrations = [...byIntegration.values()]
    .map((entry) => ({
      ...entry,
      capabilities: [...entry.capabilities].sort(compare),
      ...(entry.auth === undefined
        ? {}
        : { auth: { ...entry.auth, scopes: [...entry.auth.scopes].sort(compare) } }),
    }))
    .sort((a, b) => compare(a.integration, b.integration));

  return {
    integrations,
    requiringAuth: integrations.filter((entry) => entry.auth !== undefined),
  };
}

/**
 * A usage entry before any node has been folded into it.
 *
 * The auth block is decided here, from the integration's default auth
 * definition, because it is a property of the integration rather than of any
 * one node. An integration the registry has never heard of is marked `unknown`
 * rather than dropped: validation stage 2 rejects such a document, so seeing one
 * means the UI is showing something that did not go through the pipeline, and
 * hiding it would make that invisible.
 */
function blank(integration: string, registry: Registry): IntegrationUsage {
  const entry = registry.integrations.get(integration);

  if (entry === undefined) {
    return {
      integration,
      displayName: integration,
      categories: [],
      capabilities: [],
      nodeLabels: [],
      builtIn: false,
      unknown: true,
    };
  }

  const auth = entry.auth.find((candidate) => candidate.default) ?? entry.auth[0];

  return {
    integration,
    displayName: entry.display_name,
    description: entry.description,
    ...(entry.docs_url === undefined ? {} : { docsUrl: entry.docs_url }),
    categories: [...entry.categories],
    capabilities: [],
    nodeLabels: [],
    builtIn: integration === CORE_INTEGRATION,
    ...(auth === undefined
      ? {}
      : { auth: { type: auth.type, label: auth.label, scopes: [] } }),
    unknown: false,
  };
}

function integrationSegment(capability: string): string {
  const dot = capability.indexOf(".");
  return dot === -1 ? capability : capability.slice(0, dot);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
