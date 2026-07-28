# Node Registry

The registry is the grounding layer. It is the only place in FlowForge that
knows what a real integration actually accepts, and it is the single mechanism
preventing Claude from inventing node parameters.

If the registry is wrong, everything downstream is confidently wrong. Treat it
as the highest-integrity data in the system.

## What It Does

The registry answers four questions, and every consumer asks a different one:

| Consumer | Question |
| --- | --- |
| AI layer, pass A | What capabilities exist for the apps this user mentioned? |
| AI layer, pass B | What parameters does `slack.message.send` take? |
| Validator | Is this parameter object legal for this capability? |
| Compiler | How does `slack.message.send` become an n8n node? |

One data structure serves all four. That is the point: a single definition of
truth means the model, the validator, and the compiler cannot disagree.

## Capability IDs

The join key across the whole system.

```
<integration>.<resource>.<operation>
```

- **integration**: the app or service. `slack`, `google_sheets`, `bamboohr`.
- **resource**: the noun being acted on. `message`, `row`, `employee`.
- **operation**: the verb. `send`, `append`, `created`.

All segments are lowercase snake_case. The ID is stable forever. Renaming an
integration means adding an alias, never changing an existing ID, because
capability IDs appear in stored FFIR documents.

Two reserved namespaces:

- `core.*` for platform-agnostic primitives with no external integration:
  `core.transform.map`, `core.branch.if`, `core.merge.collect`,
  `core.wait.delay`, `core.loop.for_each`. Every target must implement all of
  these. They are the primitives FFIR itself depends on.
- `http.request.send` is the universal escape hatch. Any integration without a
  first-class entry lowers to a raw authenticated HTTP call on every platform.

## Artifact Layout

The built registry splits into two artifacts with different consumers, different
change rates, and different owners.

```
packages/registry/build/<version>/
├── capabilities/
│   ├── slack.json              AI-facing: params, outputs, aliases, auth
│   ├── google_sheets.json
│   └── ...
├── bindings/
│   ├── n8n/
│   │   ├── slack.json          compiler-facing, generated
│   │   └── ...
│   ├── make/
│   │   └── slack.json          compiler-facing, hand-curated
│   └── zapier/
└── index.json                  compact retrieval index for pass A
```

Three reasons this split matters, and all three get worse with scale:

1. **The AI layer never reads bindings.** Keeping them in the same file means
   loading platform implementation detail into a context budget that is already
   the binding constraint on capability coverage.
2. **Different writers.** The n8n bindings are machine-generated on every
   registry regeneration. The Make and Zapier bindings are hand-curated. Putting
   a generator's output and human curation in the same file guarantees eventual
   clobbering, and the overlay merge only protects the capability half.
3. **Adding a platform touches zero existing files.** A new target adds
   `bindings/<platform>/` and nothing else. With bindings inline, adding
   Node-RED edits every one of a thousand capability files.

Capability files and binding files join on capability ID. A binding file whose
capability ID has no capability file fails the build.

The rest of this document describes the entry *format*. Where an example shows
`bindings` alongside `parameters` for readability, understand that they are
stored as separate artifacts joined by ID.

## Registry Entry Shape

One capability file per integration, in `capabilities/<integration>.json`.

```json
{
  "integration": "slack",
  "display_name": "Slack",
  "description": "Team messaging and collaboration.",
  "categories": ["communication"],
  "aliases": ["slack workspace", "slack channel"],
  "docs_url": "https://api.slack.com/",
  "auth": [],
  "capabilities": [],
  "source": {
    "generated_from": "n8n-nodes-base@1.62.0",
    "generated_at": "2026-07-20T00:00:00Z",
    "overlay_version": 3
  }
}
```

`aliases` matters more than it looks. It is the retrieval index for pass A of
generation: when a user writes "post to our Slack channel", the resolver needs
to map that phrase to `slack`. Aliases are hand-curated, because the n8n package
does not carry the vocabulary real users type.

### Auth definitions

```json
{
  "auth": [
    {
      "id": "slack_oauth2",
      "type": "oauth2",
      "label": "Slack OAuth2",
      "default": true,
      "scopes_available": ["chat:write", "channels:read", "files:write"],
      "setup_notes": "Create a Slack app, add bot token scopes, install to workspace."
    },
    {
      "id": "slack_api_token",
      "type": "api_key",
      "label": "Slack bot token",
      "default": false,
      "field_hint": "Starts with xoxb-",
      "setup_notes": "Use OAuth2 unless you need a long-lived static token."
    }
  ]
}
```

`type` is one of `oauth2`, `api_key`, `basic`, `webhook_secret`, `none`. It maps
directly onto `credentials[].auth_type` in FFIR. `setup_notes` is rendered
verbatim into the generated setup guide, so it is written for the end user, not
for us.

