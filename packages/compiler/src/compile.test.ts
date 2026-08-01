/**
 * The driver's contract: the stages run in the specified order, a failure stops
 * the pipeline, warnings survive a failure, and the whole thing is a pure
 * function of its inputs.
 *
 * The last section is the one that will still be earning its keep in a year. A
 * compiler's bugs are silent, so the properties that keep golden-file testing
 * meaningful, determinism and purity and the dependency rule, are worth pinning
 * with tests that fail loudly when someone reaches for a clock.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { cloneOnboarding, onboardingExample } from "@flowforge/ffir/fixtures";
import { HTTP_FALLBACK_CAPABILITY, type Registry } from "@flowforge/registry";
import { loadFixtureRegistry } from "@flowforge/registry/fixtures";
import { describe, expect, it } from "vitest";

import { loopDocument, nodeOf, parallelDocument } from "./__fixtures__/documents.js";
import { fakeTarget, LINEAR_CAPABILITIES, type FakeIR } from "./__fixtures__/index.js";
import { compile, compileToGraph, fileNameFor } from "./compile.js";
import { describeCompileError, nodeIdOf } from "./errors.js";

const registry = await loadFixtureRegistry();
const target = fakeTarget({ key: "n8n" });

/**
 * A constrained target that still resolves against the fixture registry.
 *
 * The key has to stay `n8n` because it is also the registry's binding key, and
 * a target whose key names no binding set degrades every node and then fails at
 * stage 2, which is a different test from the one being written here.
 */
const linearTarget = fakeTarget({
  key: "n8n",
  displayName: "Linear",
  capabilities: LINEAR_CAPABILITIES,
});

function sourceFile(name: string): string {
  return fileURLToPath(new URL(name, import.meta.url));
}

/**
 * Source with comments removed.
 *
 * These guards are about what the code does, not what it says. `uuid.ts`
 * explains at length why it does not call `randomUUID`, and a check that failed
 * on that sentence would get its pattern weakened until it stopped catching the
 * real thing. The `[^:]` guard keeps `https://` inside a string from being read
 * as the start of a comment.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Every source file in the package, listed rather than globbed.
 *
 * A glob would silently start covering a new file, which sounds like a feature
 * until someone adds one that legitimately needs a clock and the guard quietly
 * fails for a reason nobody expects. A list makes adding a file a decision.
 */
const SOURCE_FILES = [
  "compile.ts",
  "normalize.ts",
  "resolve.ts",
  "validate.ts",
  "capabilities.ts",
  "errors.ts",
  "target.ts",
  "transforms.ts",
  "uuid.ts",
  "index.ts",
  "targets/n8n/index.ts",
  "targets/n8n/ir.ts",
  "targets/n8n/lower.ts",
  "targets/n8n/emit.ts",
  "targets/n8n/verify.ts",
  "targets/n8n/expression.ts",
  "targets/n8n/conditions.ts",
  "targets/n8n/layout.ts",
  "targets/n8n/parameters.ts",
];

describe("a successful compile", () => {
  const result = compile(onboardingExample, registry, target);

  it("succeeds", () => {
    expect(result.ok).toBe(true);
  });

  it("returns the artifact, the extension, and the graph it was built from", () => {
    if (!result.ok) throw new Error("expected success");
    expect(result.value.target).toBe("n8n");
    expect(result.value.fileExtension).toBe("json");
    expect(result.value.graph.nodes).toHaveLength(5);
  });

  it("hands the target a graph in topological order", () => {
    if (!result.ok) throw new Error("expected success");
    const emitted = JSON.parse(result.value.content) as FakeIR;

    expect(emitted.nodes.map((node) => node.name)).toEqual([
      "New employee in BambooHR",
      "Build the email address",
      "Create Google Workspace account",
      "Alert IT on failure",
      "Announce in Slack",
    ]);
  });

  it("gives every FFIR node exactly one node in the output", () => {
    if (!result.ok) throw new Error("expected success");
    const emitted = JSON.parse(result.value.content) as FakeIR;
    expect(emitted.nodes).toHaveLength(onboardingExample.nodes.length);
    expect(new Set(emitted.nodes.map((node) => node.name)).size).toBe(5);
  });

  it("gives every FFIR edge a connection", () => {
    if (!result.ok) throw new Error("expected success");
    const emitted = JSON.parse(result.value.content) as FakeIR;
    expect(emitted.connections).toHaveLength(onboardingExample.edges.length);
  });

  it("carries no warnings for a fully bound document", () => {
    expect(result.warnings).toEqual([]);
  });
});

