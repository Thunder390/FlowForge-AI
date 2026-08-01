import { cloneOnboarding, onboardingExample } from "@flowforge/ffir/fixtures";
import { loadFixtureRegistry } from "@flowforge/registry/fixtures";
import { describe, expect, it } from "vitest";

import { credentialGuides, toSetupGuide } from "./setup-guide.js";

const registry = await loadFixtureRegistry();
const guide = toSetupGuide(onboardingExample, registry);

/** The body of one `##` section, so an assertion cannot pass on a stray match elsewhere. */
function section(source: string, heading: string): string {
  const parts = source.split(`## ${heading}`);
  if (parts.length < 2) return "";
  return (parts[1] ?? "").split("\n## ")[0] ?? "";
}

describe("the document", () => {
  it("opens with the workflow's name and description", () => {
    expect(guide.startsWith("# Employee onboarding\n")).toBe(true);
    expect(guide).toContain(onboardingExample.description);
  });

  it("can start at a deeper heading level, for embedding in a page", () => {
    const nested = toSetupGuide(onboardingExample, registry, { baseLevel: 2 });
    expect(nested.startsWith("## Employee onboarding\n")).toBe(true);
    expect(nested).toContain("### Connect your accounts");
  });
});

describe("credentials", () => {
  it("lists all three, which is what the milestone asks for", () => {
    const body = section(guide, "Connect your accounts");
    expect(body).toContain("BambooHR API key");
    expect(body).toContain("Google Workspace admin");
    expect(body).toContain("Slack workspace");
  });

  it("gives each one its scopes", () => {
    const body = section(guide, "Connect your accounts");
    expect(body).toContain("`chat:write`");
    expect(body).toContain("`https://www.googleapis.com/auth/admin.directory.user`");
  });

  it("asks for exactly the scopes the workflow uses, not everything Slack offers", () => {
    // The registry declares five Slack scopes. This workflow only sends
    // messages, so the guide must not ask the user to grant channel management.
    const slack = credentialGuides(onboardingExample, registry).find(
      (entry) => entry.credential.id === "cred_slack",
    );
    expect(slack?.scopes).toEqual(["chat:write"]);
  });

  it("widens the scope list when a second capability needs more", () => {
    const doc = cloneOnboarding();
    doc.nodes[3]!.capability = "slack.channel.create";
    doc.nodes[3]!.parameters = { name: "onboarding" };

    const slack = credentialGuides(doc, registry).find(
      (entry) => entry.credential.id === "cred_slack",
    );
    expect(slack?.scopes).toEqual(["channels:manage", "chat:write"]);
  });

  it("says so plainly when a credential needs no extra permissions", () => {
    expect(section(guide, "Connect your accounts")).toContain(
      "none beyond basic access",
    );
  });

  it("renders the registry's setup notes verbatim, since they are written for the user", () => {
    expect(guide).toContain("In BambooHR, open your profile menu, choose API Keys");
  });

  it("describes the auth type in words rather than as a code", () => {
    const body = section(guide, "Connect your accounts");
    expect(body).toContain("an API key you generate in the service's settings");
    expect(body).toContain("your account, through the service's sign-in screen");
    expect(body).not.toContain("oauth2");
  });

  it("promises the export carries no secret", () => {
    expect(section(guide, "Connect your accounts")).toContain("cannot carry a secret");
  });

  it("still lists a credential whose scope the registry does not know", () => {
    // Validation stage 2 rejects that document, so reaching here means someone
    // bypassed it. Omitting the credential would leave the user unable to
    // authenticate with no clue why.
    const doc = cloneOnboarding();
    doc.credentials[2]!.capability_scope = "mattermost";

    expect(toSetupGuide(doc, registry)).toContain("Slack workspace");
  });
});

describe("variables", () => {
  it("tabulates each one with whether it is required and its default", () => {
    const body = section(guide, "Fill in these values");
    expect(body).toContain("| `company_domain` |");
    expect(body).toContain("`example.com`");
  });

  it("folds the description into the table rather than leaving a floating list", () => {
    expect(section(guide, "Fill in these values")).toContain(
      "Company email domain. Domain for new employee email addresses.",
    );
  });

  it("gives a sensitive variable a checklist item and no value", () => {
    // A sensitive variable is forbidden a default, so the user has to supply
    // one and the guide has to make that an action rather than a footnote.
    const body = section(guide, "Fill in these values");
    expect(body).toContain("- [ ] **Temporary password** (`temp_password`)");
    expect(body).toContain("_none, you must set this_");
  });

  it("escapes a pipe, which would otherwise shift every column after it", () => {
    const doc = cloneOnboarding();
    doc.variables![0]!.description = "Either a | or a comma";

    expect(toSetupGuide(doc, registry)).toContain("Either a \\| or a comma");
  });

  it("omits the section entirely when there are no variables", () => {
    const doc = cloneOnboarding();
    doc.variables = [];
    doc.nodes[1]!.parameters = { assignments: [{ field: "email", value: "a@b.c" }] };
    doc.nodes[2]!.parameters = { ...doc.nodes[2]!.parameters, password: "set-by-hand" };

    expect(toSetupGuide(doc, registry)).not.toContain("Fill in these values");
  });
});

describe("steps", () => {
  it("numbers them from the trigger rather than in document order", () => {
    const body = section(guide, "What this workflow does");
    expect(body).toContain("1. **New employee in BambooHR**");
    expect(body).toContain("2. **Build the email address**");
  });

  it("surfaces a node's notes, which is what WORKFLOW_SCHEMA gives them for", () => {
    const doc = cloneOnboarding();
    doc.nodes[3]!.notes = "Posts during working hours only.";

    expect(toSetupGuide(doc, registry)).toContain("Posts during working hours only.");
  });
});

describe("warnings", () => {
  function withWarning(): ReturnType<typeof cloneOnboarding> {
    const doc = cloneOnboarding();
    doc.metadata = {
      ...doc.metadata,
      warnings: [
        {
          code: "capability_degraded",
          node_id: "n_slack_welcome",
          message: "n8n cannot do this natively; exported as an HTTP request.",
        },
      ],
    };
    return doc;
  }

  it("gets its own section, not a footnote", () => {
    // A degraded node is an export that imports cleanly and does not work until
    // someone finishes it. Burying that is the dishonest choice.
    expect(toSetupGuide(withWarning(), registry)).toContain(
      "## Check these before you rely on it",
    );
  });

  it("names the step by its label rather than its node id", () => {
    const body = section(toSetupGuide(withWarning(), registry), "Check these before you rely on it");
    expect(body).toContain("**Announce in Slack:**");
    expect(body).not.toContain("n_slack_welcome");
  });

  it("renders a warning that names no node", () => {
    const doc = cloneOnboarding();
    doc.metadata = {
      ...doc.metadata,
      warnings: [{ code: "policy_unsupported", message: "Retries are approximate." }],
    };
    expect(toSetupGuide(doc, registry)).toContain("- Retries are approximate.");
  });

  it("omits the section when there is nothing to warn about", () => {
    expect(guide).not.toContain("Check these before you rely on it");
  });
});

describe("import instructions", () => {
  it("tells the user how to get the file into n8n", () => {
    expect(guide).toContain("Import from File");
    expect(guide).toContain("Run it once with test data");
  });
});

describe("determinism", () => {
  it("renders identically on repeated calls", () => {
    expect(toSetupGuide(onboardingExample, registry)).toBe(guide);
  });

  it("does not mutate the document", () => {
    const before = structuredClone(onboardingExample);
    toSetupGuide(onboardingExample, registry);
    expect(onboardingExample).toEqual(before);
  });
});
