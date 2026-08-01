/**
 * Stage 6 is the check that catches what unit tests miss, so it gets tested by
 * handing it broken output directly. Every failure here means the compiler has
 * a bug, which is exactly why the check has to fire rather than be plausible.
 */

import { onboardingExample } from "@flowforge/ffir/fixtures";
import { loadFixtureRegistry } from "@flowforge/registry/fixtures";
import { describe, expect, it } from "vitest";

import { compile } from "../../compile.js";
import { n8nTarget } from "./index.js";
import type { N8nWorkflow } from "./ir.js";
import { verifyN8n } from "./verify.js";

const registry = await loadFixtureRegistry();

const good = (() => {
  const result = compile(onboardingExample, registry, n8nTarget);
  if (!result.ok) throw new Error("fixture does not compile");
  return result.value.content;
})();

/** Re-serializes a mutated workflow the way emit does, so only the mutation differs. */
function emitted(mutate: (workflow: N8nWorkflow) => void): { target: string; content: string } {
  const workflow = JSON.parse(good) as N8nWorkflow;
  mutate(workflow);
  return { target: "n8n", content: `${JSON.stringify(workflow, null, 2)}\n` };
}

function failures(result: ReturnType<typeof verifyN8n>): readonly string[] {
  return result.ok ? [] : result.failures;
}

describe("valid output", () => {
  it("passes", () => {
    expect(verifyN8n({ target: "n8n", content: good })).toEqual({ ok: true });
  });
});

describe("structural checks", () => {
  it("rejects a connection naming a node that does not exist", () => {
    const output = emitted((workflow) => {
      workflow.connections["New employee in BambooHR"] = {
        main: [[{ node: "Ghost", type: "main", index: 0 }]],
      };
    });
    expect(failures(verifyN8n(output))[0]).toContain('"Ghost", which is not a node');
  });

  it("rejects a connections key that is not a node", () => {
    const output = emitted((workflow) => {
      workflow.connections["Nobody"] = { main: [[]] };
    });
    expect(failures(verifyN8n(output))).toContainEqual(
      'connections name "Nobody", which is not a node',
    );
  });

  it("rejects two nodes with the same name", () => {
    // n8n references nodes by name, so duplicates make every reference to them
    // ambiguous.
    const output = emitted((workflow) => {
      const second = workflow.nodes[1];
      if (second !== undefined) second.name = "New employee in BambooHR";
    });
    expect(failures(verifyN8n(output))).toContainEqual(
      'two nodes are called "New employee in BambooHR"',
    );
  });

  it("rejects a node with no type", () => {
    const output = emitted((workflow) => {
      const first = workflow.nodes[0];
      if (first !== undefined) first.type = "";
    });
    expect(failures(verifyN8n(output))).toContainEqual(
      'node "New employee in BambooHR" has no type',
    );
  });

  it("rejects a node with no typeVersion", () => {
    const output = emitted((workflow) => {
      const first = workflow.nodes[0];
      if (first !== undefined) delete (first as { typeVersion?: number }).typeVersion;
    });
    expect(failures(verifyN8n(output))).toContainEqual(
      'node "New employee in BambooHR" has no typeVersion',
    );
  });

  it("rejects a node with no id", () => {
    const output = emitted((workflow) => {
      const first = workflow.nodes[0];
      if (first !== undefined) first.id = "";
    });
    expect(failures(verifyN8n(output))).toContainEqual(
      'node "New employee in BambooHR" has no id',
    );
  });

  it("rejects a node with no name", () => {
    const output = emitted((workflow) => {
      const first = workflow.nodes[0];
      if (first !== undefined) first.name = "";
    });
    expect(failures(verifyN8n(output))).toContainEqual("a node has no name");
  });

  it("rejects content that is not JSON at all", () => {
    expect(failures(verifyN8n({ target: "n8n", content: "{" }))[0]).toContain(
      "not valid JSON",
    );
  });

  it("rejects output whose formatting does not round-trip", () => {
    expect(
      failures(verifyN8n({ target: "n8n", content: '{"nodes":[],"connections":{}}' })),
    ).toContain("emitted JSON does not round-trip through parse and stringify");
  });

  it("reports every problem at once", () => {
    const output = emitted((workflow) => {
      const first = workflow.nodes[0];
      if (first !== undefined) {
        first.type = "";
        first.id = "";
      }
    });
    expect(failures(verifyN8n(output)).length).toBeGreaterThan(1);
  });
});