### Capability definitions

The core of the registry.

```json
{
  "id": "slack.message.send",
  "kind": "action",
  "display_name": "Send a message",
  "description": "Posts a message to a channel, DM, or thread.",
  "aliases": ["send slack message", "post to slack", "notify in slack", "slack alert"],
  "auth_required": "slack_oauth2",
  "required_scopes": ["chat:write"],

  "parameters": {
    "channel": {
      "type": "string",
      "required": true,
      "description": "Channel name with #, user with @, or a channel ID.",
      "validation": { "pattern": "^([#@][a-z0-9._-]+|[CDG][A-Z0-9]{8,})$" },
      "example": "#general"
    },
    "text": {
      "type": "string",
      "required": true,
      "description": "Message body. Supports Slack mrkdwn.",
      "example": "Deploy finished successfully."
    },
    "thread_ts": {
      "type": "string",
      "required": false,
      "description": "Reply in a thread by passing the parent message timestamp."
    },
    "blocks": {
      "type": "array",
      "required": false,
      "description": "Slack Block Kit payload. Use instead of text for rich layouts.",
      "conditional_required": { "when": { "text": { "is_empty": true } } }
    }
  },

  "output": {
    "ok": { "type": "boolean" },
    "ts": { "type": "string", "description": "Message timestamp. Use for threading." },
    "channel": { "type": "string" }
  },

  "rate_limit": {
    "requests_per_minute": 60,
    "notes": "Slack Tier 3. Bursts are tolerated; sustained load is not."
  },

  "bindings": {
    "n8n": {
      "node_type": "n8n-nodes-base.slack",
      "type_version": 2.2,
      "static_parameters": { "resource": "message", "operation": "post" },
      "parameter_map": {
        "channel": "channel",
        "text": "text",
        "thread_ts": "otherOptions.thread_ts",
        "blocks": "blocksUi"
      },
      "credential_key": "slackOAuth2Api"
    },
    "make": {
      "module": "slack:CreateMessage",
      "parameter_map": { "channel": "channel", "text": "text" }
    },
    "zapier": {
      "app": "slack",
      "action": "channel_message",
      "parameter_map": { "channel": "channel", "text": "text" }
    }
  }
}
```

The four blocks do different jobs:

- **`parameters` and `output`** are what the AI layer sees. They are
  platform-neutral and phrased for a model to reason about.
- **`validation`** is what the validator enforces, identically to how the
  compiler will.
- **`bindings`** is what the compiler consumes. The AI layer never reads this
  block. That separation is what keeps the AI layer platform-agnostic.

### Parameter field reference

| Field | Purpose |
| --- | --- |
| `type` | `string`, `number`, `boolean`, `array`, `object`, `enum`, `datetime` |
| `required` | Hard requirement. Missing means compile failure. |
| `description` | Written for the model. This is prompt text; it earns its tokens. |
| `default` | Applied by the compiler when absent. |
| `example` | Shown to the model in pass B. Concrete examples cut error rate. |
| `validation` | See below. |
| `conditional_required` | Required only when another parameter has a given state. |
| `values` | For `enum`. The closed list of legal values. |
| `items` | For `array`. The element schema. |

### Validation rules as data

Validation lives in the registry as data, not as code, so the AI layer and the
compiler enforce exactly the same thing. Duplicating these as hand-written
TypeScript guards is how the two drift apart.

```json
{
  "validation": {
    "pattern": "^[#@][a-z0-9._-]+$",
    "min_length": 1,
    "max_length": 4000,
    "min": 0,
    "max": 100,
    "one_of": ["daily", "weekly", "monthly"],
    "not_empty": true
  }
}
```

Every rule carries a machine-readable failure code the repair prompt can consume
directly: `param_missing`, `param_type_mismatch`, `param_pattern_failed`,
`param_not_in_enum`, `param_out_of_range`, `param_conditional_missing`.

Note that these validation keywords are for **our** validator, not for Claude's
structured output schema. Claude's structured output mode does not support
`minLength`, `minimum`, or `pattern`, so the FFIR output schema cannot carry
them. That is fine: the model produces a structurally valid document and our
validator enforces the semantics, feeding failures back through the repair loop.
See AI_SPEC.md.

### Bindings and platform coverage

`bindings` is a map from platform key to that platform's implementation. A
capability may bind to some platforms and not others.

```json
{
  "bindings": {
    "n8n": { "node_type": "n8n-nodes-base.slack", "...": "..." },
    "make": { "module": "slack:CreateMessage", "...": "..." },
    "zapier": null
  }
}
```

