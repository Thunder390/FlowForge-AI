/**
 * Reading order for a workflow.
 *
 * The mermaid diagram and the setup guide both need to present nodes in the
 * order a person would walk them: the trigger first, then what it leads to.
 * FFIR's `nodes` array is explicitly unordered, so document order would put the
 * last step first whenever the model happened to emit it that way.
 *
 * ## Why this is not the compiler's sort
 *
 * It is the same rule, deliberately: a topological walk from the trigger with
 * ties broken on node id, and loop back-edges excluded so the walk terminates.
 * It is not the same *code*, because `renderers` must not depend on
 * `compiler` — they are siblings, and the roadmap's dependency table gives this
 * package `ffir` and `registry` only.
 *
 * That duplication is affordable because of what it costs when the two drift:
 * nothing but the order paragraphs appear in. The compiler's sort decides which
 * node lands at which canvas position and which connection index an edge takes,
 * so a change there is a behavioural change. A change here reorders a numbered
 * list in a Markdown document. Sharing the code would mean either a dependency
 * the architecture forbids or a fifth package to hold twenty lines.
 *
 * Both walks read the graph through `ffir`'s own model, so at least the
 * question "what is the graph" has one answer.
 */

import {
  buildGraphModel,
  type FFIRDocument,
  type GraphModel,
  type Node,
} from "@flowforge/ffir";

/**
 * Nodes in reading order.
 *
 * A node the trigger cannot reach is appended in id order rather than dropped.
 * Validation rule 3 rejects an unreachable node, so a document that has been
 * through the pipeline cannot contain one, but a renderer is the wrong place to
 * discover that: silently omitting a step from the setup guide is how a user
 * ends up with a workflow they cannot make work.
 */
export function readingOrder(doc: FFIRDocument): Node[] {
  const model = buildGraphModel(doc);
  const forward = model.edges.filter((entry) => !model.backEdges.has(entry.index));

  const indegree = new Map<string, number>();
  for (const node of doc.nodes) indegree.set(node.id, 0);
  for (const entry of forward) {
    indegree.set(entry.edge.to, (indegree.get(entry.edge.to) ?? 0) + 1);
  }

  const successors = new Map<string, string[]>();
  for (const entry of forward) {
    const list = successors.get(entry.edge.from);
    if (list === undefined) successors.set(entry.edge.from, [entry.edge.to]);
    else list.push(entry.edge.to);
  }

  const ready = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
    .sort(compare);

  const trigger = doc.nodes.find((node) => node.kind === "trigger");
  if (trigger !== undefined && ready.includes(trigger.id)) {
    ready.splice(ready.indexOf(trigger.id), 1);
    ready.unshift(trigger.id);
  }

  const emitted = new Set<string>();
  const ordered: string[] = [];

  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined || emitted.has(id)) continue;
    emitted.add(id);
    ordered.push(id);

    const freed: string[] = [];
    for (const successor of successors.get(id) ?? []) {
      const remaining = (indegree.get(successor) ?? 0) - 1;
      indegree.set(successor, remaining);
      if (remaining === 0 && !emitted.has(successor)) freed.push(successor);
    }

    for (const candidate of freed.sort(compare)) {
      const at = ready.findIndex((existing) => compare(candidate, existing) < 0);
      if (at === -1) ready.push(candidate);
      else ready.splice(at, 0, candidate);
    }
  }

  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const stranded = doc.nodes
    .filter((node) => !emitted.has(node.id))
    .sort((a, b) => compare(a.id, b.id));

  return [
    ...ordered.map((id) => byId.get(id)).filter((node): node is Node => node !== undefined),
    ...stranded,
  ];
}

/** The graph view, exposed so a renderer does not build it twice. */
export function graphOf(doc: FFIRDocument): GraphModel {
  return buildGraphModel(doc);
}

/** Codepoint order. `localeCompare` answers differently on different machines. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
