/**
 * What the hand-written fixture build has to be true of.
 *
 * The registry is the highest-integrity data in the system: if it is wrong,
 * everything downstream is confidently wrong. These are the curation rules that
 * hold whatever the fixtures happen to contain today, so that adding the
 * seventh integration cannot quietly drop a property the later milestones were
 * written against.
 */

import { NODE_KINDS, type FFIRDocument } from "@flowforge/ffir";
import { onboardingExample } from "@flowforge/ffir/fixtures";
import { describe, expect, it } from "vitest";

import {
  FIXTURE_INTEGRATIONS,
  FIXTURE_REGISTRY_VERSION,
  loadFixtureRegistry,
} from "./__fixtures__/index.js";
import { resolve, resolveBinding, resolveForTarget } from "./resolve.js";
import {
  CAPABILITY_ID_PATTERN,
  CORE_CAPABILITIES,
  DEFAULT_TARGET,
  HTTP_FALLBACK_CAPABILITY,
  type Capability,
  type ParameterDefinition,
} from "./types.js";

const registry = await loadFixtureRegistry();
const capabilities = [...registry.capabilities.values()];
const worked: FFIRDocument = onboardingExample;

/** Walks a parameter and everything nested inside it. */
function everyParameter(parameter: ParameterDefinition): ParameterDefinition[] {
  return [
    parameter,
    ...(parameter.items === undefined ? [] : everyParameter(parameter.items)),
    ...Object.values(parameter.fields ?? {}).flatMap(everyParameter),
  ];
}

function parametersOf(capability: Capability): [string, ParameterDefinition][] {
  return Object.entries(capability.parameters).flatMap(([name, parameter]) =>
    everyParameter(parameter).map(
      (nested) => [name, nested] as [string, ParameterDefinition],
    ),
  );
}

describe("coverage", () => {
  it("ships the six integrations", () => {
    expect([...registry.integrations.keys()]).toEqual([...FIXTURE_INTEGRATIONS]);
  });

  it("defines every core primitive FFIR depends on", () => {
    for (const id of CORE_CAPABILITIES) {
      expect(registry.capabilities.has(id)).toBe(true);
    }
  });

  it("defines the universal escape hatch", () => {
    expect(registry.capabilities.has(HTTP_FALLBACK_CAPABILITY)).toBe(true);
  });

  it("covers every node kind a capability can carry", () => {
    // `error_handler` is the one kind no capability declares: it lowers exactly
    // like an action, and a node is an error handler because of the edges that
    // reach it rather than because of what it does. Every other kind needs a
    // capability behind it or the compiler cannot have a case per kind.
    const covered = new Set(capabilities.map((capability) => capability.kind));
    const expected = NODE_KINDS.filter((kind) => kind !== "error_handler");
    expect([...covered].sort()).toEqual([...expected].sort());
  });

  it("binds every capability to the default target", () => {
    for (const id of registry.capabilities.keys()) {
      expect(resolveBinding(registry, id, DEFAULT_TARGET).status).toBe("bound");
    }
  });
});

