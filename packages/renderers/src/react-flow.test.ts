import type { FFIRDocument } from "@flowforge/ffir";
import { cloneOnboarding, onboardingExample } from "@flowforge/ffir/fixtures";
import { describe, expect, it } from "vitest";

import { PORT_COLORS } from "./mermaid.js";
import { hasLayout, toReactFlow, type CanvasPosition } from "./react-flow.js";

/**
 * The positions the n8n target computes for the worked example.
 *
 * Transcribed rather than imported, because `renderers` must not depend on
 * `compiler`. That the algorithm puts nodes on the grid is proven where the
 * algorithm lives, in the compiler's `layout.test.ts`; what is proven here is
 * that this renderer places nodes at whatever positions it is handed and
 * invents none of its own.
 */
const LAYOUT: Record<string, CanvasPosition> = {
  n_trigger: { x: 0, y: 0 },
  n_build_email: { x: 220, y: 0 },
  n_create_account: { x: 440, y: 0 },
  n_slack_welcome: { x: 660, y: 0 },
  n_alert_it: { x: 660, y: 320 },
};

function laidOut(): FFIRDocument {
  const doc = cloneOnboarding();
  doc.metadata = { ...doc.metadata, layout: LAYOUT };
  return doc;
}

const canvas = toReactFlow(laidOut());

describe("nodes", () => {
  it("emits one per FFIR node, in document order", () => {
    expect(canvas.nodes.map((node) => node.id)).toEqual(
      onboardingExample.nodes.map((node) => node.id),
    );
  });

  it("types each node by its FFIR kind, so the canvas can pick a card", () => {
    expect(canvas.nodes.map((node) => node.type)).toEqual([
      "trigger",
      "transform",
      "action",
      "action",
      "error_handler",
    ]);
  });

  it("places nodes at the positions it was given", () => {
    for (const node of canvas.nodes) {
      expect(node.position, node.id).toEqual(LAYOUT[node.id]);
    }
  });

  it("puts those positions on the design system's grid", () => {
    for (const node of canvas.nodes) {
      expect(node.position.x % 220, node.id).toBe(0);
      expect(node.position.y % 160, node.id).toBe(0);
    }
  });

  it("carries what a card renders", () => {
    expect(canvas.nodes[0]?.data).toMatchObject({
      label: "New employee in BambooHR",
      kind: "trigger",
      capability: "bamboohr.employee.created",
      integration: "bamboohr",
      credential: "cred_bamboohr",
    });
  });

  it("omits notes and credential when the node has none", () => {
    const transform = canvas.nodes.find((node) => node.id === "n_build_email");
    expect(transform?.data).not.toHaveProperty("credential");
    expect(transform?.data).not.toHaveProperty("notes");
  });
});

describe("layout", () => {
  it("reads metadata.layout by default", () => {
    expect(toReactFlow(laidOut()).missingPositions).toEqual([]);
  });

  it("prefers an explicit layout over the recorded one", () => {
    const override = { ...LAYOUT, n_trigger: { x: 999, y: 999 } };
    const positioned = toReactFlow(laidOut(), { layout: override });

    expect(positioned.nodes[0]?.position).toEqual({ x: 999, y: 999 });
  });

  it("reports nodes with no position rather than inventing one", () => {
    // Non-empty means the document has not been compiled. The canvas should say
    // so rather than draw everything on top of itself at the origin.
    const partial = toReactFlow(onboardingExample, {
      layout: { n_trigger: { x: 0, y: 0 } },
    });

    expect(partial.missingPositions).toEqual([
      "n_build_email",
      "n_create_account",
      "n_slack_welcome",
      "n_alert_it",
    ]);
  });

  it("reports every node when there is no layout at all", () => {
    const none = toReactFlow(onboardingExample);
    expect(none.missingPositions).toHaveLength(onboardingExample.nodes.length);
    expect(none.nodes.every((node) => node.position.x === 0)).toBe(true);
  });

  it("answers whether a document is ready to draw", () => {
    expect(hasLayout(laidOut())).toBe(true);
    expect(hasLayout(onboardingExample)).toBe(false);
  });
});

describe("edges", () => {
  it("emits one per well-formed FFIR edge", () => {
    expect(canvas.edges.map((edge) => edge.id)).toEqual(
      onboardingExample.edges.map((edge) => edge.id),
    );
  });

  it("carries the port as a source handle, so a node picks the right output", () => {
    const error = canvas.edges.find((edge) => edge.id === "e_4");
    expect(error).toMatchObject({
      source: "n_create_account",
      target: "n_alert_it",
      sourceHandle: "error",
    });
  });

  it("colours edges the same way the mermaid diagram does", () => {
    // Two views of one workflow that colour the same edge differently is a
    // small thing that makes a user distrust both.
    expect(canvas.edges[0]?.style.stroke).toBe(PORT_COLORS["main"]);
    expect(canvas.edges[3]?.style.stroke).toBe(PORT_COLORS["error"]);
  });

  it("animates the error path and nothing else", () => {
    expect(canvas.edges.filter((edge) => edge.animated).map((edge) => edge.id)).toEqual([
      "e_4",
    ]);
  });

  it("labels a non-default port and leaves main unlabelled", () => {
    expect(canvas.edges[0]?.label).toBeUndefined();
    expect(canvas.edges[3]?.label).toBe("error");
  });

  it("carries the condition through for the edge inspector", () => {
    const doc = laidOut();
    doc.edges[2]!.port = "true";
    doc.edges[2]!.condition = {
      left: "{{ n_trigger.employee.department }}",
      operator: "equals",
      right: "Engineering",
    };

    const edge = toReactFlow(doc).edges.find((candidate) => candidate.id === "e_3");
    expect(edge?.data.condition).toEqual(doc.edges[2]!.condition);
    expect(edge?.label).toBe("true");
  });

  it("drops an edge naming a node that does not exist", () => {
    // React Flow throws on an edge with no endpoint rather than skipping it, so
    // handing one over would blank the canvas.
    const doc = laidOut();
    doc.edges.push({ id: "e_bogus", from: "n_trigger", to: "n_nowhere" });

    expect(toReactFlow(doc).edges.map((edge) => edge.id)).not.toContain("e_bogus");
  });
});

describe("warnings", () => {
  it("attaches a warning to its node for the badge", () => {
    const doc = laidOut();
    doc.metadata = {
      ...doc.metadata,
      warnings: [
        {
          code: "capability_degraded",
          node_id: "n_slack_welcome",
          message: "Exported as an HTTP request.",
        },
      ],
    };

    const positioned = toReactFlow(doc);
    expect(positioned.nodes.find((node) => node.id === "n_slack_welcome")?.data.warnings).toEqual(
      ["Exported as an HTTP request."],
    );
    expect(positioned.nodes.find((node) => node.id === "n_trigger")?.data.warnings).toEqual([]);
  });

  it("ignores a warning that names no node", () => {
    const doc = laidOut();
    doc.metadata = {
      ...doc.metadata,
      warnings: [{ code: "policy_unsupported", message: "Retries are approximate." }],
    };

    expect(toReactFlow(doc).nodes.every((node) => node.data.warnings.length === 0)).toBe(true);
  });
});

describe("determinism", () => {
  it("produces the same canvas on repeated calls", () => {
    expect(toReactFlow(laidOut())).toEqual(canvas);
  });

  it("does not mutate the document", () => {
    const before = structuredClone(onboardingExample);
    toReactFlow(onboardingExample);
    expect(onboardingExample).toEqual(before);
  });
});
