import { onboardingExample } from "@flowforge/ffir/fixtures";
import { loadFixtureRegistry } from "@flowforge/registry/fixtures";
import { describe, expect, it } from "vitest";

import { loopDocument, parallelDocument } from "../../__fixtures__/documents.js";
import { compileToGraph } from "../../compile.js";
import type { NormalizedGraph } from "../../normalize.js";
import {
  ERROR_TRACK_OFFSET,
  LAYER_WIDTH,
  ROW_HEIGHT,
  assignLayers,
  layoutGraph,
} from "./layout.js";

const registry = await loadFixtureRegistry();

function graphOf(doc: unknown): NormalizedGraph {
  const result = compileToGraph(doc, registry, "n8n");
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

describe("layers", () => {
  it("puts the trigger at layer zero and each step one further right", () => {
    const layers = assignLayers(graphOf(onboardingExample));
    expect(layers.get("n_trigger")).toBe(0);
    expect(layers.get("n_build_email")).toBe(1);
    expect(layers.get("n_create_account")).toBe(2);
    expect(layers.get("n_slack_welcome")).toBe(3);
    expect(layers.get("n_alert_it")).toBe(3);
  });

  it("uses the longest path, not the shortest", () => {
    // With shortest paths a node reachable in one hop and also at the end of a
    // longer branch would be drawn on top of the branch it is meant to follow.
    const doc = parallelDocument();
    doc.edges.push({ id: "e_3", from: "n_left", to: "n_right" });

    const layers = assignLayers(graphOf(doc));
    expect(layers.get("n_left")).toBe(1);
    expect(layers.get("n_right")).toBe(2);
  });

  it("does not follow a loop's back-edge, which would make the path unbounded", () => {
    const layers = assignLayers(graphOf(loopDocument()));
    expect(layers.get("n_loop")).toBe(1);
    expect(layers.get("n_body")).toBe(2);
  });
});

describe("positions", () => {
  const positions = layoutGraph(graphOf(onboardingExample));

  it("places nodes on the grid", () => {
    for (const position of Object.values(positions)) {
      expect(position.x % LAYER_WIDTH).toBe(0);
      expect(position.y % ROW_HEIGHT).toBe(0);
    }
  });

  it("spaces layers by the layer width", () => {
    expect(positions["n_trigger"]).toEqual({ x: 0, y: 0 });
    expect(positions["n_build_email"]).toEqual({ x: LAYER_WIDTH, y: 0 });
    expect(positions["n_create_account"]).toEqual({ x: 2 * LAYER_WIDTH, y: 0 });
  });

  it("drops an error handler onto its own track", () => {
    const handler = positions["n_alert_it"];
    const sibling = positions["n_slack_welcome"];

    expect(handler?.x).toBe(sibling?.x);
    expect(handler?.y).toBeGreaterThanOrEqual((sibling?.y ?? 0) + ERROR_TRACK_OFFSET);
  });

  it("keeps the main track at the top of its column", () => {
    expect(positions["n_slack_welcome"]?.y).toBe(0);
  });

  it("gives every node a position", () => {
    expect(Object.keys(positions).sort()).toEqual(
      onboardingExample.nodes.map((node) => node.id).sort(),
    );
  });
});

describe("parallel branches", () => {
  const positions = layoutGraph(graphOf(parallelDocument()));

  it("stacks siblings in one column", () => {
    expect(positions["n_left"]?.x).toBe(LAYER_WIDTH);
    expect(positions["n_right"]?.x).toBe(LAYER_WIDTH);
    expect(positions["n_left"]?.y).not.toBe(positions["n_right"]?.y);
  });

  it("orders them by the topological order, which ties on node id", () => {
    expect(positions["n_left"]?.y).toBe(0);
    expect(positions["n_right"]?.y).toBe(ROW_HEIGHT);
  });
});

describe("determinism", () => {
  it("lays out identically on repeated runs", () => {
    expect(layoutGraph(graphOf(onboardingExample))).toEqual(
      layoutGraph(graphOf(onboardingExample)),
    );
  });

  it("does not depend on the order the edges were written in", () => {
    const doc = parallelDocument();
    const reversed = { ...doc, edges: [...doc.edges].reverse() };

    expect(layoutGraph(graphOf(reversed))).toEqual(layoutGraph(graphOf(doc)));
  });
});