describe("curation rules", () => {
  it.each(capabilities.map((capability) => [capability.id, capability] as const))(
    "%s is well curated",
    (_id, capability) => {
      expect(CAPABILITY_ID_PATTERN.test(capability.id)).toBe(true);
      expect(capability.display_name.trim()).not.toBe("");
      expect(capability.description.trim()).not.toBe("");
      // Aliases are the retrieval vocabulary. A capability with none can be
      // named exactly or not at all, which is not how anybody types.
      expect(capability.aliases.length).toBeGreaterThanOrEqual(3);
      expect(new Set(capability.aliases).size).toBe(capability.aliases.length);
    },
  );

  it("gives every parameter, at every depth, a description written for the model", () => {
    for (const capability of capabilities) {
      for (const [name, parameter] of parametersOf(capability)) {
        expect(
          parameter.description.trim(),
          `${capability.id}.${name} has an empty description`,
        ).not.toBe("");
      }
    }
  });

  it("gives every enum a closed list of values", () => {
    for (const capability of capabilities) {
      for (const [name, parameter] of parametersOf(capability)) {
        if (parameter.type !== "enum") continue;
        expect(parameter.values, `${capability.id}.${name}`).toBeDefined();
        expect(parameter.values?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it("never marks a parameter both required and defaulted", () => {
    // A default is what the compiler applies when the parameter is absent, so a
    // required parameter with one states two contradictory things about what
    // happens when the model omits it.
    for (const capability of capabilities) {
      for (const [name, parameter] of parametersOf(capability)) {
        if (!parameter.required) continue;
        expect(parameter.default, `${capability.id}.${name}`).toBeUndefined();
      }
    }
  });

  it("declares auth for every capability that reaches an external service", () => {
    for (const capability of capabilities) {
      const integration = capability.id.slice(0, capability.id.indexOf("."));
      if (integration === "core" || integration === "http") {
        expect(capability.auth_required, capability.id).toBeUndefined();
        continue;
      }
      expect(capability.auth_required, capability.id).toBeDefined();
      expect(resolve(registry, capability.id)?.auth, capability.id).toBeDefined();
    }
  });

  it("stamps every artifact with the same source, and marks it hand-written", () => {
    for (const integration of registry.integrations.values()) {
      expect(integration.source).toEqual({
        generated_from: "n8n-nodes-base@1.62.0",
        generated_at: "2026-07-31T00:00:00Z",
        overlay_version: 3,
        hand_written: true,
      });
    }
  });

  it("publishes under a version string of the documented shape", () => {
    expect(FIXTURE_REGISTRY_VERSION).toMatch(/^n8n@\d+\.\d+\.\d+\+overlay\.\d+$/);
    expect(registry.version).toBe(FIXTURE_REGISTRY_VERSION);
    expect(registry.index.version).toBe(FIXTURE_REGISTRY_VERSION);
  });
});

describe("the worked example", () => {
  it("pins the version this build publishes under", () => {
    expect(worked.metadata?.registry_version).toBe(FIXTURE_REGISTRY_VERSION);
  });

  it("resolves every capability it uses, and binds each to n8n", () => {
    const used = [...new Set(worked.nodes.map((node) => node.capability))].sort();
    expect(used).toEqual([
      "bamboohr.employee.created",
      "core.transform.map",
      "google_workspace.user.create",
      "slack.message.send",
    ]);

    for (const capability of used) {
      const resolved = resolveForTarget(registry, capability, DEFAULT_TARGET);
      expect(resolved, capability).toBeDefined();
      expect(resolved?.status, capability).toBe("bound");
    }
  });

  it("uses only parameter names the registry declares", () => {
    // Rule 13 in advance. It is enforced properly in M5; asserting it here
    // means the fixture registry and the fixture document cannot drift apart
    // before then.
    for (const node of worked.nodes) {
      const declared = Object.keys(resolve(registry, node.capability)?.capability.parameters ?? {});
      for (const name of Object.keys(node.parameters)) {
        expect(declared, `${node.id} (${node.capability})`).toContain(name);
      }
    }
  });

  it("declares credentials the registry can actually satisfy", () => {
    for (const credential of worked.credentials) {
      const integration = registry.integrations.get(credential.capability_scope);
      expect(integration, credential.capability_scope).toBeDefined();

      const auth = integration?.auth.find((entry) => entry.type === credential.auth_type);
      expect(auth, `${credential.id} wants ${credential.auth_type}`).toBeDefined();

      for (const scope of credential.required_scopes ?? []) {
        expect(auth?.scopes_available ?? [], `${credential.id}`).toContain(scope);
      }
    }
  });

  it("references only output fields the registry declares", () => {
    // The trigger's employee fields are what the onboarding expressions read.
    // If the registry stopped declaring them, pass B would be inventing names
    // that happen to be right, which is the failure this architecture exists to
    // prevent.
    const employee = resolve(registry, "bamboohr.employee.created")?.capability.output?.[
      "employee"
    ];
    const fields = Object.keys(employee?.fields ?? {});
    expect(fields).toContain("first_name");
    expect(fields).toContain("last_name");

    const referenced = JSON.stringify(worked.nodes);
    expect(referenced).toContain("n_trigger.employee.first_name");
  });
});