An explicit `null` means "this platform genuinely cannot do this". A missing key
means "not yet mapped". The compiler treats them differently: `null` is a clean
degradation to `http.request.send` with a warning, while a missing key is a
registry gap that gets logged for us to fill.

**This is the mechanism that makes new platforms cheap.** Adding Make.com means
writing one compiler `Target` plus adding a `make` key to each capability. It
touches nothing in the AI layer, nothing in FFIR, and nothing in the validator.
That property is the entire justification for the registry's shape.

### Binding fields

| Field | Meaning |
| --- | --- |
| `node_type` | The platform's node identifier. |
| `type_version` | n8n node version. Pinned; bumping it is a deliberate act. |
| `static_parameters` | Platform params with fixed values, not from FFIR. |
| `parameter_map` | FFIR param name to platform path. Dots mean nesting. |
| `credential_key` | The platform's credential type name. |
| `transform` | Named transform function for params needing reshaping. |

`static_parameters` deserves a note. n8n's Slack node needs
`resource: "message"` and `operation: "post"` to mean "send a message". Those
are n8n implementation details with no FFIR equivalent, so they live here rather
than polluting FFIR with platform vocabulary.

When a parameter needs real reshaping rather than renaming, `transform` names a
function in the target's transform table:

```json
{
  "parameter_map": { "recipients": "toRecipients" },
  "transform": { "recipients": "array_to_comma_string" }
}
```

Transforms are a small closed set of named, unit-tested functions. Arbitrary
transform code in registry data would make the registry executable, and
generated registry data must never be executable.

## Trigger Capabilities

Triggers are capabilities with `kind: "trigger"` and one extra block:

```json
{
  "id": "bamboohr.employee.created",
  "kind": "trigger",
  "display_name": "New employee created",
  "trigger": {
    "mechanism": "polling",
    "poll_interval_minutes": { "default": 15, "min": 5 },
    "fallback": "webhook"
  }
}
```

`mechanism` is `webhook`, `polling`, `schedule`, or `manual`. When a platform
cannot support the preferred mechanism the compiler falls back and records a
`metadata.warnings` entry. BambooHR is the real example: it has no first-class
n8n trigger node, so it lowers to a generic webhook plus a setup-guide section
explaining how to configure the webhook on the BambooHR side. That degradation
is visible in the UI rather than silent.

## Generation Pipeline

Registry data is generated, not hand-written. Hand-writing several hundred
integrations is both infeasible and guaranteed to drift.

```
n8n-nodes-base@<pinned>       overlay/*.json
        |                            |
        v                            |
   introspect  --> raw/*.json        |
                        |            |
                        +-----> merge <-----+
                                  |
                                  v
                          data/*.json (built)
                                  |
                                  v
                        index.json (search index)
```

### Step 1: introspect

