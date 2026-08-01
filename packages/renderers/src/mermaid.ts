/**
 * FFIR to mermaid `flowchart TD` source.
 *
 * A pure function of FFIR, like every renderer here. This is the payoff from
 * the decision that Claude emits FFIR and nothing else: the diagram is derived
 * rather than generated, so it cannot disagree with the workflow it depicts and
 * it costs no model call.
 *
 * ## Shapes
 *
 * COMPILER_ARCHITECTURE names three: trigger is a stadium, branch is a rhombus,
 * action is a rectangle. The other six are chosen here, following the same
 * flowchart conventions the named three already follow, so that a reader who
 * knows what a rhombus means can guess the rest.
 *
 * ## Colours
 *
 * Edges are coloured by port. The palette lives here rather than being imported
 * because the design tokens it should come from are `packages/ui`, which
 * PROJECT_STRUCTURE creates in M14. When they exist these constants should move
 * there; until then a renderer that invented colours silently would be worse
 * than one that says so.
 */

import { DEFAULT_PORT, ERROR_PORT, portOf, type Edge, type FFIRDocument, type Node, type NodeKind } from "@flowforge/ffir";

import { graphOf, readingOrder } from "./order.js";

/**
 * Mermaid node shapes, as the delimiters that wrap a label.
 *
 * Three are specified by the architecture. The rest follow the same
 * conventional vocabulary: a parallelogram is data, a subroutine box is a
 * repeated block, a circle is a point in time.
 */
export const NODE_SHAPES: Record<NodeKind, { open: string; close: string }> = {
  trigger: { open: "([", close: "])" },
  action: { open: "[", close: "]" },
  branch: { open: "{", close: "}" },
  transform: { open: "[/", close: "/]" },
  merge: { open: "[\\", close: "/]" },
  loop: { open: "[[", close: "]]" },
  ai: { open: "{{", close: "}}" },
  wait: { open: "((", close: "))" },
  error_handler: { open: ">", close: "]" },
};

/**
 * Edge colour by port.
 *
 * `true` and `false` read as go and stop, `error` is the same red as `false`
 * deliberately: both are the unhappy path, and giving them different colours
 * would imply a distinction the graph does not make. A named switch case gets
 * the branch colour, since it is the same decision with more than two answers.
 */
export const PORT_COLORS: Record<string, string> = {
  main: "#64748b",
  true: "#16a34a",
  false: "#dc2626",
  error: "#dc2626",
  each: "#7c3aed",
  done: "#0891b2",
};

/** Any port not in the table above. A named switch case lands here. */
export const DEFAULT_PORT_COLOR = "#7c3aed";

export interface MermaidOptions {
  /** Include a `linkStyle` line per edge. Default true. */
  colors?: boolean;
  /** Label each edge with its port, except plain `main`. Default true. */
  portLabels?: boolean;
}

export function toMermaid(doc: FFIRDocument, options: MermaidOptions = {}): string {
  const colors = options.colors ?? true;
  const portLabels = options.portLabels ?? true;

  const lines: string[] = ["flowchart TD"];
  const ids = new Map<string, string>();

  for (const node of readingOrder(doc)) {
    const id = mermaidId(node.id, ids);
    const shape = NODE_SHAPES[node.kind];
    lines.push(`  ${id}${shape.open}"${escapeLabel(node.label)}"${shape.close}`);
  }

  // Edges in document order, because the index of a `linkStyle` line is the
  // index of the edge it styles and nothing else may renumber them.
  const model = graphOf(doc);
  const drawn: Edge[] = [];

  for (const entry of model.edges) {
    const from = ids.get(entry.edge.from);
    const to = ids.get(entry.edge.to);
    if (from === undefined || to === undefined) continue;

    const label = portLabels ? edgeLabel(entry.edge) : "";
    lines.push(`  ${from} ${arrow(entry.port)}${label} ${to}`);
    drawn.push(entry.edge);
  }

  if (colors && drawn.length > 0) {
    lines.push("");
    drawn.forEach((edge, index) => {
      lines.push(`  linkStyle ${index} stroke:${colorOf(portOf(edge))},stroke-width:2px`);
    });
  }

  return `${lines.join("\n")}\n`;
}

export function colorOf(port: string): string {
  return PORT_COLORS[port] ?? DEFAULT_PORT_COLOR;
}

/**
 * A dotted arrow for the unhappy path, a solid one otherwise.
 *
 * Colour alone would carry this, but a diagram is read on a projector, printed
 * in greyscale, and by people who do not distinguish red from green. The line
 * style says the same thing without relying on any of that.
 */
function arrow(port: string): string {
  return port === ERROR_PORT ? "-.->" : "-->";
}

function edgeLabel(edge: Edge): string {
  const port = portOf(edge);
  const condition = edge.condition;

  if (condition !== undefined) {
    // The port alone says "true"; the condition says what is true. Both fit.
    return `|"${escapeLabel(`${port}: ${describeCondition(edge)}`)}"|`;
  }

  return port === DEFAULT_PORT ? "" : `|"${escapeLabel(port)}"|`;
}

/** A condition in words, short enough to sit on an arrow. */
function describeCondition(edge: Edge): string {
  const condition = edge.condition;
  if (condition === undefined) return "";

  const operator = condition.operator.replace(/_/g, " ");
  return condition.right === undefined
    ? `${condition.left} ${operator}`
    : `${condition.left} ${operator} ${condition.right}`;
}

/**
 * A mermaid-safe node id.
 *
 * FFIR ids are already `[a-z0-9_]`-ish, but they arrive from a document that may
 * have been hand-written, and a mermaid id containing a space or a bracket
 * breaks the whole diagram rather than one node. Collisions after sanitizing get
 * a numeric suffix so two different nodes never become one.
 */
function mermaidId(nodeId: string, assigned: Map<string, string>): string {
  const existing = assigned.get(nodeId);
  if (existing !== undefined) return existing;

  const base = nodeId.replace(/[^A-Za-z0-9_]/g, "_") || "n";
  const taken = new Set(assigned.values());

  let candidate = base;
  let suffix = 1;
  while (taken.has(candidate)) {
    suffix += 1;
    candidate = `${base}_${suffix}`;
  }

  assigned.set(nodeId, candidate);
  return candidate;
}

/**
 * A label safe inside a quoted mermaid string.
 *
 * Quotes are the escape hatch mermaid gives for labels containing its own
 * syntax, so the only thing that has to be handled is a quote in the label
 * itself. `#quot;` is mermaid's entity form. Newlines become `<br/>`, which is
 * what mermaid renders rather than breaking the statement.
 */
function escapeLabel(text: string): string {
  return text
    .replace(/#/g, "#35;")
    .replace(/"/g, "#quot;")
    .replace(/\r?\n/g, "<br/>");
}

/** Exported for the tests that pin shape coverage. */
export function shapeFor(node: Node): { open: string; close: string } {
  return NODE_SHAPES[node.kind];
}
