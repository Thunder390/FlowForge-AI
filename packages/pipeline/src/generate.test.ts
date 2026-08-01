/**
 * The milestone's own "done when": a recorded fixture set drives a full
 * generation to validated FFIR with no live model call.
 *
 * The assertions are about the document, not about the mechanics of getting
 * there. A generation that emits the right events and produces a document the
 * validator rejects has failed, and a test that checked the events would say it
 * passed.
 */

import { onboardingFixture, ONBOARDING_DOCUMENT_ID, ONBOARDING_GENERATED_AT } from "@flowforge/ai/fixtures";
import { compile } from "@flowforge/compiler";
import { n8nTarget } from "@flowforge/compiler";
import { validateWithoutRegistry } from "@flowforge/ffir";
import { describe, expect, it } from "vitest";

import { generate } from "./generate.js";
import { IMPLEMENTED_STAGES } from "./stages.js";
import type { GenerationEvent } from "./events.js";

async function run() {
  const fixture = await onboardingFixture();
  const events: GenerationEvent[] = [];

  const result = await generate({
    prompt: fixture.prompt,
    registry: fixture.registry,
    provider: fixture.provider,
    retriever: fixture.retriever,
    documentId: ONBOARDING_DOCUMENT_ID,
    generatedAt: ONBOARDING_GENERATED_AT,
    onEvent: (event) => events.push(event),
  });

  return { fixture, result, events };
}

describe("generating the onboarding workflow from a sentence", () => {
  it("produces a document that passes every validation stage", async () => {
    const { result, fixture } = await run();

    if (!result.ok) {
      throw new Error(
        `generation failed at ${result.stage}: ${result.failures.map((f) => f.message).join("; ")}`,
      );
    }

    // The generation already validated. Running the structural stages again
    // from the outside is the assertion that the pipeline did not simply
    // decline to check: a document that fails here would mean `generate`
    // returned ok on something invalid.
    expect(validateWithoutRegistry(result.document).errors).toEqual([]);
    expect(result.document.nodes.map((node) => node.id)).toEqual([
      "n_trigger",
      "n_build_email",
      "n_create_account",
      "n_slack_welcome",
      "n_alert_it",
    ]);
    expect(fixture.provider.calls).toHaveLength(2);
  });

  it("reaches the same graph the hand-written worked example describes", async () => {
    const { result } = await run();
    if (!result.ok) throw new Error("generation failed");

    const trigger = result.document.nodes.find((node) => node.kind === "trigger");
    expect(trigger?.capability).toBe("bamboohr.employee.created");

    // The error edge is the part a model most often forgets, and rule 17 is
    // what would catch it. Asserting it directly says the fixture exercises
    // the interesting shape rather than a linear chain.
    expect(
      result.document.edges.some(
        (edge) => edge.port === "error" && edge.from === "n_create_account",
      ),
    ).toBe(true);
    expect(
      result.document.nodes.find((node) => node.id === "n_create_account")?.error_policy,
    ).toEqual({
      on_error: "route",
      retry: { attempts: 2, backoff: "exponential", initial_delay_ms: 2000 },
    });
  });

  it("derives credentials from the registry rather than from the model", async () => {
    const { result } = await run();
    if (!result.ok) throw new Error("generation failed");

    expect(result.document.credentials).toEqual([
      {
        id: "cred_bamboohr",
        capability_scope: "bamboohr",
        auth_type: "api_key",
        label: "BambooHR API key",
      },
      {
        id: "cred_google_workspace",
        capability_scope: "google_workspace",
        auth_type: "oauth2",
        label: "Google Workspace admin",
        required_scopes: ["https://www.googleapis.com/auth/admin.directory.user"],
      },
      {
        id: "cred_slack",
        capability_scope: "slack",
        auth_type: "oauth2",
        label: "Slack OAuth2",
        required_scopes: ["chat:write"],
      },
    ]);

    // `core.transform.map` needs no credential, so its node carries no
    // reference. A blanket "every node gets one" would fail rule 10.
    expect(
      result.document.nodes.find((node) => node.id === "n_build_email")?.credential,
    ).toBeUndefined();
  });

  it("strips the default from a variable it marks sensitive", async () => {
    const { result } = await run();
    if (!result.ok) throw new Error("generation failed");

    const secret = result.document.variables?.find((v) => v.id === "temp_password");
    expect(secret?.sensitive).toBe(true);
    expect(secret?.default).toBeUndefined();

    const ordinary = result.document.variables?.find((v) => v.id === "company_domain");
    expect(ordinary?.sensitive).toBe(false);
    expect(ordinary?.default).toBe("example.com");
  });

  it("stamps metadata that can identify what produced it", async () => {
    const { result } = await run();
    if (!result.ok) throw new Error("generation failed");

    const metadata = result.document.metadata ?? {};
    expect(metadata["generated_by"]).toBe("claude-opus-5");
    expect(metadata["generated_at"]).toBe(ONBOARDING_GENERATED_AT);
    expect(metadata["registry_version"]).toBe("n8n@1.62.0+overlay.3");
    expect(metadata["prompt_version"]).toBe("pass_a@1+pass_b@1");
    // The prompt is correlated by hash and never stored verbatim.
    expect(metadata["source_prompt_hash"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: two runs produce byte-identical documents", async () => {
    const first = await run();
    const second = await run();
    if (!first.result.ok || !second.result.ok) throw new Error("generation failed");

    expect(JSON.stringify(second.result.document)).toBe(
      JSON.stringify(first.result.document),
    );
  });

  it("emits exactly the stages this build declares it runs", async () => {
    const { events } = await run();
    const seen: string[] = [];
    for (const event of events) {
      if (seen[seen.length - 1] !== event.stage) seen.push(event.stage);
    }
    expect(seen).toEqual([...IMPLEMENTED_STAGES]);
  });

  it("reports node labels while pass A is still streaming", async () => {
    const { events } = await run();
    const planning = events
      .filter((event) => event.stage === "plan" && event.text.startsWith("Planning"))
      .map((event) => event.text);

    // One per node, in document order, and produced from the stream rather
    // than after it: a timer could not know the labels.
    expect(planning).toEqual([
      'Planning "New employee in BambooHR"...',
      'Planning "Build the email address"...',
      'Planning "Create Google Workspace account"...',
      'Planning "Announce in Slack"...',
      'Planning "Alert IT on failure"...',
    ]);
  });

  it("warns about the parameter the closed schema cannot describe", async () => {
    const { result } = await run();
    if (!result.ok) throw new Error("generation failed");

    // `slack.message.send` declares `blocks` as an array of objects with no
    // fields. A closed schema cannot express one, so the model is never asked
    // for it and the loss is stated rather than silent.
    const dropped = result.warnings.filter((warning) =>
      warning.message.includes("blocks"),
    );
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.every((warning) => warning.code === "capability_degraded")).toBe(true);
  });
});

describe("the generated document is exportable", () => {
  /**
   * Not the compile dry-run gate, which is stage 5 and M9. This asserts the
   * weaker and still useful thing: what generation produces is something the
   * compiler accepts today, so M9 is wiring rather than discovery.
   */
  it("compiles to n8n without errors", async () => {
    const { result, fixture } = await run();
    if (!result.ok) throw new Error("generation failed");

    const compiled = compile(result.document, fixture.registry, n8nTarget);
    if (!compiled.ok) {
      throw new Error(compiled.errors.map((error) => error.message).join("; "));
    }
    expect(JSON.parse(compiled.value.content)).toMatchObject({ name: "Employee onboarding" });
  });
});