`tools/registry-gen` imports the pinned `n8n-nodes-base` package and reads each
node's exported `description` object, which carries `displayName`, `name`,
`version`, `credentials`, and the full `properties` array including
`displayOptions` (n8n's conditional-visibility rules). It emits raw JSON under
`packages/registry/raw/`.

The n8n package is a **build-time devDependency only**. It never ships in the
runtime bundle. What ships is the generated JSON.

### Step 2: derive capabilities

n8n models integrations as one node with `resource` and `operation` dropdowns.
FlowForge models them as flat capability IDs. The generator expands the
cross-product: the Slack node's `resource: [message, channel, file]` crossed
with each resource's operations becomes `slack.message.send`,
`slack.channel.create`, `slack.file.upload`, and so on.

Parameters are assigned to a capability by evaluating `displayOptions`: a
property visible when `resource=message, operation=post` belongs to
`slack.message.send`. This is the single most delicate part of the generator and
carries the densest test coverage.

### Step 3: apply the overlay

Generated data is mechanically correct and semantically thin. n8n descriptions
are written for a UI tooltip, not for a language model. The overlay adds what
the package cannot know.

```json
{
  "integration": "slack",
  "aliases": ["slack workspace", "team chat"],
  "capabilities": {
    "slack.message.send": {
      "aliases": ["notify in slack", "post to slack", "slack alert"],
      "description": "Posts a message to a channel, DM, or thread.",
      "parameters": {
        "channel": {
          "example": "#general",
          "description": "Channel name with #, user with @, or a channel ID."
        }
      },
      "rate_limit": { "requests_per_minute": 60, "notes": "Slack Tier 3." }
    }
  }
}
```

Merge is a deep merge with **overlay wins**. The overlay is sparse: it only
states what it improves. A generator re-run against a new n8n version picks up
new nodes automatically while preserving every piece of curation.

### Step 4: build the search index

`index.json` is a compact retrieval index: capability ID, display name, all
aliases, integration, category. It is small enough to hold in memory and to
inline into pass A of generation, where the model needs to know *what exists*
without needing to know *what parameters each thing takes*.

### Step 5: validate the build

The build fails, loudly, if any of the following hold:

1. A capability ID does not match `^[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+$`.
2. Two capabilities share an ID.
3. A capability has no `bindings` for the default target.
4. A `parameter_map` references a parameter not in `parameters`.
5. An `auth_required` names an auth definition that does not exist.
6. Any `core.*` capability lacks a binding for any registered target.
7. An alias collides across two different capabilities.

Rule 6 is the important one. `core.*` capabilities are what FFIR itself depends
on, so a target that cannot express `core.branch.if` cannot be a target at all,
and we want to learn that at build time rather than at compile time.

## Versioning

The registry version string is `n8n@<version>+overlay.<n>`, for example
`n8n@1.62.0+overlay.3`. It is stamped into every generated FFIR document's
`metadata.registry_version`.

### Registry builds are immutable published artifacts

A registry build is content-addressed, published under its version string, and
**never modified after publication**. The application can load more than one
version at a time.

This is not a nicety. Stored FFIR pins `metadata.registry_version`, and if that
version means "whatever shipped in the current deploy", then a registry bump
silently changes how every previously generated workflow recompiles. A user
re-exports a workflow they built three months ago and gets different output, with
no diff and no explanation. Once the public marketplace serves pages that must
render for years, the same problem becomes a broken product surface.

Concretely:

- Builds are published to object storage under `registry/<version>/`, not
  bundled into the application deploy.
- A worker loads a version once per process and caches it in memory. Registry
  data is large and immutable, which makes it ideal for an LRU across versions.
- Resolution order for a compile: the FFIR document's pinned version, then the
  current default if that pin is unavailable, with a warning attached.
- Retention: every version referenced by a stored workflow is retained. Versions
  referenced by nothing are prunable after a grace period.

Loading a version that does not exist is an error, never a silent fallback to
current.

- Bumping the pinned n8n version regenerates `raw/`, re-merges, and produces a
  diff for review. New capabilities appear. Removed capabilities are flagged.
- Editing the overlay bumps `overlay.<n>`.
- Capability IDs are never removed. A capability whose upstream node disappears
  is marked `"deprecated": true` with a `"replaced_by"` pointer, so old stored
  workflows still resolve and can be migrated with a clear message.

## Unknown Capability Policy

When the AI layer proposes a capability the registry does not contain, the
policy is layered and never involves guessing:

1. **Alias search.** Fuzzy-match the proposed ID and any surrounding label text
   against the alias index. A confident match is substituted and logged.
2. **Same-integration search.** If the integration segment resolves but the
   resource or operation does not, return the integration's full capability
   list to the model and ask it to pick. This is the common case and it repairs
   reliably.
3. **HTTP degradation.** If the integration itself is unknown, rewrite the node
   to `http.request.send` with a `metadata.warnings` entry of code
   `capability_unknown`. The UI surfaces this as a visible badge on the node and
   a setup-guide section reading "This step needs a custom HTTP request. See the
   provider's API docs."
4. **Never invent.** The compiler will not emit a node type that is absent from
   the registry, under any circumstance. A workflow with a fabricated node type
   imports into n8n and fails at runtime with an opaque error, which is strictly
   worse than an honest HTTP node with a warning attached.

Every step 3 event is logged with the proposed capability. That log is the
prioritized backlog for which integrations to add next, driven by real demand
rather than guesswork.

## MVP Coverage

Full generation across all n8n nodes is a milestone of its own. The MVP ships a
curated slice, chosen to cover the personas in the product strategy document.

| Category | Integrations |
| --- | --- |
| Core primitives | all `core.*`, `http.request.send` |
| Communication | Slack, Discord, Gmail, Outlook |
| Data | Google Sheets, Airtable, Notion, Postgres |
| CRM and sales | HubSpot, Pipedrive, Stripe |
| Dev | GitHub, Jira, Linear |
| AI | OpenAI, Anthropic |
| Triggers | Webhook, Schedule, Gmail, Google Sheets, Stripe, GitHub |

That is roughly 25 integrations and 120 capabilities. It covers the lead-routing
and onboarding template flows the landing page promises, which is the bar for
launch.

## Related Documents

- [WORKFLOW_SCHEMA.md](WORKFLOW_SCHEMA.md) defines how FFIR references
  capabilities.
- [COMPILER_ARCHITECTURE.md](COMPILER_ARCHITECTURE.md) defines how `bindings`
  are consumed.
- [AI_SPEC.md](AI_SPEC.md) defines how the registry is retrieved into prompts.
