import { NODE_KINDS, type FFIRDocument } from "@flowforge/ffir";
import { cloneOnboarding, onboardingExample } from "@flowforge/ffir/fixtures";
import { describe, expect, it } from "vitest";

import { DEFAULT_PORT_COLOR, NODE_SHAPES, PORT_COLORS, colorOf, toMermaid } from "./mermaid.js";

const diagram = toMermaid(onboardingExample);

/** Every `linkStyle` line, in the order mermaid will apply them. */
function linkStyles(source: string): string[] {
  return source.split("\n").filter((line) => line.trim().startsWith("linkStyle"));
}

/**
 * Node ids in declaration order.
 *
 * A declaration is an id immediately followed by a shape delimiter, which is
 * what distinguishes it from an edge statement: `n_a --> n_b` also begins with
 * an id, and matching on that alone counts every edge as a node.
 */
function declaredIds(source: string): string[] {
  return source
    .split("\n")
    .map((line) => /^ {2}([A-Za-z0-9_]+)[([{>/\\]/.exec(line)?.[1])
    .filter((id): id is string => id !== undefined);
}

/**
 * Edge statements, in either arrow form.
 *
 * The source must be a bare id. Matching any non-whitespace before the arrow
 * would count a declaration whose *label* contains arrow syntax, which is the
 * exact case one of these tests exists to check.
 */
function edgeLines(source: string): string[] {
  return source.split("\n").filter((line) => /^ {2}[A-Za-z0-9_]+ -\.?->/.test(line));
}

describe("the diagram", () => {
  it("declares a top-down flowchart", () => {
    expect(diagram.startsWith("flowchart TD\n")).toBe(true);
  });

  it("ends with a newline", () => {
    expect(diagram.endsWith("\n")).toBe(true);
  });

  it("declares every node exactly once", () => {
    for (const node of onboardingExample.nodes) {
      const declarations = diagram
        .split("\n")
        .filter((line) => new RegExp(`^\\s*${node.id}[([{>/\\\\]`).test(line));
      expect(declarations, node.id).toHaveLength(1);
    }
  });

  it("draws every edge", () => {
    expect(edgeLines(diagram)).toHaveLength(onboardingExample.edges.length);
  });

  it("lists nodes in reading order rather than document order", () => {
    // The trigger first, then what it leads to. FFIR's node array is explicitly
    // unordered, so document order would put the last step first whenever the
    // model happened to emit it that way.
    expect(declaredIds(diagram)).toEqual([
      "n_trigger",
      "n_build_email",
      "n_create_account",
      "n_alert_it",
      "n_slack_welcome",
    ]);
  });
});

describe("shapes", () => {
  it("uses the three shapes the architecture names", () => {
    expect(NODE_SHAPES.trigger).toEqual({ open: "([", close: "])" });
    expect(NODE_SHAPES.action).toEqual({ open: "[", close: "]" });
    expect(NODE_SHAPES.branch).toEqual({ open: "{", close: "}" });
  });

  it("has a shape for every FFIR node kind", () => {
    // A kind with no shape would render as a syntax error rather than a node,
    // taking the whole diagram with it.
    expect(Object.keys(NODE_SHAPES).sort()).toEqual([...NODE_KINDS].sort());
  });

  it("gives every kind a distinct shape", () => {
    const shapes = Object.values(NODE_SHAPES).map((shape) => `${shape.open}|${shape.close}`);
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  it("renders the trigger as a stadium and the transform as a parallelogram", () => {
    expect(diagram).toContain('n_trigger(["New employee in BambooHR"])');
    expect(diagram).toContain('n_build_email[/"Build the email address"/]');
  });

  it("renders an error handler distinctly from an action", () => {
    expect(diagram).toContain('n_alert_it>"Alert IT on failure"]');
    expect(diagram).toContain('n_slack_welcome["Announce in Slack"]');
  });
});

describe("edges", () => {
  it("colours one linkStyle per edge, in draw order", () => {
    // The index of a linkStyle line is the index of the edge it styles, so the
    // two lists must stay in step or every edge gets someone else's colour.
    const styles = linkStyles(diagram);
    expect(styles).toHaveLength(onboardingExample.edges.length);
    styles.forEach((line, index) => {
      expect(line).toContain(`linkStyle ${index} `);
    });
  });

  it("colours the error edge red and the main edges neutral", () => {
    const styles = linkStyles(diagram);
    expect(styles[0]).toContain(PORT_COLORS["main"]);
    expect(styles[3]).toContain(PORT_COLORS["error"]);
  });

  it("dots the error edge, so the diagram survives greyscale", () => {
    // Colour alone would carry this, but a diagram gets printed, projected, and
    // read by people who do not distinguish red from green.
    expect(diagram).toContain("n_create_account -.->");
    expect(diagram).toContain("n_trigger --> n_build_email");
  });

  it("labels a non-default port and leaves main unlabelled", () => {
    expect(diagram).toContain('-.->|"error"|');
    expect(diagram).toContain("n_trigger --> n_build_email");
  });

  it("falls back to the branch colour for a named switch case", () => {
    expect(colorOf("engineering")).toBe(DEFAULT_PORT_COLOR);
    expect(colorOf("true")).toBe(PORT_COLORS["true"]);
  });

  it("puts the condition on the arrow when there is one", () => {
    const doc = cloneOnboarding();
    doc.edges[2]!.port = "true";
    doc.edges[2]!.condition = {
      left: "{{ n_trigger.employee.department }}",
      operator: "equals",
      right: "Engineering",
    };

    expect(toMermaid(doc)).toContain("true: {{ n_trigger.employee.department }} equals Engineering");
  });

  it("can be asked for no colours and no port labels", () => {
    const plain = toMermaid(onboardingExample, { colors: false, portLabels: false });
    expect(linkStyles(plain)).toEqual([]);
    expect(plain).not.toContain('|"error"|');
  });
});

describe("escaping", () => {
  function withLabel(label: string): FFIRDocument {
    const doc = cloneOnboarding();
    doc.nodes[0]!.label = label;
    return doc;
  }

  it("escapes a quote in a label", () => {
    // Quotes are mermaid's own escape hatch for labels, so a quote inside one
    // ends the label early and breaks the statement.
    expect(toMermaid(withLabel('Say "hello"'))).toContain('#quot;hello#quot;');
  });

  it("escapes a hash, which mermaid reads as an entity", () => {
    expect(toMermaid(withLabel("Post to #general"))).toContain("#35;general");
  });

  it("turns a newline into a line break rather than ending the statement", () => {
    expect(toMermaid(withLabel("Line one\nLine two"))).toContain("Line one<br/>Line two");
  });

  it("survives a label made of mermaid syntax", () => {
    const source = toMermaid(withLabel("A --> B{x}"));
    expect(source).toContain('n_trigger(["A --> B{x}"])');
    // Arrow syntax inside a quoted label is text, not a fifth edge.
    expect(edgeLines(source)).toHaveLength(onboardingExample.edges.length);
    expect(declaredIds(source)).toHaveLength(onboardingExample.nodes.length);
  });

  it("sanitizes a node id that is not mermaid-safe", () => {
    const doc = cloneOnboarding();
    doc.nodes[0]!.id = "n trigger!";
    doc.edges[0]!.from = "n trigger!";

    const source = toMermaid(doc);
    expect(source).toContain('n_trigger_(["New employee in BambooHR"])');
    expect(source).not.toContain("n trigger!");
  });
});

describe("edge cases", () => {
  it("renders a single-node workflow", () => {
    const doc = cloneOnboarding();
    doc.nodes = [doc.nodes[0]!];
    doc.edges = [];

    const source = toMermaid(doc);
    expect(source).toContain("n_trigger([");
    expect(linkStyles(source)).toEqual([]);
  });

  it("skips an edge naming a node that does not exist", () => {
    // Validation rule 1 rejects it; a renderer that emitted it would produce a
    // diagram with a phantom node in it.
    const doc = cloneOnboarding();
    doc.edges.push({ id: "e_bogus", from: "n_trigger", to: "n_nowhere" });

    expect(toMermaid(doc)).not.toContain("n_nowhere");
  });

  it("does not mutate the document", () => {
    const before = structuredClone(onboardingExample);
    toMermaid(onboardingExample);
    expect(onboardingExample).toEqual(before);
  });
});

describe("it actually renders", () => {
  /**
   * The milestone asks for "a mermaid diagram that renders", and the ways one
   * fails to are structural rather than aesthetic. Pulling in a mermaid parser
   * to prove it would add a dependency to a package whose whole job is to have
   * none, so these check the three faults that break a diagram outright.
   */
  const cases: [string, FFIRDocument][] = [
    ["the worked example", onboardingExample],
    [
      "a label full of syntax",
      (() => {
        const doc = cloneOnboarding();
        doc.nodes[0]!.label = 'A --> B{x} "q" #h';
        return doc;
      })(),
    ],
  ];

  for (const [name, doc] of cases) {
    it(`${name}: every edge endpoint is a declared node`, () => {
      // An arrow to an id that was never declared makes mermaid invent an empty
      // node, which is how a diagram silently gains a phantom step.
      const source = toMermaid(doc);
      const declared = new Set(declaredIds(source));

      for (const line of edgeLines(source)) {
        const [, from, to] = /^ {2}([A-Za-z0-9_]+) -\.?->(?:\|.*\|)? ([A-Za-z0-9_]+)/.exec(
          line,
        ) ?? [];
        expect(declared.has(from ?? ""), `${line} (from)`).toBe(true);
        expect(declared.has(to ?? ""), `${line} (to)`).toBe(true);
      }
    });

    it(`${name}: every label is a balanced quoted string`, () => {
      // An unescaped quote ends the label early and mermaid fails the whole
      // parse rather than the one node.
      for (const line of toMermaid(doc).split("\n")) {
        if (!/^ {2}[A-Za-z0-9_]+[([{>/\\]/.test(line)) continue;
        expect((line.match(/"/g) ?? []).length, line).toBe(2);
      }
    });

    it(`${name}: styles no link that does not exist`, () => {
      // linkStyle with an out-of-range index is a hard mermaid error.
      const source = toMermaid(doc);
      const edges = edgeLines(source).length;

      for (const style of linkStyles(source)) {
        const index = Number(/linkStyle (\d+)/.exec(style)?.[1]);
        expect(index, style).toBeLessThan(edges);
      }
    });
  }
});

describe("determinism", () => {
  it("renders identically on repeated calls", () => {
    expect(toMermaid(onboardingExample)).toBe(diagram);
  });

  it("is unmoved by the order the nodes are written in", () => {
    const shuffled = cloneOnboarding();
    shuffled.nodes = [...shuffled.nodes].reverse();
    expect(toMermaid(shuffled)).toBe(diagram);
  });
});
