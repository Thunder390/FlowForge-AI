/**
 * Reading order is what the mermaid diagram and the setup guide both present
 * nodes in, so its rules are worth pinning separately from either.
 */

import { cloneOnboarding, onboardingExample } from "@flowforge/ffir/fixtures";
import { describe, expect, it } from "vitest";

import { readingOrder } from "./order.js";

function ids(doc: Parameters<typeof readingOrder>[0]): string[] {
  return readingOrder(doc).map((node) => node.id);
}

describe("the walk", () => {
  it("starts at the trigger", () => {
    expect(ids(onboardingExample)[0]).toBe("n_trigger");
  });

  it("follows the graph rather than the document's node array", () => {
    expect(ids(onboardingExample)).toEqual([
      "n_trigger",
      "n_build_email",
      "n_create_account",
      "n_alert_it",
      "n_slack_welcome",
    ]);
  });

  it("returns every node exactly once", () => {
    const order = ids(onboardingExample);
    expect(order).toHaveLength(onboardingExample.nodes.length);
    expect(new Set(order).size).toBe(order.length);
  });

  it("breaks ties on node id, so two parallel branches cannot swap", () => {
    // n_alert_it and n_slack_welcome are both freed by n_create_account.
    const order = ids(onboardingExample);
    expect(order.indexOf("n_alert_it")).toBeLessThan(order.indexOf("n_slack_welcome"));
  });

  it("is unmoved by the order the nodes are written in", () => {
    const shuffled = cloneOnboarding();
    shuffled.nodes = [...shuffled.nodes].reverse();
    expect(ids(shuffled)).toEqual(ids(onboardingExample));
  });

  it("is unmoved by the order the edges are written in", () => {
    const shuffled = cloneOnboarding();
    shuffled.edges = [...shuffled.edges].reverse();
    expect(ids(shuffled)).toEqual(ids(onboardingExample));
  });
});

describe("loops", () => {
  it("terminates on a graph whose edge list is cyclic", () => {
    // A loop's back-edge is a genuine cycle that the graph validator permits by
    // design, so the walk has to exclude it or never finish.
    const doc = cloneOnboarding();
    doc.nodes = [
      doc.nodes[0]!,
      {
        id: "n_loop",
        kind: "loop",
        capability: "core.loop.for_each",
        label: "For each",
        parameters: { items: "{{ n_trigger.employee.id }}", max_iterations: 10 },
      },
      { ...doc.nodes[3]!, id: "n_body", label: "Body" },
    ];
    doc.edges = [
      { id: "e_1", from: "n_trigger", to: "n_loop" },
      { id: "e_2", from: "n_loop", to: "n_body", port: "each" },
      { id: "e_3", from: "n_body", to: "n_loop" },
    ];

    expect(ids(doc)).toEqual(["n_trigger", "n_loop", "n_body"]);
  });
});

describe("edge cases", () => {
  it("appends an unreachable node rather than dropping it", () => {
    // Rule 3 rejects one, so a document through the pipeline cannot have one.
    // Silently omitting a step from the setup guide is how a user ends up with
    // a workflow they cannot make work.
    const doc = cloneOnboarding();
    doc.nodes.push({ ...doc.nodes[3]!, id: "n_orphan", label: "Orphan" });

    expect(ids(doc)).toContain("n_orphan");
    expect(ids(doc)).toHaveLength(doc.nodes.length);
  });

  it("handles a document with one node and no edges", () => {
    const doc = cloneOnboarding();
    doc.nodes = [doc.nodes[0]!];
    doc.edges = [];

    expect(ids(doc)).toEqual(["n_trigger"]);
  });

  it("handles a document with no nodes", () => {
    const doc = cloneOnboarding();
    doc.nodes = [];
    doc.edges = [];

    expect(ids(doc)).toEqual([]);
  });

  it("handles a document with no trigger", () => {
    const doc = cloneOnboarding();
    doc.nodes[0]!.kind = "action";

    expect(ids(doc)).toHaveLength(doc.nodes.length);
  });

  it("ignores an edge naming a node that does not exist", () => {
    const doc = cloneOnboarding();
    doc.edges.push({ id: "e_bogus", from: "n_trigger", to: "n_nowhere" });

    expect(ids(doc)).toEqual(ids(onboardingExample));
  });
});