describe("credentials", () => {
  it("rejects a credential carrying anything but the placeholder", () => {
    // A real id here would mean the compiler had learned a value it has no
    // business holding.
    const output = emitted((workflow) => {
      const slack = workflow.nodes.find((node) => node.credentials !== undefined);
      if (slack?.credentials !== undefined) {
        const key = Object.keys(slack.credentials)[0] as string;
        slack.credentials[key] = { id: "cred_live_9f2", name: "Slack" };
      }
    });
    expect(failures(verifyN8n(output))[0]).toContain("does not carry the placeholder id");
  });

  it("rejects a credential with no name to show the user", () => {
    const output = emitted((workflow) => {
      const slack = workflow.nodes.find((node) => node.credentials !== undefined);
      if (slack?.credentials !== undefined) {
        const key = Object.keys(slack.credentials)[0] as string;
        slack.credentials[key] = { id: "REPLACE_ME", name: "" };
      }
    });
    expect(failures(verifyN8n(output))[0]).toContain("has no name");
  });
});

/**
 * A value the scanner flags that carries no credential material at all.
 *
 * These tests only need *some* pattern to fire, and which one is incidental.
 * The obvious choice, a realistic Slack or AWS token, is a bad one: push
 * protection blocks it before it reaches CI, so the test can never be pushed,
 * and a fixture nobody can commit is worse than no fixture.
 *
 * This is FFIR's `jwt` shape. `eyJ` is only base64 for `{"`, and the two
 * segments here decode to `{"a":1}` and `{"b":2}`. It is structurally a secret
 * and semantically nothing, which is exactly what a fixture should be.
 */
const SECRET_SHAPED_VALUE = "eyJhIjoxfQ.eyJiIjoyfQ.";

describe("the secret scan", () => {
  it("refuses to emit a parameter that looks like a secret", () => {
    // Duplicates validation rule 14 on purpose. Rule 14 covers what the document
    // carries; this covers what the compiler produced, which is a different
    // thing once static parameters and transforms have run.
    const output = emitted((workflow) => {
      const slack = workflow.nodes.find((node) => node.name === "Announce in Slack");
      if (slack !== undefined) slack.parameters["text"] = SECRET_SHAPED_VALUE;
    });

    const found = failures(verifyN8n(output));
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]).toContain("was not emitted");
  });

  it("never echoes what matched", () => {
    // A verify failure reaches logs and the repair prompt, and the repair
    // prompt is sent to a model and stored.
    const output = emitted((workflow) => {
      const slack = workflow.nodes.find((node) => node.name === "Announce in Slack");
      if (slack !== undefined) slack.parameters["text"] = SECRET_SHAPED_VALUE;
    });

    for (const failure of failures(verifyN8n(output))) {
      expect(failure).not.toContain(SECRET_SHAPED_VALUE);
    }
  });

  it("names the node and the parameter path instead", () => {
    const output = emitted((workflow) => {
      const slack = workflow.nodes.find((node) => node.name === "Announce in Slack");
      if (slack !== undefined) slack.parameters["text"] = SECRET_SHAPED_VALUE;
    });

    const found = failures(verifyN8n(output))[0] ?? "";
    expect(found).toContain("Announce in Slack");
    expect(found).toContain("/text");
  });

  it("leaves an ordinary parameter alone", () => {
    expect(verifyN8n({ target: "n8n", content: good }).ok).toBe(true);
  });
});