describe("stage order", () => {
  it("stops at stage 1 rather than reporting a target mismatch too", () => {
    // Reporting "this target cannot branch" about a document that turns out to
    // be invalid helps nobody. Validation first, then whether a valid workflow
    // fits this platform.
    const doc = cloneOnboarding();
    nodeOf(doc, "n_slack_welcome").capability = "slack.message.broadcast";

    const result = compile(doc, registry, linearTarget);
    if (result.ok) throw new Error("expected a failure");
    expect(new Set(result.errors.map((error) => error.stage))).toEqual(new Set(["validate"]));
  });

  it("runs the capability check before lowering", () => {
    const result = compile(loopDocument(), registry, linearTarget);

    if (result.ok) throw new Error("expected a failure");
    expect(result.errors.some((error) => error.stage === "lower")).toBe(true);
  });

  it("treats a stage 6 failure as an internal error and refuses to emit", () => {
    // A verify failure means the compiler has a bug. The correct response is to
    // fail rather than hand the user a broken file, and to say whose fault it is.
    const broken = fakeTarget({ key: "n8n", breakVerify: true });
    const result = compile(onboardingExample, registry, broken);

    if (result.ok) throw new Error("expected a failure");
    expect(result.errors[0]).toMatchObject({
      stage: "verify",
      code: "internal_inconsistency",
    });
    expect(result.errors[0]?.message).toContain("bug in FlowForge");
  });

  it("catches a target that lowers to IR stamped for someone else", () => {
    const confused = fakeTarget({ key: "n8n", misstampIR: true });
    const result = compile(onboardingExample, registry, confused);

    if (result.ok) throw new Error("expected a failure");
    expect(result.errors[0]).toMatchObject({ stage: "verify" });
  });
});

describe("warnings", () => {
  function degradedRegistry(): Registry {
    const forTarget = new Map(registry.bindings.get("n8n"));
    forTarget.set("slack.message.send", null);
    return { ...registry, bindings: new Map([["n8n", forTarget]]) };
  }

  it("reach the caller on a successful compile", () => {
    const result = compile(onboardingExample, degradedRegistry(), target);
    expect(result.ok).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "capability_degraded",
      "capability_degraded",
    ]);
  });

  it("survive a failure at a later stage", () => {
    // A run that dies at stage 4 still learned at stage 2 that two nodes
    // degraded. Discarding that means the user is told only on their next
    // attempt.
    const result = compile(onboardingExample, degradedRegistry(), linearTarget);

    expect(result.ok).toBe(false);
    expect(result.warnings.map((warning) => warning.code)).toContain("capability_degraded");
  });

  it("show the degraded node compiling through the HTTP fallback", () => {
    const result = compile(onboardingExample, degradedRegistry(), target);
    if (!result.ok) throw new Error("expected success");

    const emitted = JSON.parse(result.value.content) as FakeIR;
    const degraded = emitted.nodes.filter((node) => node.degraded);
    expect(degraded).toHaveLength(2);
    expect(degraded.every((node) => node.capability === HTTP_FALLBACK_CAPABILITY)).toBe(true);
  });

  it("include a target's own warnings, raised through the context", () => {
    const chatty = fakeTarget({ key: "n8n" });
    const lower = chatty.lower.bind(chatty);
    const result = compile(onboardingExample, registry, {
      ...chatty,
      lower(graph, ctx) {
        ctx.warn({ code: "loop_bound_advisory", nodeId: "n_trigger", message: "advisory" });
        return lower(graph, ctx);
      },
    });

    expect(result.warnings.map((warning) => warning.code)).toEqual(["loop_bound_advisory"]);
  });
});

describe("compileToGraph", () => {
  it("runs stages 1 to 3 without naming a target implementation", () => {
    // The M7 renderers need defaults applied and expressions parsed. Asking
    // them to nominate an export platform to get a mermaid diagram would be
    // backwards.
    const result = compileToGraph(onboardingExample, registry, "n8n");
    if (!result.ok) throw new Error("expected success");
    expect(result.value.nodes).toHaveLength(5);
  });

  it("does not apply the capability check, having no capabilities to check", () => {
    const result = compileToGraph(loopDocument(), registry, "n8n");
    expect(result.ok).toBe(true);
  });

  it("fails on an invalid document", () => {
    expect(compileToGraph({ nope: true }, registry, "n8n").ok).toBe(false);
  });
});

describe("determinism", () => {
  it("compiles twice to byte-identical output", () => {
    const first = compile(onboardingExample, registry, target);
    const second = compile(onboardingExample, registry, target);

    if (!first.ok || !second.ok) throw new Error("expected success");
    expect(first.value.content).toBe(second.value.content);
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

    const original = compile(onboardingExample, registry, target);
    const reordered = compile(shuffled, registry, target);
    if (!original.ok || !reordered.ok) throw new Error("expected success");

    expect(reordered.value.content).toBe(original.value.content);
  });

  it("produces the same warnings in the same order", () => {
    const forTarget = new Map(registry.bindings.get("n8n"));
    forTarget.set("slack.message.send", null);
    const degraded: Registry = { ...registry, bindings: new Map([["n8n", forTarget]]) };

    expect(compile(onboardingExample, degraded, target).warnings).toEqual(
      compile(onboardingExample, degraded, target).warnings,
    );
  });

  it("does not mutate the document or the registry", () => {
    const doc = structuredClone(onboardingExample);
    const before = structuredClone(onboardingExample);
    const registryBefore = registry.version;

    compile(doc, registry, target);

    expect(doc).toEqual(before);
    expect(registry.version).toBe(registryBefore);
  });
});

