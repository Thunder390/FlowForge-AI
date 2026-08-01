/**
 * Stage 3 is where determinism is decided, so most of this file is about
 * ordering: of nodes, of parameter keys, and of display names. The rest checks
 * that the intermediate representation carries what stage 4 will need, because
 * a field missing here becomes a target reaching back into the raw document,
 * which is how platform knowledge leaks upward.
 */

import { isLiteralTemplate, referencedNodeIds, type FFIRDocument } from "@flowforge/ffir";
import { cloneOnboarding, onboardingExample } from "@flowforge/ffir/fixtures";
import { loadFixtureRegistry } from "@flowforge/registry/fixtures";
import { describe, expect, it } from "vitest";

import {
  duplicateLabelDocument,
  loopDocument,
  nodeOf,
  parallelDocument,
} from "./__fixtures__/documents.js";
import {
  DEFAULT_ERROR_POLICY,
  normalize,
  topologicalOrder,
  type NormalizedEdge,
  type NormalizedGraph,
  type NormalizedNode,
} from "./normalize.js";
import { resolveNodes } from "./resolve.js";

const registry = await loadFixtureRegistry();
const TARGET = "n8n";

function graphOf(doc: FFIRDocument): NormalizedGraph {
  const resolved = resolveNodes(doc.nodes, registry, TARGET);
  if (!resolved.ok) throw new Error(`resolve failed: ${JSON.stringify(resolved.errors)}`);

  const result = normalize(doc, resolved.value.nodes, registry, TARGET);
  if (!result.ok) throw new Error(`normalize failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

/** The parts of a graph that must not vary. `index` records document position. */
function shape(graph: NormalizedGraph): unknown {
  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      order: node.order,
      displayName: node.displayName,
      parameters: node.parameters,
      errorPolicy: node.errorPolicy,
      templates: [...node.templates.keys()],
    })),
    edges: graph.edges.map((edge) => [edge.from, edge.to, edge.port, edge.backEdge]),
  };
}

describe("the worked example", () => {
  const graph = graphOf(onboardingExample);

  it("sorts the nodes topologically from the trigger", () => {
    expect(graph.nodes.map((node) => node.id)).toEqual([
      "n_trigger",
      "n_build_email",
      "n_create_account",
      "n_alert_it",
      "n_slack_welcome",
    ]);
  });

  it("numbers each node with its position in that order", () => {
    expect(graph.nodes.map((node) => node.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it("identifies the trigger", () => {
    expect(graph.trigger.id).toBe("n_trigger");
  });

  it("carries the registry version, so a compile can be diagnosed later", () => {
    expect(graph.registryVersion).toBe("n8n@1.62.0+overlay.3");
  });

  it("maps every node id to a display name taken from its label", () => {
    expect(graph.displayNames.get("n_trigger")).toBe("New employee in BambooHR");
    expect(graph.displayNames.get("n_slack_welcome")).toBe("Announce in Slack");
  });

  it("keeps the edges in document order, back-edge flags included", () => {
    expect(graph.edges.map((edge) => [edge.from, edge.to, edge.port])).toEqual([
      ["n_trigger", "n_build_email", "main"],
      ["n_build_email", "n_create_account", "main"],
      ["n_create_account", "n_slack_welcome", "main"],
      ["n_create_account", "n_alert_it", "error"],
    ]);
    expect(graph.edges.every((edge) => !edge.backEdge)).toBe(true);
  });

  it("indexes edges by source and by destination", () => {
    expect(graph.outbound.get("n_create_account")?.map((edge) => edge.port)).toEqual([
      "main",
      "error",
    ]);
    expect(graph.inbound.get("n_slack_welcome")).toHaveLength(1);
  });
});

describe("registry defaults", () => {
  const graph = graphOf(onboardingExample);

  it("fills an absent optional parameter from the registry", () => {
    // core.transform.map declares include_other_fields with a default of true,
    // and the worked example does not set it.
    expect(graph.byId.get("n_build_email")?.parameters["include_other_fields"]).toBe(true);
  });

  it("fills several defaults on one node", () => {
    expect(graph.byId.get("n_create_account")?.parameters).toMatchObject({
      change_password_at_next_login: true,
      org_unit_path: "/",
    });
  });

  it("does not overwrite a value the document set", () => {
    expect(graph.byId.get("n_trigger")?.parameters["poll_interval_minutes"]).toBe(15);
  });

  it("leaves an optional parameter with no default absent", () => {
    const slack = graph.byId.get("n_slack_welcome");
    expect(slack?.parameters).not.toHaveProperty("thread_ts");
    expect(slack?.parameters).not.toHaveProperty("blocks");
  });

  it("emits keys in the registry's declaration order, not the document's", () => {
    // Two documents differing only in JSON key order have to normalize to the
    // same thing, or every golden file downstream depends on how the model
    // happened to serialize its output.
    const shuffled = cloneOnboarding();
    const slack = nodeOf(shuffled, "n_slack_welcome");
    slack.parameters = { text: slack.parameters["text"] as string, channel: "#general" };

    expect(Object.keys(graphOf(shuffled).byId.get("n_slack_welcome")!.parameters)).toEqual(
      Object.keys(graph.byId.get("n_slack_welcome")!.parameters),
    );
  });

  it("does not mutate the document it was given", () => {
    const before = structuredClone(onboardingExample);
    graphOf(onboardingExample);
    expect(onboardingExample).toEqual(before);
  });
});

describe("error policy", () => {
  const graph = graphOf(onboardingExample);

  it("applies the workflow default when a node declares none", () => {
    expect(graph.byId.get("n_slack_welcome")?.errorPolicy).toEqual(DEFAULT_ERROR_POLICY);
    expect(DEFAULT_ERROR_POLICY).toEqual({ on_error: "stop" });
  });

  it("keeps a policy the node declared", () => {
    expect(graph.byId.get("n_create_account")?.errorPolicy).toEqual({
      on_error: "route",
      retry: { attempts: 2, backoff: "exponential", initial_delay_ms: 2000 },
    });
  });
});

describe("expressions", () => {
  const graph = graphOf(onboardingExample);

  it("parses every string, including the ones with no expressions in them", () => {
    // A target has to be able to tell a template carrying a reference from one
    // that is only text. Making it re-scan the raw string for braces would put
    // the parse back in the target, which is what this stage exists to prevent.
    const slack = graph.byId.get("n_slack_welcome");
    expect([...(slack?.templates.keys() ?? [])].sort()).toEqual(["/channel", "/text"]);
    expect(isLiteralTemplate(slack!.templates.get("/channel")!)).toBe(true);
    expect(isLiteralTemplate(slack!.templates.get("/text")!)).toBe(false);
  });

  it("resolves references to the nodes they name", () => {
    const template = graph.byId.get("n_slack_welcome")?.templates.get("/text");
    expect(referencedNodeIds(template!)).toEqual(["n_trigger", "n_build_email"]);
  });

  it("keys templates by pointer, including through arrays", () => {
    expect([...(graph.byId.get("n_build_email")?.templates.keys() ?? [])]).toEqual([
      "/assignments/0/field",
      "/assignments/0/value",
    ]);
  });

  it("parses a template that is three references and two literals", () => {
    const template = graph.byId.get("n_build_email")?.templates.get("/assignments/0/value");
    expect(template?.parts).toHaveLength(5);
    expect(referencedNodeIds(template!)).toEqual(["n_trigger"]);
  });

  it("reports a malformed expression as a validate failure rather than throwing", () => {
    const doc = cloneOnboarding();
    nodeOf(doc, "n_slack_welcome").parameters["text"] = "Hi {{ n_trigger. }}";

    const resolved = resolveNodes(doc.nodes, registry, TARGET);
    if (!resolved.ok) throw new Error("expected resolve to succeed");

    const result = normalize(doc, resolved.value.nodes, registry, TARGET);
    if (result.ok) throw new Error("expected a failure");
    expect(result.errors[0]).toMatchObject({ stage: "validate", nodeId: "n_slack_welcome" });
  });
});

describe("conditions", () => {
  it("parses both operands of an edge condition", () => {
    const doc = parallelDocument();
    doc.edges[0]!.condition = {
      left: "{{ n_trigger.employee.first_name }}",
      operator: "equals",
      right: "Ada",
    };

    const edge = graphOf(doc).edges[0] as NormalizedEdge;
    expect(edge.condition?.operator).toBe("equals");
    expect(referencedNodeIds(edge.condition!.left)).toEqual(["n_trigger"]);
    expect(isLiteralTemplate(edge.condition!.right!)).toBe(true);
  });

  it("leaves the right operand absent for a unary operator", () => {
    const doc = parallelDocument();
    doc.edges[0]!.condition = {
      left: "{{ n_trigger.employee.first_name }}",
      operator: "is_empty",
    };

    expect(graphOf(doc).edges[0]?.condition?.right).toBeUndefined();
  });

  it("leaves condition absent on an edge that has none", () => {
    expect(graphOf(onboardingExample).edges[0]?.condition).toBeUndefined();
  });
});

describe("display names", () => {
  it("suffixes duplicates and skips a suffix the document already uses", () => {
    // Targets reference nodes by name. Two nodes sharing one would produce a
    // workflow whose references are ambiguous, and blindly appending " 2" to a
    // document that already contains "Notify 2" would produce two of those.
    const graph = graphOf(duplicateLabelDocument());

    expect(graph.displayNames.get("n_left")).toBe("Notify");
    expect(graph.displayNames.get("n_right")).toBe("Notify 2");
    expect(graph.displayNames.get("n_third")).toBe("Notify 2 2");
    expect(graph.displayNames.get("n_fourth")).toBe("Notify 3");
  });

  it("produces a unique name for every node", () => {
    const graph = graphOf(duplicateLabelDocument());
    const names = [...graph.displayNames.values()];
    expect(new Set(names).size).toBe(names.length);
  });

  it("assigns in document order, so rewiring an edge cannot rename a node", () => {
    // If names followed topological order, adding a connection could rename an
    // unrelated node and break every expression that referenced it by name.
    const before = graphOf(duplicateLabelDocument()).displayNames;

    const rewired = duplicateLabelDocument();
    rewired.edges = [
      { id: "e_1", from: "n_trigger", to: "n_right" },
      { id: "e_2", from: "n_right", to: "n_left" },
      { id: "e_3", from: "n_left", to: "n_third" },
      { id: "e_4", from: "n_third", to: "n_fourth" },
    ];

    expect(graphOf(rewired).displayNames).toEqual(before);
  });

  it("falls back to the node id when a label is only whitespace", () => {
    const doc = parallelDocument();
    nodeOf(doc, "n_left").label = "   ";
    expect(graphOf(doc).displayNames.get("n_left")).toBe("n_left");
  });
});

describe("loops", () => {
  const graph = graphOf(loopDocument());

  it("flags the back-edge and only the back-edge", () => {
    expect(
      graph.edges.filter((edge) => edge.backEdge).map((edge) => edge.edge.id),
    ).toEqual(["e_3"]);
  });

  it("sorts a cyclic edge list without stalling", () => {
    expect(graph.nodes.map((node) => node.id)).toEqual([
      "n_trigger",
      "n_loop",
      "n_after",
      "n_body",
    ]);
  });

  it("keeps the each and done ports distinct", () => {
    expect(graph.outbound.get("n_loop")?.map((edge) => edge.port)).toEqual(["each", "done"]);
  });

  it("applies the loop capability's defaults", () => {
    expect(graph.byId.get("n_loop")?.parameters).toMatchObject({
      item_alias: "item",
      batch_size: 1,
      max_iterations: 50,
    });
  });
});

describe("the topological sort", () => {
  function ids(
    nodes: string[],
    edges: [string, string][],
    backEdges: [string, string][] = [],
    trigger = "a",
  ): string[] {
    const map = new Map(nodes.map((id) => [id, { id } as NormalizedNode]));
    const built: NormalizedEdge[] = [
      ...edges.map(([from, to]) => edgeOf(from, to, false)),
      ...backEdges.map(([from, to]) => edgeOf(from, to, true)),
    ];
    return topologicalOrder(map, built, trigger);
  }

  function edgeOf(from: string, to: string, backEdge: boolean): NormalizedEdge {
    return {
      edge: { id: `${from}->${to}`, from, to },
      index: 0,
      from,
      to,
      port: "main",
      backEdge,
    };
  }

  it("breaks ties on node id, so independent branches cannot swap", () => {
    expect(
      ids(["a", "z", "m"], [
        ["a", "z"],
        ["a", "m"],
      ]),
    ).toEqual(["a", "m", "z"]);
  });

  it("gives the same answer whatever order the edges arrive in", () => {
    const forward: [string, string][] = [
      ["a", "z"],
      ["a", "m"],
      ["m", "q"],
      ["z", "q"],
    ];
    expect(ids(["a", "z", "m", "q"], forward)).toEqual(
      ids(["a", "z", "m", "q"], [...forward].reverse()),
    );
  });

  it("puts the trigger first even when another node also has no inbound edge", () => {
    // The sort is specified as being from the trigger, so it leads regardless
    // of where its id falls alphabetically.
    expect(ids(["a", "b"], [], [], "b")).toEqual(["b", "a"]);
  });

  it("does not stall on a back-edge", () => {
    expect(
      ids(
        ["a", "loop", "body"],
        [
          ["a", "loop"],
          ["loop", "body"],
        ],
        [["body", "loop"]],
      ),
    ).toEqual(["a", "loop", "body"]);
  });

  it("appends a node the trigger cannot reach rather than dropping it", () => {
    // Validation rule 3 rejects an unreachable node, so this cannot happen
    // through the pipeline. Dropping one silently is how a compiler emits a
    // workflow that is quietly missing a step.
    expect(ids(["a", "b", "orphan"], [["a", "b"]])).toEqual(["a", "b", "orphan"]);
  });

  it("appends every node of a disconnected cycle rather than losing them", () => {
    expect(
      ids(["a", "x", "y"], [
        ["x", "y"],
        ["y", "x"],
      ]),
    ).toEqual(["a", "x", "y"]);
  });
});

describe("determinism", () => {
  it("normalizes twice to the same graph", () => {
    expect(shape(graphOf(onboardingExample))).toEqual(shape(graphOf(onboardingExample)));
  });

  it("serializes to byte-identical JSON", () => {
    expect(JSON.stringify(shape(graphOf(onboardingExample)))).toBe(
      JSON.stringify(shape(graphOf(onboardingExample))),
    );
  });

  it("is unmoved by the order the nodes appear in the document", () => {
    const shuffled = cloneOnboarding();
    shuffled.nodes = [
      nodeOf(shuffled, "n_alert_it"),
      nodeOf(shuffled, "n_create_account"),
      nodeOf(shuffled, "n_trigger"),
      nodeOf(shuffled, "n_slack_welcome"),
      nodeOf(shuffled, "n_build_email"),
    ];

    expect(shape(graphOf(shuffled))).toEqual(shape(graphOf(onboardingExample)));
  });

  it("is unmoved by the order the edges appear in the document", () => {
    const shuffled = cloneOnboarding();
    shuffled.edges = [...shuffled.edges].reverse();

    expect(graphOf(shuffled).nodes.map((node) => node.id)).toEqual(
      graphOf(onboardingExample).nodes.map((node) => node.id),
    );
  });
});

describe("edge cases", () => {
  it("normalizes a single-node workflow", () => {
    const doc = cloneOnboarding();
    doc.nodes = [nodeOf(doc, "n_trigger")];
    doc.edges = [];
    doc.credentials = doc.credentials.filter((c) => c.id === "cred_bamboohr");
    doc.variables = [];

    const graph = graphOf(doc);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.trigger.id).toBe("n_trigger");
    expect(graph.edges).toEqual([]);
  });

  it("fails rather than throwing when there is no trigger to sort from", () => {
    const doc = cloneOnboarding();
    nodeOf(doc, "n_trigger").kind = "action";

    const resolved = resolveNodes(doc.nodes, registry, TARGET);
    if (!resolved.ok) throw new Error("expected resolve to succeed");

    const result = normalize(doc, resolved.value.nodes, registry, TARGET);
    if (result.ok) throw new Error("expected a failure");
    expect(result.errors[0]).toMatchObject({ stage: "validate", code: "missing_trigger" });
  });

  it("ignores an edge naming a node that does not exist", () => {
    // The graph model drops malformed edges; rule 1 has already reported them.
    const doc = cloneOnboarding();
    doc.edges.push({ id: "e_bogus", from: "n_trigger", to: "n_nowhere" });

    expect(graphOf(doc).edges.map((edge) => edge.edge.id)).toEqual([
      "e_1",
      "e_2",
      "e_3",
      "e_4",
    ]);
  });

  it("carries degradation through to the normalized node", () => {
    const forTarget = new Map(registry.bindings.get(TARGET));
    forTarget.set("slack.message.send", null);
    const degraded = { ...registry, bindings: new Map([[TARGET, forTarget]]) };

    const resolved = resolveNodes(onboardingExample.nodes, degraded, TARGET);
    if (!resolved.ok) throw new Error("expected resolve to succeed");
    const result = normalize(onboardingExample, resolved.value.nodes, degraded, TARGET);
    if (!result.ok) throw new Error("expected success");

    expect(result.value.byId.get("n_slack_welcome")?.degraded).toBe(true);
    expect(result.value.byId.get("n_slack_welcome")?.boundCapability).toBe(
      "http.request.send",
    );
  });
});
