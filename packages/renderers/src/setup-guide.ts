/**
 * FFIR plus the registry to Markdown a person follows.
 *
 * The setup guide is a walk over `credentials` and `variables` joined against
 * the registry, plus whatever the compiler recorded in `metadata.warnings`. It
 * is the one artifact whose audience is entirely non-technical, so it is
 * written in the second person and never names a node id.
 *
 * ## What it must say, and why
 *
 * Every credential, with its auth type, the scopes it needs, and the registry's
 * `setup_notes`. The scopes matter: they are the union of `required_scopes`
 * across every capability using that scope, so the guide asks for exactly the
 * permissions the workflow needs and no more. A user granting broad access
 * because the guide could not tell them what was actually required is a real
 * security cost, and it is avoidable by joining data we already hold.
 *
 * Every degraded node, because the export contains a step that will not work
 * until they finish it by hand. COMPILER_ARCHITECTURE requires this to be an
 * explicit section rather than a footnote.
 *
 * Every sensitive variable as a checklist item with no value, since a sensitive
 * variable is forbidden from carrying a default and the user has to supply one.
 */

import type { CredentialRef, FFIRDocument, Variable, Warning } from "@flowforge/ffir";
import { resolve, type AuthDefinition, type Registry } from "@flowforge/registry";

import { readingOrder } from "./order.js";

export interface SetupGuideOptions {
  /** Heading level the document starts at. Default 1. */
  baseLevel?: number;
}

/** What the guide knows about one credential, after the registry join. */
export interface CredentialGuide {
  credential: CredentialRef;
  integrationName: string;
  auth?: AuthDefinition;
  /** Union of `required_scopes` across the capabilities this workflow uses. */
  scopes: string[];
  setupNotes?: string;
  docsUrl?: string;
}

export function toSetupGuide(
  doc: FFIRDocument,
  registry: Registry,
  options: SetupGuideOptions = {},
): string {
  const level = options.baseLevel ?? 1;
  const h = (depth: number, text: string): string =>
    `${"#".repeat(Math.min(level + depth, 6))} ${text}`;

  const sections: string[] = [
    `${h(0, doc.name)}\n\n${doc.description}`,
    credentialsSection(doc, registry, h),
    variablesSection(doc, h),
    stepsSection(doc, h),
    warningsSection(doc, h),
    importSection(h),
  ].filter((section) => section !== "");

  return `${sections.join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Joins each credential against the registry.
 *
 * The scopes come from the capabilities this workflow actually uses rather than
 * from everything the integration offers, which is what makes the permission
 * list minimal. A credential whose scope names no integration the registry has
 * still gets an entry: validation stage 2 rejects that document, so reaching
 * here means someone bypassed it, and a guide that silently omitted the
 * credential would leave the user with a workflow that cannot authenticate and
 * no clue why.
 */
export function credentialGuides(
  doc: FFIRDocument,
  registry: Registry,
): CredentialGuide[] {
  return doc.credentials.map((credential) => {
    const integration = registry.integrations.get(credential.capability_scope);

    const scopes = new Set<string>(credential.required_scopes ?? []);
    for (const node of doc.nodes) {
      if (node.credential !== credential.id) continue;
      const resolved = resolve(registry, node.capability);
      for (const scope of resolved?.capability.required_scopes ?? []) scopes.add(scope);
    }

    const auth = integration?.auth.find(
      (candidate) => candidate.type === credential.auth_type,
    );

    return {
      credential,
      integrationName: integration?.display_name ?? credential.capability_scope,
      ...(auth === undefined ? {} : { auth }),
      scopes: [...scopes].sort(compare),
      ...(auth?.setup_notes === undefined ? {} : { setupNotes: auth.setup_notes }),
      ...(integration?.docs_url === undefined ? {} : { docsUrl: integration.docs_url }),
    };
  });
}

function credentialsSection(
  doc: FFIRDocument,
  registry: Registry,
  h: (depth: number, text: string) => string,
): string {
  const guides = credentialGuides(doc, registry);
  if (guides.length === 0) return "";

  const parts = [
    h(1, "Connect your accounts"),
    `This workflow needs ${count(guides.length, "account")}. Connect each one in n8n before running it. Nothing is filled in for you: the export deliberately ships with empty credentials so it cannot carry a secret.`,
  ];

  for (const guide of guides) {
    const lines = [h(2, guide.credential.label), `- **Service:** ${guide.integrationName}`];
    lines.push(`- **Sign in with:** ${describeAuth(guide.credential.auth_type)}`);

    lines.push(
      guide.scopes.length === 0
        ? "- **Permissions:** none beyond basic access"
        : `- **Permissions:** ${guide.scopes.map((scope) => `\`${scope}\``).join(", ")}`,
    );

    if (guide.docsUrl !== undefined) lines.push(`- **Docs:** ${guide.docsUrl}`);
    if (guide.setupNotes !== undefined) lines.push(`\n${guide.setupNotes}`);

    parts.push(lines.join("\n"));
  }

  return parts.join("\n\n");
}

/** Auth types in the words the service itself uses. */
function describeAuth(type: CredentialRef["auth_type"]): string {
  switch (type) {
    case "oauth2":
      return "your account, through the service's sign-in screen";
    case "api_key":
      return "an API key you generate in the service's settings";
    case "basic":
      return "a username and password";
    case "webhook_secret":
      return "a shared secret you choose";
    case "none":
      return "nothing, this one needs no credentials";
  }
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

function variablesSection(
  doc: FFIRDocument,
  h: (depth: number, text: string) => string,
): string {
  const variables = doc.variables ?? [];
  if (variables.length === 0) return "";

  const rows = variables.map((variable) => {
    const cells = [
      `\`${variable.id}\``,
      describeVariable(variable),
      variable.required ? "yes" : "no",
      describeDefault(variable),
    ];
    return `| ${cells.join(" | ")} |`;
  });

  const parts = [
    h(1, "Fill in these values"),
    "These are the settings the workflow reads at run time.",
    ["| Setting | What it is | Required | Default |", "| --- | --- | --- | --- |", ...rows].join(
      "\n",
    ),
  ];

  const sensitive = variables.filter((variable) => variable.sensitive);
  if (sensitive.length > 0) {
    parts.push(
      [
        h(2, "Secrets to set yourself"),
        "These hold credentials or passwords. They are deliberately empty in the export and are never included in a shared or published copy, so you have to set each one after importing.",
        ...sensitive.map((variable) => `- [ ] **${variable.label}** (\`${variable.id}\`)`),
      ].join("\n\n"),
    );
  }

  return parts.join("\n\n");
}

