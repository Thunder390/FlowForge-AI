/**
 * A recorded generation of the BambooHR onboarding example.
 *
 * The same workflow WORKFLOW_SCHEMA.md works through and every other package
 * tests against, this time arrived at from a sentence rather than hand-written.
 * That is the point of the fixture: it proves the generation path produces the
 * document the rest of the system already knows how to compile and render.
 *
 * ## How the recordings match
 *
 * A recording is keyed by a digest of the request, and the request here is
 * built by calling the same `buildPlanRequest` and `buildParametersRequest` the
 * orchestrator calls. So the fixture matches by construction and there is no
 * hash to keep in sync by hand.
 *
 * The trade that makes is deliberate: a prompt edit changes the request, the
 * fixture's digest changes with it, and replay keeps working. Prompt drift is
 * therefore *not* caught here. It is caught by `prompts.test.ts`, which pins
 * the rendered text directly, which is a better place for it: a prompt change
 * should fail the test that is about prompts, not every test that happens to
 * generate something.
 *
 * ## The recorded output is the shape the schema demands, not a tidy version
 *
 * `thread_ts: ""` appears on both Slack steps because the synthesized schema
 * requires the key: the parameter is optional in the registry, has no default,
 * and is a plain string, so the empty sentinel is legal and the closed shape
 * asks for it. Writing the fixture without it would test a document the model
 * cannot actually produce.
 */

import { loadFixtureRegistry } from "@flowforge/registry/fixtures";
import type { Registry } from "@flowforge/registry";

import { buildParametersRequest } from "../passes/parameters.js";
import type { NodeParameters } from "../passes/parameters.js";
import { buildPlanRequest, type WorkflowPlan } from "../passes/plan.js";
import { ReplayProvider, type RecordedExchange } from "../provider/replay.js";
import { InlineRetriever } from "../retrieval/inline.js";
import type { CapabilityRetriever } from "../retrieval/types.js";

/** The sentence a user would actually type. */
export const ONBOARDING_PROMPT =
  "When a new employee is added in BambooHR, build their work email from their name and our company domain, create their Google Workspace account, and announce them in #general on Slack. If the account creation fails, tell #it-alerts instead.";

/** Stable inputs so a generated document is comparable across runs. */
export const ONBOARDING_DOCUMENT_ID = "wf_01HQ8XONBOARD";
export const ONBOARDING_GENERATED_AT = "2026-08-01T00:00:00Z";

/** What pass A returns. */
export const ONBOARDING_PLAN: WorkflowPlan = {
  name: "Employee onboarding",
  description:
    "When BambooHR records a new hire, create their Google Workspace account and announce them in Slack.",
  nodes: [
    {
      id: "n_trigger",
      kind: "trigger",
      capability: "bamboohr.employee.created",
      label: "New employee in BambooHR",
      notes: "",
      capability_scope: "bamboohr",
      on_error: "stop",
      retry_attempts: 0,
    },
    {
      id: "n_build_email",
      kind: "transform",
      capability: "core.transform.map",
      label: "Build the email address",
      notes: "",
      capability_scope: "",
      on_error: "stop",
      retry_attempts: 0,
    },
    {
      id: "n_create_account",
      kind: "action",
      capability: "google_workspace.user.create",
      label: "Create Google Workspace account",
      notes:
        "A failure here is silent and expensive: the hire has no account and nobody finds out until their first day, so it routes to a step that tells IT.",
      capability_scope: "google_workspace",
      on_error: "route",
      retry_attempts: 2,
    },
    {
      id: "n_slack_welcome",
      kind: "action",
      capability: "slack.message.send",
      label: "Announce in Slack",
      notes: "",
      capability_scope: "slack",
      on_error: "stop",
      retry_attempts: 0,
    },
    {
      id: "n_alert_it",
      kind: "error_handler",
      capability: "slack.message.send",
      label: "Alert IT on failure",
      notes: "",
      capability_scope: "slack",
      on_error: "stop",
      retry_attempts: 0,
    },
  ],
  edges: [
    edge("e_1", "n_trigger", "n_build_email"),
    edge("e_2", "n_build_email", "n_create_account"),
    edge("e_3", "n_create_account", "n_slack_welcome"),
    edge("e_4", "n_create_account", "n_alert_it", "error"),
  ],
  variables: [
    {
      id: "company_domain",
      label: "Company email domain",
      description: "Domain for new employee email addresses.",
      type: "string",
      required: true,
      sensitive: false,
      default: "example.com",
    },
    {
      id: "temp_password",
      label: "Temporary password",
      description: "Initial password. Users must change it at first login.",
      type: "string",
      required: true,
      sensitive: true,
      default: "",
    },
  ],
};

