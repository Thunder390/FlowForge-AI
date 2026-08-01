/**
 * Document variants the worked example does not cover.
 *
 * Built by mutating a clone of the BambooHR onboarding example rather than
 * assembled from nothing, because every one of them has to survive all five
 * validation stages before the compiler will look at it, and hand-rolling a
 * document that satisfies fifteen graph rules plus the registry's parameter
 * schemas is how fixtures end up quietly testing the validator instead of the
 * thing they were written for. A test that needs an *invalid* document builds
 * it by breaking a valid one.
 */

import type { Edge, FFIRDocument, Node } from "@flowforge/ffir";
import { cloneOnboarding } from "@flowforge/ffir/fixtures";

export function nodeOf(doc: FFIRDocument, id: string): Node {
  const node = doc.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`no node ${id} in the fixture`);
  return node;
}

export function edgeOf(doc: FFIRDocument, id: string): Edge {
  const edge = doc.edges.find((candidate) => candidate.id === id);
  if (edge === undefined) throw new Error(`no edge ${id} in the fixture`);
  return edge;
}

/**
 * A loop, with the back-edge that makes the edge list cyclic.
 *
 * The trigger feeds a loop; the loop's `each` port runs one Slack message per
 * item and that node wires back into the loop; the `done` port continues after
 * iteration. This is the shape the topological sort has to survive, because the
 * back-edge is a genuine cycle that the graph validator permits by design.
 */
export function loopDocument(): FFIRDocument {
  const doc = cloneOnboarding();

  doc.nodes = [
    nodeOf(doc, "n_trigger"),
    {
      id: "n_loop",
      kind: "loop",
      capability: "core.loop.for_each",
      label: "For each new hire",
      parameters: {
        items: "{{ n_trigger.employee.first_name }}",
        max_iterations: 50,
      },
    },
    {
      id: "n_body",
      kind: "action",
      capability: "slack.message.send",
      label: "Greet each hire",
      parameters: { channel: "#general", text: "Welcome aboard" },
      credential: "cred_slack",
    },
    {
      id: "n_after",
      kind: "action",
      capability: "slack.message.send",
      label: "Announce the batch is done",
      parameters: { channel: "#general", text: "All hires processed" },
      credential: "cred_slack",
    },
  ];

  doc.edges = [
    { id: "e_1", from: "n_trigger", to: "n_loop" },
    { id: "e_2", from: "n_loop", to: "n_body", port: "each" },
    { id: "e_3", from: "n_body", to: "n_loop" },
    { id: "e_4", from: "n_loop", to: "n_after", port: "done" },
  ];

  doc.credentials = doc.credentials.filter((credential) =>
    ["cred_bamboohr", "cred_slack"].includes(credential.id),
  );
  doc.variables = [];

  return doc;
}

/**
 * One node fanning out to two successors on the same port.
 *
 * Both Slack messages run off the trigger, which is what a target declaring
 * `parallelBranches: false` has to reject.
 */
export function parallelDocument(): FFIRDocument {
  const doc = cloneOnboarding();

  doc.nodes = [
    nodeOf(doc, "n_trigger"),
    {
      id: "n_left",
      kind: "action",
      capability: "slack.message.send",
      label: "Tell the team",
      parameters: { channel: "#general", text: "A new hire started" },
      credential: "cred_slack",
    },
    {
      id: "n_right",
      kind: "action",
      capability: "slack.message.send",
      label: "Tell IT",
      parameters: { channel: "#it-alerts", text: "Provision a laptop" },
      credential: "cred_slack",
    },
  ];

  doc.edges = [
    { id: "e_1", from: "n_trigger", to: "n_left" },
    { id: "e_2", from: "n_trigger", to: "n_right" },
  ];

  doc.credentials = doc.credentials.filter((credential) =>
    ["cred_bamboohr", "cred_slack"].includes(credential.id),
  );
  doc.variables = [];

  return doc;
}

/**
 * Three nodes sharing one label, plus a fourth already holding the suffix the
 * de-duplicator would reach for first.
 */
export function duplicateLabelDocument(): FFIRDocument {
  const doc = parallelDocument();

  nodeOf(doc, "n_left").label = "Notify";
  nodeOf(doc, "n_right").label = "Notify";

  doc.nodes.push({
    id: "n_third",
    kind: "action",
    capability: "slack.message.send",
    label: "Notify 2",
    parameters: { channel: "#general", text: "And again" },
    credential: "cred_slack",
  });
  doc.nodes.push({
    id: "n_fourth",
    kind: "action",
    capability: "slack.message.send",
    label: "Notify",
    parameters: { channel: "#general", text: "Once more" },
    credential: "cred_slack",
  });

  doc.edges.push({ id: "e_3", from: "n_left", to: "n_third" });
  doc.edges.push({ id: "e_4", from: "n_third", to: "n_fourth" });

  return doc;
}
