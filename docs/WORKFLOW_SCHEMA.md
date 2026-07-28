# FlowForge Intermediate Representation (FFIR)

The platform-agnostic workflow schema. FFIR is the single artifact the AI layer
produces and the single artifact every compiler target consumes.

**Version:** `ffir/1.0`

## Why FFIR Exists

The product strategy document proposes that Claude return one JSON object
containing `visual_schema`, `n8n_export`, `mermaid_syntax`, `setup_guide`, and
`integrations`. We are not building it that way.

Four of those five outputs are derivable from the fifth. Mermaid is a render of
the graph. n8n JSON is a compile of the graph. The setup guide is a render of
graph plus registry. The integrations list is a projection of graph plus
registry. Asking the model for all five multiplies output tokens, multiplies
latency, and creates four independent surfaces where the model can hallucinate.

FFIR is that fifth thing. Claude produces FFIR. Everything else is computed.

Three properties follow from this, and every design decision below serves them:

1. **Platform-agnostic.** FFIR contains zero n8n vocabulary. No `typeVersion`,
   no `nodes-base.slack`, no n8n expression syntax. If a reader can tell which
   automation platform FlowForge targets by reading FFIR, the abstraction has
   leaked.
2. **Non-recursive.** Claude's structured output mode does not support recursive
   JSON schemas. A nested tree IR would make strict schema enforcement
   impossible. FFIR is a flat node list plus a flat edge list.
3. **Deterministically compilable.** Given the same FFIR and the same registry
   version, a target emits byte-identical output. This is what makes golden-file
   testing possible.

## Document Shape