/** What pass B returns, keyed by node id exactly as the synthesized schema shapes it. */
export const ONBOARDING_PARAMETERS: NodeParameters = {
  n_trigger: { poll_interval_minutes: 15 },
  n_build_email: {
    assignments: [
      {
        field: "email",
        value:
          "{{ n_trigger.employee.first_name }}.{{ n_trigger.employee.last_name }}@{{ $vars.company_domain }}",
      },
    ],
    include_other_fields: true,
  },
  n_create_account: {
    primary_email: "{{ n_build_email.email }}",
    given_name: "{{ n_trigger.employee.first_name }}",
    family_name: "{{ n_trigger.employee.last_name }}",
    password: "{{ $vars.temp_password }}",
    change_password_at_next_login: true,
    org_unit_path: "/",
  },
  n_slack_welcome: {
    channel: "#general",
    text: "Welcome {{ n_trigger.employee.first_name }} to the team. Their account is {{ n_build_email.email }}.",
    thread_ts: "",
  },
  n_alert_it: {
    channel: "#it-alerts",
    text: "Account creation failed for {{ n_trigger.employee.first_name }}. Needs manual setup.",
    thread_ts: "",
  },
};

export interface OnboardingFixture {
  registry: Registry;
  retriever: CapabilityRetriever;
  provider: ReplayProvider;
  prompt: string;
  plan: WorkflowPlan;
  parameters: NodeParameters;
  exchanges: RecordedExchange[];
}

/**
 * The fixture, assembled against the real registry.
 *
 * Built fresh per call rather than cached, because `ReplayProvider.calls`
 * records what it was asked for and a shared provider would let one test see
 * another's requests.
 */
export async function onboardingFixture(): Promise<OnboardingFixture> {
  const registry = await loadFixtureRegistry();
  const retriever = new InlineRetriever();

  const planRequest = buildPlanRequest({
    prompt: ONBOARDING_PROMPT,
    registry,
    retriever,
  });

  const parameters = buildParametersRequest({
    plan: ONBOARDING_PLAN,
    prompt: ONBOARDING_PROMPT,
    registry,
    retriever,
  });

  const exchanges: RecordedExchange[] = [
    {
      id: "onboarding/pass-a",
      request: planRequest,
      // Pretty-printed because that is what a model actually emits, and
      // because a recording is meant to be readable in a diff.
      response: { text: JSON.stringify(ONBOARDING_PLAN, null, 2) },
    },
    {
      id: "onboarding/pass-b",
      request: parameters.request,
      response: { text: JSON.stringify(ONBOARDING_PARAMETERS, null, 2) },
    },
  ];

  return {
    registry,
    retriever,
    provider: new ReplayProvider(exchanges),
    prompt: ONBOARDING_PROMPT,
    plan: ONBOARDING_PLAN,
    parameters: ONBOARDING_PARAMETERS,
    exchanges,
  };
}

function edge(
  id: string,
  from: string,
  to: string,
  port = "",
): WorkflowPlan["edges"][number] {
  return {
    id,
    from,
    to,
    port,
    condition_left: "",
    condition_operator: "none",
    condition_right: "",
  };
}