/**
 * The label, plus the description when there is one.
 *
 * Both go in the table rather than the description going in a list underneath
 * it. A second list keyed by label makes the reader join two structures by eye
 * to answer one question, and it reads as orphaned text with no heading.
 */
function describeVariable(variable: Variable): string {
  return variable.description === undefined
    ? escapeCell(variable.label)
    : `${escapeCell(variable.label)}. ${escapeCell(variable.description)}`;
}

function describeDefault(variable: Variable): string {
  if (variable.sensitive) return "_none, you must set this_";
  return variable.default === undefined
    ? "_none_"
    : `\`${escapeCell(variable.default)}\``;
}

/**
 * A value safe inside a Markdown table cell.
 *
 * An unescaped pipe ends the cell, so a description containing one silently
 * shifts every column after it. Newlines end the row outright.
 */
function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

// ---------------------------------------------------------------------------
// Steps and warnings
// ---------------------------------------------------------------------------

/**
 * What the workflow does, in the order it does it.
 *
 * Node `notes` surface here, which WORKFLOW_SCHEMA gives as their purpose. The
 * list is numbered from the trigger rather than following the document's node
 * order, because FFIR's node array is explicitly unordered.
 */
function stepsSection(
  doc: FFIRDocument,
  h: (depth: number, text: string) => string,
): string {
  const nodes = readingOrder(doc);
  if (nodes.length === 0) return "";

  const steps = nodes.map((node, index) => {
    const note = node.notes === undefined ? "" : `\n   ${node.notes}`;
    return `${index + 1}. **${node.label}**${note}`;
  });

  return [h(1, "What this workflow does"), steps.join("\n")].join("\n\n");
}

/**
 * The compiler's warnings, rendered as work the user has to do.
 *
 * `metadata.warnings` is where a degraded node ends up, and a degraded node is
 * an export that imports cleanly and does not work until someone finishes it.
 * Burying that would be the dishonest choice the architecture keeps arguing
 * against.
 */
function warningsSection(
  doc: FFIRDocument,
  h: (depth: number, text: string) => string,
): string {
  const warnings = doc.metadata?.warnings ?? [];
  if (warnings.length === 0) return "";

  const byNode = new Map(doc.nodes.map((node) => [node.id, node.label]));
  const items = warnings.map((warning: Warning) => {
    const where = warning.node_id === undefined ? undefined : byNode.get(warning.node_id);
    return where === undefined
      ? `- ${warning.message}`
      : `- **${where}:** ${warning.message}`;
  });

  return [
    h(1, "Check these before you rely on it"),
    "Some steps could not be exported exactly as described. Each one still imports, but needs a look.",
    items.join("\n"),
  ].join("\n\n");
}

function importSection(h: (depth: number, text: string) => string): string {
  return [
    h(1, "Import it"),
    [
      "1. In n8n, open **Workflows**, then the **...** menu, then **Import from File**.",
      "2. Choose the `.json` file that came with this guide.",
      "3. Open each step showing a warning triangle and pick the account you connected above.",
      "4. Run it once with test data before switching it on.",
    ].join("\n"),
  ].join("\n\n");
}

function count(n: number, noun: string): string {
  return n === 1 ? `one ${noun}` : `${n} ${noun}s`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
