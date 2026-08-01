/**
 * Stage 5 makes exactly two promises: key order is fixed, and the same IR
 * always produces the same bytes. Both are what golden files rest on.
 */

import { onboardingExample } from "@flowforge/ffir/fixtures";
import { loadFixtureRegistry } from "@flowforge/registry/fixtures";
import { describe, expect, it } from "vitest";

import { compileToGraph } from "../../compile.js";
import type { CompileContext } from "../../target.js";
import { emitN8n } from "./emit.js";
import { N8N_TARGET_KEY, type N8nIR } from "./ir.js";
import { lowerToN8n } from "./lower.js";

const registry = await loadFixtureRegistry();

function irOf(doc: unknown): N8nIR {
  const graph = compileToGraph(doc, registry, N8N_TARGET_KEY);
  if (!graph.ok) throw new Error("fixture does not compile");

  const ctx: CompileContext = {
    doc: graph.value.doc,
    registry,
    target: N8N_TARGET_KEY,
    warn: () => undefined,
  };
  return lowerToN8n(graph.value, ctx);
}

const ir = irOf(onboardingExample);
const content = emitN8n(ir).content;

describe("the file", () => {
  it("is stamped for n8n", () => {
    expect(emitN8n(ir).target).toBe("n8n");
  });

  it("is indented two spaces and ends with a newline", () => {
    expect(content.endsWith("}\n")).toBe(true);
    expect(content).toContain('\n  "name"');
  });

  it("round-trips", () => {
    expect(`${JSON.stringify(JSON.parse(content), null, 2)}\n`).toBe(content);
  });
});

describe("key order", () => {
  it("writes the workflow's top-level keys in a fixed order", () => {
    expect(Object.keys(JSON.parse(content) as object)).toEqual([
      "name",
      "nodes",
      "connections",
      "settings",
      "pinData",
      "meta",
    ]);
  });

  it("writes a node's keys in the order n8n's own exports use", () => {
    const parsed = JSON.parse(content) as { nodes: object[] };
    expect(Object.keys(parsed.nodes[0] as object)).toEqual([
      "id",
      "name",
      "type",
      "typeVersion",
      "position",
      "parameters",
    ]);
  });

  it("appends the optional node fields after the required ones", () => {
    const parsed = JSON.parse(content) as { nodes: { name: string }[] };
    const account = parsed.nodes.find(
      (node) => node.name === "Create Google Workspace account",
    );
    expect(Object.keys(account as object)).toEqual([
      "id",
      "name",
      "type",
      "typeVersion",
      "position",
      "parameters",
      "credentials",
      "onError",
      "retryOnFail",
      "maxTries",
      "waitBetweenTries",
    ]);
  });

  it("omits an optional field rather than writing it as null", () => {
    expect(content).not.toContain('"onError": null');
    expect(content).not.toContain('"credentials": null');
  });

  it("writes main before error on a node that has both", () => {
    const connections = (JSON.parse(content) as { connections: Record<string, object> })
      .connections;
    expect(Object.keys(connections["Create Google Workspace account"] as object)).toEqual([
      "main",
      "error",
    ]);
  });

  it("does not depend on the order stage 4 assigned the output keys", () => {
    // Rebuilding the object here rather than emitting whatever stage 4 built is
    // what makes this true, so it is worth pinning.
    const shuffled: N8nIR = {
      ...ir,
      workflow: {
        ...ir.workflow,
        connections: Object.fromEntries(
          Object.entries(ir.workflow.connections).map(([name, outputs]) => [
            name,
            Object.fromEntries(Object.entries(outputs).reverse()),
          ]),
        ),
      },
    };

    expect(emitN8n(shuffled).content).toBe(content);
  });
});

describe("determinism", () => {
  it("emits the same bytes from the same IR", () => {
    expect(emitN8n(ir).content).toBe(content);
  });

  it("emits the same bytes from a freshly lowered IR", () => {
    expect(emitN8n(irOf(onboardingExample)).content).toBe(content);
  });

  it("contains no timestamp", () => {
    expect(content).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