describe("purity", () => {
  it("reaches for no clock, no randomness, and no filesystem", async () => {
    // Determinism is what makes golden-file testing work, and golden files are
    // what make a compiler's otherwise silent bugs visible. A source-level ban
    // is crude, and it is also the check that fails on the pull request rather
    // than six months later on a flaky diff.
    // `node:crypto` is deliberately not on this list. `createHash` is a pure
    // function of its input, which is the property that matters here, and it is
    // what makes node ids deterministic instead of random.
    const banned = [
      /\bDate\s*\./,
      /\bnew\s+Date\b/,
      /\bMath\s*\.\s*random\b/,
      /\brandomUUID\b/,
      /\bperformance\s*\.\s*now\b/,
      /\bprocess\s*\.\s*env\b/,
      /from\s+"node:fs/,
    ];

    for (const name of SOURCE_FILES) {
      const source = code(await readFile(sourceFile(name), "utf8"));
      for (const pattern of banned) {
        expect(pattern.test(source), `${name} matches ${pattern}`).toBe(false);
      }
    }
  });
});

describe("the dependency rule", () => {
  it("does not depend on the AI layer", async () => {
    // Both depend on `ffir` and `registry`; neither depends on the other. With
    // a strict node linker, an import the manifest does not declare fails to
    // resolve at build time rather than at review time, so the manifest is the
    // thing that actually enforces this.
    const manifest = await import("../package.json", { with: { type: "json" } });
    expect(Object.keys(manifest.default.dependencies)).toEqual([
      "@flowforge/ffir",
      "@flowforge/registry",
    ]);
  });

  it("imports the AI layer in no source file", async () => {
    // Matches an import rather than a mention: the package comment names
    // `@flowforge/ai` precisely to say it must never be imported, and a check
    // that failed on its own documentation would be deleted rather than fixed.
    const importsAi = /(?:from|import|require)\s*\(?\s*["']@flowforge\/ai["']/;

    for (const name of SOURCE_FILES) {
      const source = code(await readFile(sourceFile(name), "utf8"));
      expect(importsAi.test(source), name).toBe(false);
    }
  });

  it("keeps n8n's vocabulary inside the n8n target", async () => {
    // The design goal the whole architecture is subordinate to. If a platform's
    // node types leak into the shared stages, "adding Make.com touches one
    // directory" stops being true, and it stops being true quietly.
    for (const name of SOURCE_FILES.filter((file) => !file.startsWith("targets/"))) {
      const source = code(await readFile(sourceFile(name), "utf8"));
      expect(source.includes("n8n-nodes-base"), name).toBe(false);
    }
  });
});

describe("helpers", () => {
  it("slugs a workflow name into a file name", () => {
    expect(fileNameFor(onboardingExample, target)).toBe("employee-onboarding.json");
  });

  it("falls back to the document id when the name slugs to nothing", () => {
    const doc = cloneOnboarding();
    doc.name = "!!!";
    expect(fileNameFor(doc, target)).toBe("wf_01HQ8XONBOARD.json");
  });

  it("describes an error without a message of its own", () => {
    expect(
      describeCompileError({
        stage: "verify",
        code: "internal_inconsistency",
        detail: "dangling connection",
      }),
    ).toContain("bug in FlowForge");
  });

  it("finds the node an error points at, and reports none when there is none", () => {
    expect(
      nodeIdOf({ stage: "lower", code: "unsupported_feature", feature: "loops", nodeId: "n_x" }),
    ).toBe("n_x");
    expect(
      nodeIdOf({ stage: "emit", code: "target_limit_exceeded", detail: "too big" }),
    ).toBeUndefined();
  });
});

describe("edge cases", () => {
  it("compiles a workflow with parallel branches", () => {
    const result = compile(parallelDocument(), registry, target);
    if (!result.ok) throw new Error("expected success");

    const emitted = JSON.parse(result.value.content) as FakeIR;
    expect(emitted.connections).toHaveLength(2);
  });

  it("compiles a workflow with a loop, back-edge included", () => {
    const result = compile(loopDocument(), registry, target);
    if (!result.ok) throw new Error("expected success");

    const emitted = JSON.parse(result.value.content) as FakeIR;
    expect(emitted.connections.map((connection) => connection.port)).toEqual([
      "main",
      "each",
      "main",
      "done",
    ]);
  });

  it("rejects a non-object input rather than throwing", () => {
    for (const input of [null, undefined, 42, "a string", []]) {
      expect(compile(input, registry, target).ok, JSON.stringify(input)).toBe(false);
    }
  });
});