```json
{
  "ffir_version": "1.0",
  "expression_grammar": "1",
  "id": "wf_01HQ8X...",
  "name": "Employee onboarding",
  "description": "Creates accounts and notifies the team when HR adds a hire.",
  "nodes": [],
  "edges": [],
  "credentials": [],
  "variables": [],
  "metadata": {}
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `ffir_version` | string | yes | Semver-ish. Migration key. See Versioning. |
| `expression_grammar` | string | yes | Which expression grammar the strings use. |
| `id` | string | yes | Stable workflow identity across iterations. |
| `name` | string | yes | Human label. Becomes the platform workflow name. |
| `description` | string | yes | One or two sentences. Feeds the setup guide. |
| `nodes` | Node[] | yes | Flat list. Order is not significant. |
| `edges` | Edge[] | yes | Flat list. Defines all control flow. |
| `credentials` | CredentialRef[] | yes | Symbolic handles. Never secret values. |
| `variables` | Variable[] | no | Workflow-scoped constants the user must set. |
| `metadata` | object | no | Non-semantic. Generator notes, warnings, layout. |

`nodes` and `edges` being flat sibling arrays is the load-bearing decision.
Branching, looping, and error handling are all expressed as edge properties
rather than nesting, which keeps the JSON schema non-recursive and therefore
strictly enforceable.

## Nodes

A node is one unit of work. It is identified by a `kind` (its semantic role in
the graph) and a `capability` (what it actually does, resolved against the node
registry).

```json
{
  "id": "n_slack_welcome",
  "kind": "action",
  "capability": "slack.message.send",
  "label": "Send welcome message",
  "parameters": {
    "channel": "#general",
    "text": "Welcome {{ n_bamboo_trigger.employee.first_name }}!"
  },
  "credential": "cred_slack_main",
  "error_policy": {
    "on_error": "continue",
    "retry": { "attempts": 3, "backoff": "exponential", "initial_delay_ms": 1000 }
  },
  "notes": "Posts to the shared channel, not a DM."
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | Unique within the workflow. Referenced by edges and expressions. |
| `kind` | NodeKind | yes | Semantic role. Closed enum, see below. |
| `capability` | string | yes | Registry join key. See Capability IDs. |
| `label` | string | yes | Human-readable. Shown on the canvas and in the guide. |
| `parameters` | object | yes | Validated against the registry entry. May be empty. |
| `credential` | string | no | References a `credentials[].id`. |
| `error_policy` | ErrorPolicy | no | Defaults applied by the compiler if absent. |
| `notes` | string | no | Surfaces in the setup guide. |

### Node kinds

`kind` describes the node's role in graph traversal. It is deliberately a small
closed set: the compiler switches on `kind` to decide how to lower a node, so
adding a kind is a breaking change to every target.

| Kind | Meaning | Edge behavior |
| --- | --- | --- |
| `trigger` | Entry point. Has no inbound edges. | One or more outbound. |
| `action` | Performs an external side effect. | One inbound, one outbound. |
| `transform` | Pure data reshaping. No side effects. | One inbound, one outbound. |
| `branch` | Conditional split. | One inbound, N conditional outbound. |
| `merge` | Rejoins branches. | N inbound, one outbound. |
| `loop` | Iterates over a collection. | See Loops below. |
| `ai` | LLM call. Prompt and output schema in parameters. | One in, one out. |
| `wait` | Delay or external-event pause. | One in, one out. |
| `error_handler` | Target of `on_error: "route"` edges. | N inbound, one outbound. |

A valid workflow has exactly one `trigger` node in the MVP. Multi-trigger
workflows are a post-MVP concern and the validator rejects them today with a
clear message rather than compiling something ambiguous.

### Capability IDs

`capability` is the join key between FFIR, the AI layer, and every compiler
target. The format is three dot-separated segments:

```
<integration>.<resource>.<operation>
slack.message.send
google_sheets.row.append
bamboohr.employee.created
http.request.send
```

Capability IDs are stable, lowercase, and snake_case within a segment. They name
a *business capability*, not a platform node. `slack.message.send` compiles to
`n8n-nodes-base.slack` on n8n and to a completely different module identifier on
Make.com, and FFIR does not know or care about either.

Two capability namespaces are reserved:

- `http.request.send` is the universal escape hatch. Any integration without a
  first-class registry entry lowers to a raw HTTP request on every platform.
- `core.*` covers platform-agnostic primitives that have no external
  integration: `core.transform.map`, `core.branch.if`, `core.merge.collect`,
  `core.wait.delay`.

If Claude proposes a capability the registry does not know, the validation
pipeline rejects it. It never reaches the compiler. See AI_SPEC.md for the
unknown-capability quarantine path.

### Parameters

`parameters` is an open object whose shape is defined by the registry entry for
that capability, not by the FFIR schema. FFIR says "this is an object". The
registry says "for `slack.message.send`, `channel` is a required string matching
`^[#@]?[a-z0-9_-]+$` and `text` is a required string".

This split is deliberate. Putting parameter shapes in FFIR would mean the FFIR
schema grows every time an integration is added, and would push a several
hundred kilobyte schema into every model request. Keeping them in the registry
means the AI layer loads only the handful of parameter schemas relevant to the
workflow being generated.

Parameter values are either JSON literals or expressions (below).

## Expressions

Any string parameter value may contain expressions in double braces. This is the
only dynamic-data mechanism in FFIR.

```
{{ n_trigger.employee.email }}
{{ n_http_1.body.items[0].id }}
{{ $vars.company_domain }}
{{ $now }}
```

### Grammar

```
expression  := "{{" ws reference ws "}}"
reference   := node_ref | var_ref | builtin
node_ref    := node_id ( "." path_segment )+
var_ref     := "$vars." identifier
builtin     := "$now" | "$workflow_id" | "$execution_id"
path_segment:= identifier | identifier "[" integer "]"
node_id     := identifier            ; must match an existing nodes[].id
```

### Grammar versioning

`expression_grammar` is versioned **separately from `ffir_version`** and this is
deliberate. Expressions live inside strings inside parameter values, so a
grammar change cannot be handled by the normal FFIR migration chain without
rewriting every stored string in every stored document. Versioning the grammar
independently means an old document keeps parsing under the rules it was written
against, and a new grammar can ship without a data migration.

The parser dispatches on this field. A document declaring a grammar version the
parser does not implement is rejected rather than parsed optimistically.

Adding a capability to the grammar, for example arithmetic, is therefore a
grammar version bump and not an FFIR major version bump.

Deliberately excluded from grammar `"1"`: arithmetic, function calls, ternaries,
string concatenation inside braces, and inline JavaScript. Those exist on n8n but not
on Zapier, and supporting them would make FFIR uncompilable to the more
restrictive platforms. Anything that needs real computation becomes an explicit
`transform` node, which every platform can represent.

This is a genuine constraint and worth stating plainly: FFIR trades expressive
power for portability. A workflow author who needs
`{{ $json.price * 1.08 }}` gets a `core.transform.map` node instead of an
inline expression. That is more verbose and it is the correct trade.

### Reference validation

Every `node_ref` must name a node that is a **transitive predecessor** of the
referencing node in the edge graph. Referencing a node that runs later, or a
node on a sibling branch that may not have executed, is a validation error, not
a runtime surprise. This check happens in stage 4 of the validation pipeline
(see AI_SPEC.md).

### Compilation

Each target translates the expression AST into its own syntax:

| FFIR | n8n | Make.com |
| --- | --- | --- |
| `{{ n_trigger.email }}` | `={{ $('Trigger').item.json.email }}` | `{{1.email}}` |
| `{{ $vars.domain }}` | `={{ $vars.domain }}` | scenario variable ref |
| `{{ $now }}` | `={{ $now }}` | `{{ now }}` |

Targets receive a parsed AST, never the raw string. String-rewriting expressions
with regex across platform boundaries is how subtle escaping bugs get shipped.

## Edges

An edge is a directed control-flow connection. All branching lives here.

```json
{
  "id": "e_1",
  "from": "n_branch_is_manager",
  "to": "n_create_admin_account",
  "port": "true",
  "condition": {
    "left": "{{ n_trigger.employee.role }}",
    "operator": "equals",
    "right": "manager"
  }
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | Unique within the workflow. |
| `from` | string | yes | Source node id. |
| `to` | string | yes | Target node id. |
| `port` | string | no | Named output. Defaults to `"main"`. |
| `condition` | Condition | no | Only meaningful on edges out of a `branch`. |

### Ports

`port` names which output of the source node the edge leaves from. Most nodes
have a single `"main"` port. The exceptions:

| Source kind | Ports |
| --- | --- |
| `branch` | `"true"`, `"false"`, or named cases for a switch |
| `loop` | `"each"` (per-item body), `"done"` (after iteration) |
| any node | `"error"` when `error_policy.on_error` is `"route"` |

### Conditions

```json
{
  "left": "{{ n_trigger.status }}",
  "operator": "equals",
  "right": "active"
}
```

Operators: `equals`, `not_equals`, `contains`, `not_contains`, `greater_than`,
`less_than`, `is_empty`, `is_not_empty`, `matches_regex`.

`is_empty` and `is_not_empty` take no `right` operand. Everything else requires
both. Compound conditions are expressed as chained `branch` nodes rather than
nested boolean trees, again to keep the schema non-recursive. A three-way AND is
three `branch` nodes in series. This is more verbose in JSON and strictly
easier for both the model and the compiler to get right.

## Loops

A `loop` node has two outbound ports. Edges from `"each"` form the loop body;
the last node in the body connects **back to the loop node** with
`port: "main"`. The `"done"` port continues after iteration finishes.

```json
{
  "id": "n_loop_rows",
  "kind": "loop",
  "capability": "core.loop.for_each",
  "label": "For each new row",
  "parameters": {
    "items": "{{ n_sheets_read.rows }}",
    "item_alias": "row",
    "max_iterations": 500
  }
}
```

Inside the body, the current item is referenced as
`{{ n_loop_rows.row.column_name }}`, using the `item_alias`.

`max_iterations` is required. An unbounded loop is a validation error. This is a
guardrail against a generated workflow burning a client's task quota, which is
a real and expensive failure mode on metered platforms.

The validator confirms the back-edge exists and that the body is acyclic other
than that single back-edge. Arbitrary cycles are rejected.

## Error Handling

```json
{
  "on_error": "route",
  "retry": {
    "attempts": 3,
    "backoff": "exponential",
    "initial_delay_ms": 1000
  },
  "timeout_ms": 30000
}
```

| `on_error` | Behavior |
| --- | --- |
| `stop` | Halt the workflow. The platform default. |
| `continue` | Log and proceed down the `"main"` port. |
| `route` | Send execution down the `"error"` port. Requires such an edge. |

`retry.backoff` is `fixed` or `exponential`. When `on_error` is `"route"`, the
validator requires an edge from this node with `port: "error"` and rejects the
workflow otherwise. A declared error route with nowhere to go is worse than no
error handling, because it reads as safe.

Not every platform supports every combination. Where a target cannot represent a
policy it fails loudly at compile time rather than silently emitting a workflow
with weaker guarantees than the user asked for. See COMPILER_ARCHITECTURE.md.

## Credentials

FFIR never contains a secret. It contains symbolic handles that the user wires
up in the target platform's own credential store.

```json
{
  "id": "cred_slack_main",
  "capability_scope": "slack",
  "auth_type": "oauth2",
  "label": "Slack workspace",
  "required_scopes": ["chat:write", "channels:read"]
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Referenced by `nodes[].credential`. |
| `capability_scope` | yes | The integration segment of the capability ID. |
| `auth_type` | yes | `oauth2`, `api_key`, `basic`, `webhook_secret`, `none`. |
| `label` | yes | Shown in the setup guide. |
| `required_scopes` | no | Feeds the setup guide's permission checklist. |

The compiler emits credential *placeholders* referencing these by name. The
generated export is intentionally non-functional until the user connects real
credentials. That is the correct behavior for a tool that hands users a file to
import.

Validation rejects any parameter value that looks like a live secret. If the
model puts a key in a parameter, the workflow does not compile.
[SECURITY.md](SECURITY.md) owns the scanner's pattern list.

## Variables

Workflow-scoped constants the user is expected to fill in.

```json
{
  "id": "company_domain",
  "label": "Company email domain",
  "type": "string",
  "default": "example.com",
  "required": true,
  "sensitive": false,
  "description": "Used to construct new employee email addresses."
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | Referenced as `{{ $vars.<id> }}`. |
| `label` | string | yes | Shown in the setup guide. |
| `type` | enum | yes | `string`, `number`, `boolean`. |
| `required` | boolean | yes | Whether the workflow can run without it. |
| `sensitive` | boolean | yes | See below. Defaults to `false` only when explicitly stated. |
| `default` | string | no | Forbidden when `sensitive` is `true`. |
| `description` | string | no | Why the value is needed. |

Referenced as `{{ $vars.company_domain }}`. These become a checklist in the
setup guide and platform-level variables in the export where supported.

### Sensitive variables

`sensitive: true` marks a variable that holds a credential, token, password, or
any other secret. The pass B prompt directs the model to route secrets into
variables rather than into parameters, which means variables are the one place a
secret can legitimately enter a workflow definition. They must therefore carry a
stronger rule than parameters, not a weaker one.

A sensitive variable:

1. **Must not carry a `default`.** A document with both `sensitive: true` and a
   non-empty `default` fails validation. There is no legitimate case for
   committing a secret value into a stored blueprint.
2. **Is excluded from every export.** The compiler emits the variable
   declaration and never a value.
3. **Is excluded from any shared, published, or marketplace copy** of the
   workflow, along with its `description` if that description contains a value.
4. **Renders as a setup-guide checklist item** telling the user what to provide
   and where, instead of as a filled-in field.

The secret scanner runs over parameter values **and** variable defaults. See
[SECURITY.md](SECURITY.md), which owns the scanner's pattern list and the
end-to-end secret-handling rules.

## Metadata

Non-semantic. The compiler must produce identical functional output whether or
not `metadata` is present, which keeps it safe for renderers and UI state.

```json
{
  "generated_by": "claude-opus-5",
  "generated_at": "2026-07-28T10:14:22Z",
  "source_prompt_hash": "sha256:...",
  "registry_version": "n8n@1.62.0+overlay.3",
  "warnings": [
    {
      "code": "capability_degraded",
      "node_id": "n_bamboo_trigger",
      "message": "No first-class BambooHR trigger. Lowered to a webhook."
    }
  ],
  "layout": { "n_trigger": { "x": 0, "y": 0 } }
}
```

`registry_version` is important: it pins which registry produced this workflow,
so a workflow generated six months ago can be diagnosed rather than mysteriously
failing to recompile.

`warnings` is how degraded capabilities surface to the UI. The design system
specifies actionable error text; this array is what feeds it.

## Worked Example

The onboarding flow from the product strategy document: "Onboard a new employee
via BambooHR, create a Google Workspace email, and send a Slack welcome
message."

```json
{
  "ffir_version": "1.0",
  "id": "wf_01HQ8XONBOARD",
  "name": "Employee onboarding",
  "description": "When BambooHR records a new hire, create their Google Workspace account and announce them in Slack.",
  "nodes": [
    {
      "id": "n_trigger",
      "kind": "trigger",
      "capability": "bamboohr.employee.created",
      "label": "New employee in BambooHR",
      "parameters": { "poll_interval_minutes": 15 },
      "credential": "cred_bamboohr"
    },
    {
      "id": "n_build_email",
      "kind": "transform",
      "capability": "core.transform.map",
      "label": "Build the email address",
      "parameters": {
        "assignments": [
          {
            "field": "email",
            "value": "{{ n_trigger.employee.first_name }}.{{ n_trigger.employee.last_name }}@{{ $vars.company_domain }}"
          }
        ]
      }
    },
    {
      "id": "n_create_account",
      "kind": "action",
      "capability": "google_workspace.user.create",
      "label": "Create Google Workspace account",
      "parameters": {
        "primary_email": "{{ n_build_email.email }}",
        "given_name": "{{ n_trigger.employee.first_name }}",
        "family_name": "{{ n_trigger.employee.last_name }}",
        "password": "{{ $vars.temp_password }}",
        "change_password_at_next_login": true
      },
      "credential": "cred_google_workspace",
      "error_policy": {
        "on_error": "route",
        "retry": { "attempts": 2, "backoff": "exponential", "initial_delay_ms": 2000 }
      }
    },
    {
      "id": "n_slack_welcome",
      "kind": "action",
      "capability": "slack.message.send",
      "label": "Announce in Slack",
      "parameters": {
        "channel": "#general",
        "text": "Welcome {{ n_trigger.employee.first_name }} to the team. Their account is {{ n_build_email.email }}."
      },
      "credential": "cred_slack"
    },
    {
      "id": "n_alert_it",
      "kind": "error_handler",
      "capability": "slack.message.send",
      "label": "Alert IT on failure",
      "parameters": {
        "channel": "#it-alerts",
        "text": "Account creation failed for {{ n_trigger.employee.first_name }}. Needs manual setup."
      },
      "credential": "cred_slack"
    }
  ],
  "edges": [
    { "id": "e_1", "from": "n_trigger", "to": "n_build_email" },
    { "id": "e_2", "from": "n_build_email", "to": "n_create_account" },
    { "id": "e_3", "from": "n_create_account", "to": "n_slack_welcome" },
    { "id": "e_4", "from": "n_create_account", "to": "n_alert_it", "port": "error" }
  ],
  "credentials": [
    {
      "id": "cred_bamboohr",
      "capability_scope": "bamboohr",
      "auth_type": "api_key",
      "label": "BambooHR API key"
    },
    {
      "id": "cred_google_workspace",
      "capability_scope": "google_workspace",
      "auth_type": "oauth2",
      "label": "Google Workspace admin",
      "required_scopes": ["https://www.googleapis.com/auth/admin.directory.user"]
    },
    {
      "id": "cred_slack",
      "capability_scope": "slack",
      "auth_type": "oauth2",
      "label": "Slack workspace",
      "required_scopes": ["chat:write"]
    }
  ],
  "variables": [
    {
      "id": "company_domain",
      "label": "Company email domain",
      "type": "string",
      "default": "example.com",
      "required": true,
      "description": "Domain for new employee email addresses."
    },
    {
      "id": "temp_password",
      "label": "Temporary password",
      "type": "string",
      "required": true,
      "description": "Initial password. Users must change it at first login."
    }
  ],
  "metadata": {
    "generated_by": "claude-opus-5",
    "registry_version": "n8n@1.62.0+overlay.3"
  }
}
```

Five nodes, four edges, three credentials, two variables. Everything the four
dashboard tabs need is computable from this: the visual flow is the node and
edge lists, the mermaid diagram is a render of the same, the n8n JSON is a
compile, and the setup guide is a walk over `credentials` and `variables` joined
against the registry.

## Validation Rules

These are the graph-level invariants. They run as stage 4 of the pipeline in
AI_SPEC.md, after schema and registry checks have passed.

**Structural**
1. Every `edges[].from` and `edges[].to` names an existing node.
2. Node IDs are unique. Edge IDs are unique. Credential IDs are unique.
3. Exactly one `trigger` node exists.
4. The trigger has no inbound edges.
5. Every non-trigger node is reachable from the trigger.
6. The graph is acyclic except for `loop` back-edges.

**Semantic**
7. Every `capability` resolves in the registry.
8. Every `parameters` object validates against its registry entry.
9. Every `nodes[].credential` names an existing `credentials[].id`.
10. Every credential's `capability_scope` matches the integration segment of
    every capability that references it.
11. Every expression `node_ref` names a transitive predecessor.
12. Every `$vars.x` names an existing `variables[].id`.

**Parameter integrity**
13. Every key in a `parameters` object is a parameter name declared by that
    capability's registry entry. Unknown parameter names are rejected.

Rule 13 exists because the AI layer's strongest guarantee, the synthesized
schema with `additionalProperties: false`, is a property of one model provider
rather than a universal one. Without an independent check, a weaker provider,
a hand-authored document, or an imported marketplace workflow can carry a
parameter name the compiler silently drops during `parameter_map` lookup,
producing a workflow that imports cleanly and is missing configuration. The
validator must not depend on how the document was produced.

**Safety**
14. No parameter value matches a known secret pattern.
15. No variable with `sensitive: true` carries a `default`.
16. Every `loop` node has a finite `max_iterations`.
17. Every node with `on_error: "route"` has an outbound `"error"` edge.
18. Every `branch` node has at least two outbound edges.

**Resource limits**
19. The document is within all limits in the table below.

Each rule maps to a distinct machine-readable error code so the repair prompt
can tell the model precisely what to fix. Rules 1 through 13 are repairable by
re-prompting. Rules 14 through 18 are also repairable but are logged separately
because they indicate the model ignored an explicit system prompt instruction,
which is a prompt-quality signal worth tracking. Rule 19 is not repairable and
terminates the request.

### Document limits

Every FFIR document is bounded. These limits are enforced by the validator
before any other processing, on every document regardless of origin.

| Limit | Value | Rationale |
| --- | --- | --- |
| Maximum nodes | 150 | Above this a workflow is unmaintainable by a human anyway. |
| Maximum edges | 300 | Bounds branch fan-out. |
| Maximum expression length | 500 chars | Single reference plus surrounding literal text. |
| Maximum expression path depth | 10 | Bounds parse cost. |
| Maximum expressions per parameter | 20 | |
| Maximum parameter payload | 64 KB per node | |
| Maximum total document size | 1 MB | |
| Maximum variables | 50 | |
| Maximum credentials | 25 | |

These matter more than they appear. The validator, compiler, and renderers are
pure functions with no internal bounds, so an unbounded document is a
denial-of-service vector the moment untrusted FFIR can reach them. That happens
on the day the marketplace opens, and retrofitting limits after documents exist
that exceed them is a migration rather than a config change.

The limits also catch a runaway generation before it costs a full repair cycle.

Exceeding a limit produces error code `document_limit_exceeded` with the
specific limit named, and is a terminal error rather than a repair trigger.

## Versioning and Migration

`ffir_version` follows `major.minor`.

- **Minor bump:** additive and backward compatible. New optional field, new
  operator, new node kind. Old documents still validate. The loader passes them
  through untouched.
- **Major bump:** breaking. Field removed, semantics changed, required field
  added.

Each major version ships a migration function in `packages/ffir/migrations/`
with the signature `(doc: FFIRv1) => FFIRv2`. The loader chains migrations from
the document's declared version up to current. A document whose version is
newer than the loader is rejected with a clear message rather than
optimistically parsed.

Stored workflows retain their original FFIR alongside the migrated form so a
migration bug is recoverable rather than destructive.

## What FFIR Deliberately Does Not Model

Stating the boundaries explicitly, because the temptation to add these will
recur:

- **Sub-workflows.** Post-MVP. Would require either recursion or a workflow
  reference type, and the reference type is the right answer when we get there.
- **Parallel execution semantics.** FFIR describes a dependency graph. Whether a
  platform runs two independent branches concurrently is the platform's
  business.
- **Runtime state.** FFIR is a blueprint, not an execution log. No run history,
  no cursors, no checkpoints.
- **Platform-specific tuning.** No n8n `alwaysOutputData`, no Zapier task
  throttling. Targets apply their own sensible defaults during lowering.
- **Inline code.** No JavaScript or Python node bodies. They do not port across
  platforms, and accepting them would mean accepting arbitrary model-generated
  code into a client's automation, which is a security posture we are not
  taking in the MVP.

## Related Documents

- [NODE_REGISTRY.md](NODE_REGISTRY.md) defines capabilities and parameter
  schemas.
- [COMPILER_ARCHITECTURE.md](COMPILER_ARCHITECTURE.md) defines how FFIR lowers
  to each platform.
- [AI_SPEC.md](AI_SPEC.md) defines how Claude produces FFIR and how it is
  validated.
