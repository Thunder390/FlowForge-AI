# AI Layer Specification

How FlowForge uses Claude to turn a sentence into a validated workflow, and how
it prevents the model from inventing node parameters.

## The Layer Boundary

**The AI layer produces FFIR. It produces nothing else.**

It does not produce n8n JSON. It does not produce mermaid. It does not produce
the setup guide or the integrations list. Those are computed from FFIR by the
compiler and the renderers.

This is a deliberate departure from section 8 of the product strategy document,
which has Claude return all five artifacts in one object. The reasons:

1. Four of the five are deterministic functions of the fifth.
2. Generating them costs roughly four times the output tokens and four times the
   latency, which matters directly because the strategy document budgets 10 to
   20 seconds for generation.
3. Each generated artifact is an independent hallucination surface. Derived
   artifacts have zero.
4. Derived artifacts are unit-testable. Model output is not.

The structural expression of this rule is that `packages/ai` must not import
`packages/compiler`. See PROJECT_STRUCTURE.md.

## Provider Abstraction

Model access goes through a `ModelProvider` interface. Anthropic is the only
implementation at launch, and the interface exists because swapping providers is
**not** a driver swap.

```ts
interface ModelProvider {
  readonly key: string;                    // "anthropic" | "openai" | "bedrock"
  readonly capabilities: ProviderCapabilities;

  generate(req: GenerationRequest): AsyncIterable<ProviderEvent>;
}

interface ProviderCapabilities {
  strictStructuredOutput: boolean;   // additionalProperties:false actually enforced
  promptCaching: "prefix" | "none";
  toolUse: boolean;
  maxContextTokens: number;
  streamingPartialJson: boolean;     // drives live progress in the UI
  serverSideFallback: boolean;
}
```

`ProviderCapabilities` mirrors the `TargetCapabilities` pattern the compiler
already uses, and for the same reason: **a capability difference changes
behavior, so it must be declared rather than assumed.**

The pipeline reads capabilities and adapts:

| Capability | If false |
| --- | --- |
| `strictStructuredOutput` | Validation stage 3 name checking becomes load-bearing rather than belt-and-braces. Expect a higher repair rate and budget for it. |
| `promptCaching` | Cost model changes materially. The inline capability catalog stops being nearly free and the retriever should switch to tool search sooner. |
| `streamingPartialJson` | Loading UI falls back to coarse stage transitions instead of live node labels. |
| `serverSideFallback` | Refusal handling becomes a client-side retry against a second provider. |

### Credentials resolve per tenant

Provider credentials are resolved **per tenant, not per deployment**. The Agency
tier in the product strategy document already promises custom API keys, and
enterprise customers will want Bedrock or Vertex under their own contract and
data-residency terms.

A provider constructed from global environment variables makes that a rewrite
later instead of a configuration change. The resolver takes an organization ID
and returns a configured provider, falling back to the platform's own credentials
when the tenant has not supplied any. See
[SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) for where those credentials are
stored and [SECURITY.md](SECURITY.md) for how they are protected.

## Models

The default provider is Anthropic. Model IDs below are current as of this
document's date and are the values the code should carry.

| Role | Model | Why |
| --- | --- | --- |
| Completeness classifier | `claude-haiku-4-5` | Cheap, fast, binary decision. |
| Plan generation (pass A) | `claude-opus-5` | Graph reasoning. Quality matters. |
| Parameter fill (pass B) | `claude-opus-5` | Strict schema, high precision. |
| Repair | `claude-opus-5` | Small diff, same model for consistency. |
| Chat iteration | `claude-opus-5` | Full FFIR context, cached. |

The product strategy document's roadmap names Claude 3.5 Sonnet for the MVP.
That model is retired and would 404. `claude-opus-5` is the current
equivalent-or-better target and is what the code should be written against.

### Request parameters

```ts
{
  model: "claude-opus-5",
  max_tokens: 32000,
  output_config: { effort: "high" },
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
  // streamed
}
```

Notes that are easy to get wrong:

- **Thinking is on by default on Opus 5.** Omitting the `thinking` parameter
  runs adaptive thinking. Do not set `budget_tokens`; it was removed and returns
  a 400.
- **`max_tokens` caps thinking plus output together.** Sizing it tightly around
  the expected FFIR size will truncate mid-document. 32000 is the floor for
  generation calls.
- **Do not set `temperature`, `top_p`, or `top_k`.** All three return a 400 on
  Opus 5. Steer with prompting and with `effort`.
- **Stream every generation call.** Anything above roughly 16k `max_tokens`
  risks an SDK HTTP timeout when non-streaming. Streaming is also what drives
  the real loading stages described below.
- **Check `stop_reason` before reading `content`.** A safety classifier can
  decline with `stop_reason: "refusal"` and an empty or partial content array.
  Code that reads `content[0]` unconditionally will throw.
- **Effort** starts at `high`. Sweep `medium` and `low` against the eval set
  before launch; on Opus 5 the lower levels are unusually strong and this is the
  main cost lever.

## Generation Flow

```
User prompt
    |
[0] Completeness classifier            Haiku 4.5, cheap
    |
    +--> incomplete --> clarification questions --> back to user
    |
[1] Pass A: plan                       Opus 5, registry index in context
    |                                  Output: capabilities + graph, no params
    |
[2] Retrieval                          Resolve capabilities to full schemas
    |                                  Local. No model call.
    |
[3] Pass B: parameters                 Opus 5, only relevant schemas in context
    |                                  Output: parameters keyed by node ID
    |
[4] Merge                              Plan graph + parameters = FFIR document
    |
[5] Validation pipeline                Five stages, local
    |
    +--> failures --> repair prompt --> back to [5], max 2 attempts
    |
Validated FFIR
```

Two passes rather than one is the central design decision, and it exists to
solve the grounding problem the strategy document identifies.

The naive approach injects every node schema into the system prompt. The MVP
registry alone is roughly 120 capabilities with full parameter schemas, which is
far too large to send on every request and would degrade output quality even if
it fit. The two-pass split means the model first decides *what* it needs
(cheap, needs only the compact index) and then fills in details for *only those
things* (needs full schemas, but only for five or six capabilities).

A secondary benefit turns out to be equally important: **once pass A has
committed to a set of capabilities, we can synthesize an exact, closed JSON
schema for pass B's output.** That is what makes strict structured output
possible for parameters, and it is covered under Output Contract below.

## Stage 0: Completeness Classifier

The strategy document calls for asking three clarifying questions when a prompt
lacks trigger or action data. Doing that with Opus wastes an expensive call on a
binary decision, so it runs on Haiku 4.5 first.

```
System:
You classify automation requests as ready to build or needing clarification.

A request is READY when all three are present or unambiguously implied:
1. A trigger. What starts the workflow.
2. At least one action. What should happen.
3. The apps or services involved.

A request NEEDS_CLARIFICATION when any of the three is missing or so vague that
building it would require guessing at the user's intent.

Bias toward READY. A user who wrote a specific sentence wants a workflow, not an
interview. Ask only when a wrong guess would produce something they cannot use.
Never ask more than three questions. Never ask about details you could pick a
sensible default for.
```

Output schema:

```json
{
  "type": "object",
  "properties": {
    "status": { "type": "string", "enum": ["ready", "needs_clarification"] },
    "questions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "question": { "type": "string" },
          "why": { "type": "string" },
          "suggestions": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["question", "why", "suggestions"],
        "additionalProperties": false
      }
    }
  },
  "required": ["status", "questions"],
  "additionalProperties": false
}
```

`suggestions` matters for the UX. The design system's empty state says "never a
dead end", and a clarifying question with three clickable answers is a very
different experience from a bare text prompt. Answers append to the original
prompt and the whole thing re-enters at stage 0 once. A second incomplete
verdict proceeds to generation anyway with the model instructed to pick sensible
defaults and record them in `metadata.warnings`. Two rounds of questions is
already more friction than most users will accept.

## Stage 1: Pass A, Plan Generation

### System prompt

```
You are the workflow architect for FlowForge AI. You translate a plain-English
automation request into a structured workflow plan.

Your output is a plan: the sequence of steps, the capability each step uses, and
how the steps connect. You do not fill in parameter values at this stage. A
later step does that.

## Capability IDs

Every step must reference a capability by its exact ID from the catalog below.
Capability IDs have the form <integration>.<resource>.<operation>, for example
slack.message.send or google_sheets.row.append.

You must use an ID that appears in the catalog. Do not invent a capability ID,
do not guess at one you think should exist, and do not modify one to fit. If no
catalog entry matches what the user needs, use http.request.send and explain in
that step's `notes` which API endpoint it should call. An honest HTTP step is
correct. An invented capability ID is not, and it will be rejected.

## Node kinds

trigger        Entry point. Exactly one per workflow. No inbound edges.
action         Performs an external side effect.
transform      Reshapes data. No side effects.
branch         Conditional split. Two or more outbound edges.
merge          Rejoins branches.
loop           Iterates a collection.
ai             An LLM call.
wait           A delay or pause.
error_handler  Receives execution when another step fails.

## Graph rules

- Exactly one trigger, with no inbound edges.
- Every other node reachable from the trigger.
- No cycles, except a loop body connecting back to its loop node.
- A branch node has at least two outbound edges, each with a condition.
- A node whose on_error is "route" must have an outbound edge with port "error".
- Loops must declare a finite max_iterations.

## Design guidance

Build the workflow the user asked for. Do not add steps they did not ask for.
No logging steps, no confirmation steps, no "just in case" error handling on
operations that cannot fail.

Add an error_handler only when a failure would be silent and costly, such as a
step that creates an account or moves money. When you do, say why in `notes`.

Prefer fewer nodes. A single transform that sets three fields beats three
transforms. Steps a person would describe as one action should be one node.

Give every node a `label` that reads like something a person would say out loud:
"Create the Google Workspace account", not "google_workspace_user_create_1".

Use `notes` for anything a person setting this up would need to know and could
not infer from the label. Leave it empty otherwise.
```

Followed by the **capability catalog**: the compact `index.json` from the
registry. Capability ID, display name, aliases, one-line description. No
parameter schemas. Roughly 6k tokens for the MVP registry, which is affordable
because it sits behind a cache breakpoint and is byte-identical across every
request.

### Prompt caching layout

Render order is `tools`, then `system`, then `messages`. The cache breakpoint
goes on the **last system block**, which caches the instructions and the catalog
together.

```
[system block 1] Instructions                stable
[system block 2] Capability catalog          stable, changes only on registry bump
                 <-- cache_control breakpoint here
[user message]   The user's prompt           volatile
```

Opus 5's minimum cacheable prefix is 512 tokens, so this comfortably caches.
Cache reads cost about a tenth of base input, so the roughly 8k-token stable
prefix becomes nearly free after the first request.

The catalog must be serialized deterministically. Sorted keys, no timestamps, no
build IDs. A single reordered key invalidates the whole prefix and the cache hit
rate silently drops to zero. Verify with `usage.cache_read_input_tokens`; if it
is zero across repeated requests, something in the prefix is varying.

### Pass A output schema

Non-recursive, `additionalProperties: false` throughout, and free of the
constraint keywords that structured outputs does not support.

```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string" },
    "description": { "type": "string" },
    "nodes": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "kind": {
            "type": "string",
            "enum": ["trigger","action","transform","branch","merge","loop","ai","wait","error_handler"]
          },
          "capability": { "type": "string" },
          "label": { "type": "string" },
          "notes": { "type": "string" },
          "capability_scope": { "type": "string" },
          "on_error": { "type": "string", "enum": ["stop","continue","route"] },
          "retry_attempts": { "type": "integer" }
        },
        "required": ["id","kind","capability","label","notes","capability_scope","on_error","retry_attempts"],
        "additionalProperties": false
      }
    },
    "edges": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "from": { "type": "string" },
          "to": { "type": "string" },
          "port": { "type": "string" },
          "condition_left": { "type": "string" },
          "condition_operator": {
            "type": "string",
            "enum": ["none","equals","not_equals","contains","not_contains",
                     "greater_than","less_than","is_empty","is_not_empty","matches_regex"]
          },
          "condition_right": { "type": "string" }
        },
        "required": ["id","from","to","port","condition_left","condition_operator","condition_right"],
        "additionalProperties": false
      }
    },
    "variables": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "label": { "type": "string" },
          "description": { "type": "string" },
          "type": { "type": "string", "enum": ["string","number","boolean"] },
          "required": { "type": "boolean" },
          "sensitive": { "type": "boolean" },
          "default": { "type": "string" }
        },
        "required": ["id","label","description","type","required","sensitive","default"],
        "additionalProperties": false
      }
    }
  },
  "required": ["name","description","nodes","edges","variables"],
  "additionalProperties": false
}
```

Three schema-design notes worth recording, because each is a workaround for a
real structured-output constraint:

1. **Every field is in `required`.** Structured outputs works best with a fully
   closed shape. Optionality is expressed with sentinel values: empty string for
   absent text, `"none"` for an absent condition operator, `0` for no retries.
   The merge step converts sentinels back to genuine absence.
2. **Conditions are flattened onto the edge** rather than nested as a
   `condition` object. Fewer nesting levels means fewer places for the model to
   go wrong, and the merge step reassembles the nested FFIR form.
3. **No `pattern`, `minLength`, or `minimum` anywhere.** Structured outputs does
   not support them. Those constraints are enforced by our validator instead,
   with failures feeding the repair loop.

## Stage 2: Retrieval

Local. No model call.

1. Collect the distinct `capability` values from the plan.
2. Look each up in the registry.
3. Unknown IDs enter the unknown-capability ladder (below) before proceeding.
4. Build a schema bundle containing, for each resolved capability, its full
   parameter definitions with descriptions and examples, and its output shape.

The output shapes matter: pass B needs to know that
`bamboohr.employee.created` emits `employee.first_name` in order to write
`{{ n_trigger.employee.first_name }}`. Without them the model invents field
names, which is exactly the failure this architecture exists to prevent.

Typical bundle size is 2k to 4k tokens for a five-node workflow, against roughly
200k for the whole registry. That ratio is the justification for two passes.

## Stage 3: Pass B, Parameter Fill

### Synthesized output schema

This is the strongest guarantee in the pipeline. Because pass A has already
committed to a specific set of capabilities and node IDs, the exact parameter
schema for **this specific workflow** can be constructed:

```json
{
  "type": "object",
  "properties": {
    "n_trigger": {
      "type": "object",
      "properties": {
        "poll_interval_minutes": { "type": "integer" }
      },
      "required": ["poll_interval_minutes"],
      "additionalProperties": false
    },
    "n_slack_welcome": {
      "type": "object",
      "properties": {
        "channel": { "type": "string" },
        "text": { "type": "string" }
      },
      "required": ["channel", "text"],
      "additionalProperties": false
    }
  },
  "required": ["n_trigger", "n_slack_welcome"],
  "additionalProperties": false
}
```

One property per node ID, each with that capability's exact parameter shape,
built from registry data at request time. `additionalProperties: false` at every
level means the model **cannot emit a parameter name that does not exist**. Not
"is unlikely to". Cannot. The API enforces it.

Optional registry parameters are omitted from `required` when the registry marks
them optional and provides a default; otherwise they are included and the model
is instructed to emit an empty string when not applicable.

This eliminates the single largest hallucination class in the product: invented
parameter names. What remains is invented parameter *values*, which the
validator catches with the registry's `pattern` and `one_of` rules.

### System prompt

```
You are filling in parameter values for a workflow plan that has already been
designed and validated.

The structure is fixed. You are not redesigning anything. For each node, produce
the parameter values that make that step do what its label says.

## Expressions

Reference data from an earlier step with double braces:

  {{ node_id.field.subfield }}

Use the exact node IDs from the plan and the exact field names from the output
shapes given below. Do not guess at a field name. If the data you need is not in
any listed output shape, it does not exist, and you should reference the closest
field that does or leave the parameter empty and note the gap.

You may only reference a node that runs BEFORE the node you are filling in.
Referencing a later step, or a step on a different branch, is an error.

Reference a workflow variable as {{ $vars.variable_id }}.

Expressions support field access and array indexing only. There is no
arithmetic, no function calls, no string concatenation inside the braces, and no
inline JavaScript. Text outside the braces is literal, so
"Welcome {{ n_trigger.name }}!" is correct and useful.

## Values

Use the example values in the schemas as a guide to format.

Never write a real credential, API key, token, or password into a parameter. Use
a workflow variable for anything secret. A parameter containing something that
looks like a live key will be rejected.

Where a sensible concrete default exists, use it rather than a placeholder. A
Slack channel of "#general" is more useful than "YOUR_CHANNEL_HERE".
```

Then the schema bundle, then the plan JSON, then the user's original prompt so
values reflect what they actually asked for.

Cache breakpoint goes after the instruction block. The schema bundle varies per
workflow and sits after it.

## Stage 4: Merge

Local, deterministic, and fully specified. Every field of the FFIR document is
either copied from a pass output, derived from the registry, or stamped by the
pipeline. Nothing is invented here.

**Document fields**

| FFIR field | Source |
| --- | --- |
| `ffir_version` | Constant for the writing code. |
| `expression_grammar` | Constant for the writing code. |
| `id` | Generated by the pipeline, or carried through on iteration. |
| `name`, `description` | Pass A, verbatim. |
| `nodes`, `edges`, `variables` | Pass A plus pass B, per the rules below. |
| `credentials` | Derived. See below. |
| `metadata` | Stamped. See below. |

**Sentinel conversions.** The pass schemas require every field so the shape stays
closed, which means absence is expressed with sentinels. The merge converts them
back:

| Pass output | FFIR result |
| --- | --- |
| `notes: ""` | Field omitted. |
| `condition_operator: "none"` | The whole `condition` object omitted. |
| `retry_attempts: 0` | `error_policy.retry` omitted. |
| `on_error: "stop"` with `retry_attempts: 0` | `error_policy` omitted entirely. |
| `default: ""` on a variable | Field omitted. |
| `port: ""` | Defaults to `"main"`. |

**Structural reassembly.** Flattened edge conditions become nested `condition`
objects. Flat `on_error` and `retry_attempts` become a nested `error_policy`.
Node `parameters` come from the pass B object keyed by node ID.

**Derived fields.** These are computed rather than generated, which removes them
as hallucination surfaces:

- `credentials[]`: each distinct `capability_scope` across nodes joins against the
  registry's auth definitions to produce an entry with `auth_type`, `label`, and
  `required_scopes`. The scopes are the union of `required_scopes` across every
  capability using that scope, so the setup guide asks for exactly the permissions
  the workflow needs and no more.
- `nodes[].credential`: derived from that node's `capability_scope` by looking up
  the credential entry generated above. Pass A never emits a credential *reference*,
  only a scope.
- `variables[].sensitive`: pass B sets this, and the merge additionally forces it
  true for any variable whose `id` or `label` matches the credential-name
  heuristic, then strips the `default` if one was supplied. Model judgment is
  trusted to add the flag, never to remove it.

**Stamped metadata.** `generated_by` (model ID), `generated_at`,
`source_prompt_hash`, `registry_version`, `prompt_version`, and any accumulated
`warnings`.

## Stage 5: Validation Pipeline

Five stages, all local, all fast. Every stage collects **all** failures rather
than stopping at the first, because the repair prompt needs the complete list to
fix everything in one retry.

| Stage | Owner | Checks | On failure |
| --- | --- | --- | --- |
| 0. Limits | `ffir` | Document limits (rule 19). | Terminal. Not repairable. |
| 1. Schema | `ffir` | Document matches the FFIR JSON schema. | Repair. |
| 2. Registry | `ai` | Every capability resolves. Every capability scope is real. | Unknown-capability ladder. |
| 3. Parameter | `ai` | Parameter **names** and **values** both check against the registry entry. | Repair. |
| 4. Graph | `ffir` | Rules 1 through 18 in WORKFLOW_SCHEMA.md. | Repair. |
| 5. Compile dry-run | `pipeline` | `compile(ffir, "n8n")` succeeds. | Repair, or degrade. |

### Stage 3 validates names, not just values

Parameter **name** validation is a distinct check from parameter value
validation, and it must run even though pass B's synthesized schema already makes
illegal names structurally impossible.

The reason is that the schema guarantee belongs to the *provider*, not to the
architecture. It holds on a provider with strict structured outputs and weakens
or disappears on one without. It also does not apply at all to two document
sources that will exist: hand-authored FFIR, and workflows imported from the
public marketplace. Neither passed through pass B.

Without an independent check, an unknown parameter name reaches the compiler,
misses the `parameter_map` lookup, and is silently dropped, producing a workflow
that imports cleanly and is missing configuration. That is precisely the failure
class this architecture exists to prevent, so it does not get to depend on a
single provider's feature set.

### Stage 5 belongs to the pipeline, not the AI layer

The compile dry-run is the gate that guarantees a workflow which renders on the
canvas is a workflow that will export. Without it a user can iterate in chat for
a minute and hit a failure at download time.

It is also the reason `packages/pipeline` exists. The AI layer must not import
the compiler, so the AI layer cannot own a stage that calls it. The orchestrator
owns the generation state machine and runs stages 0 through 4 via `ai` and `ffir`,
then stage 5 via `compiler`. See [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) for
how the import rule is enforced rather than merely asserted.

The dry-run runs the full compiler pipeline including `verify` and discards the
output. Because the compiler is a pure function with no I/O, this is cheap.

## Retry and Repair

### The ladder

| Failure | Response | Attempts |
| --- | --- | --- |
| API 429 or 5xx | SDK exponential backoff. | SDK default |
| `stop_reason: "refusal"` | Server-side fallback via `fallbacks: "default"`. | 1 |
| `stop_reason: "max_tokens"` | Retry with `max_tokens` doubled. | 1 |
| Schema, parameter, or graph failure | Repair prompt with the error list. | 2 |
| Unknown capability | Unknown-capability ladder. | 3 rungs |
| Compile dry-run failure | Repair prompt with the compile error. | 1 |
| Anything still failing | Structured error to the UI. | terminal |

Total worst case is four Opus calls. At `high` effort that is inside the
strategy document's 10 to 20 second budget only if the repairs are rare, which
is the point of the grounding work. Repair rate is the metric to watch.

### The repair prompt

Repair is a **continuation of the existing conversation**, not a fresh request.
The prior turns stay in `messages`, which preserves the cached prefix and gives
the model the context it already reasoned through.

```
The workflow you produced did not validate. Here are the specific problems:

[1] node "n_slack_welcome", parameter "channel"
    Code: param_pattern_failed
    Value: "general"
    Expected: a channel name starting with # or @, or a channel ID.

[2] node "n_create_account"
    Code: error_route_missing
    This node has on_error "route" but no outbound edge with port "error".
    Either add an error_handler node and an edge to it, or change on_error.

[3] expression in node "n_slack_welcome", parameter "text"
    Code: expression_forward_reference
    "{{ n_alert_it.status }}" references a node that does not run before this
    one.

Fix exactly these problems. Return the complete corrected workflow in the same
format. Do not change anything that was not flagged.
```

Three properties this prompt has on purpose:

- **Machine-generated from validator output.** Never hand-phrased per case.
- **Names the node and parameter.** Vague feedback produces vague fixes.
- **"Do not change anything that was not flagged."** Without this the model
  tends to redesign, which loses correct work and often introduces new failures.

**Never retry a semantically valid result.** If the workflow validates and
compiles but the user does not like it, that is a chat-iteration turn, not a
retry. Conflating the two burns tokens and produces churn.

### Unknown capability ladder

Owned by [NODE_REGISTRY.md](NODE_REGISTRY.md). Three rungs: alias search (local,
no model call), same-integration retry (one cheap call, and the common case),
then HTTP degradation with a `capability_unknown` warning.

The only part specific to this layer is that rung 2 is a model call and
therefore counts against the retry budget in the table above.

## Hallucination Prevention

Six mechanisms, in order of how much they contribute:

1. **Closed parameter schemas.** The synthesized pass B schema with
   `additionalProperties: false` makes invented parameter names structurally
   impossible. This is the single biggest win and it is enforced by the API, not
   by prompting.
2. **Catalog-constrained capabilities.** Pass A can only choose from a catalog
   that is in its context, and any deviation is caught in stage 2.
3. **Output shapes in context.** Pass B knows the real field names each upstream
   node emits, so expressions reference reality rather than plausible-sounding
   invention.
4. **Registry validation.** Values are checked against real patterns and enums.
5. **Compile dry-run.** The last gate. Nothing reaches the user that cannot be
   exported.
6. **Honest degradation.** When the model wants something that does not exist,
   the answer is a visible HTTP node with a warning, never a fabricated node
   type. A fabricated type imports into n8n and fails opaquely at runtime, which
   is strictly worse than an obvious gap.

The strategy document's edge-case guidance says to warn "This node might require
a custom HTTP request". That warning is exactly the `capability_unknown` code,
and mechanism 6 is what produces it.

## Streaming and Loading States

The design system asks for sequential text updates during generation. The
temptation is to fake these on a timer. Do not: a progress indicator that
advances while nothing is happening is a lie the user eventually notices, and it
gives no signal when a call has actually stalled.

Real stages, driven by actual pipeline position:

| Stage event | UI text |
| --- | --- |
| Classifier returns `ready` | `Understanding your request...` |
| Pass A stream opens | `Designing the workflow...` |
| Pass A partial parse yields first node | `Planning step 1 of N...` (updates live) |
| Retrieval completes | `Loading integration schemas...` |
| Pass B stream opens | `Configuring <label>...` |
| Validation starts | `Validating...` |
| Repair triggered | `Fixing 2 issues...` |
| Compile dry-run passes | `Ready` |

Pass A's stream is incrementally parsed so node labels appear as the model
writes them. That turns dead time into visible progress and is the difference
between a 15-second wait feeling responsive and feeling broken.

Set `thinking: { type: "adaptive", display: "summarized" }` if reasoning is
surfaced anywhere in the UI. The default is `"omitted"`, which streams thinking
blocks with empty text and looks like a long unexplained pause.

## Chat Iteration

The strategy document's example: "Actually, add a step to create a Jira
account."

Iteration is a **full regeneration with the current FFIR as context**, not a
patch. Patching is tempting and wrong: a partial edit can invalidate expressions
elsewhere in the graph, and detecting that requires re-running the whole
validator anyway.

```
[system]  Same pass A instructions plus the catalog       cached
[user]    Original prompt
[asst]    Current workflow JSON
[user]    Actually, add a step to create a Jira account.
```

Then retrieval, pass B, merge, and validation run exactly as before. The
constraint that makes this feel like an edit rather than a regeneration is one
line appended to the system prompt for iteration turns:

```
Preserve the existing node IDs, labels, and structure. Change only what the
user's latest message requires. Reusing an existing node ID means that node is
unchanged.
```

Because node IDs are stable across turns, the canvas can diff old against new
and animate only what changed, which is what makes the fluid transitions in the
design system possible.

## Cost Model

Per generation, using published Opus 5 rates of $5 per million input and $25 per
million output, and Haiku 4.5 at $1 and $5:

| Call | Input | Output | Cost |
| --- | --- | --- | --- |
| Classifier (Haiku) | ~500 | ~100 | ~$0.001 |
| Pass A, cache miss | ~8,000 | ~1,500 | ~$0.078 |
| Pass A, cache hit | ~8,000 (90% cached) | ~1,500 | ~$0.042 |
| Pass B | ~5,000 | ~1,000 | ~$0.050 |
| Repair, when it happens | ~15,000 | ~1,500 | ~$0.113 |

A clean generation on a warm cache is roughly **$0.09**. One with a repair is
roughly **$0.20**.

Against the strategy document's pricing, the Pro tier at $19 for 100 generations
implies about $9 of model cost at a clean rate, which leaves margin but not a
lot of it. Two implications worth acting on:

- The free tier's 5 generations per month is about $0.45 of cost per signup.
  That is affordable, but it needs rate limiting and abuse protection from day
  one rather than as a follow-up.
- **Repair rate is the margin.** Every avoided repair is roughly $0.11. The
  grounding work in this document is not only a quality investment, it is the
  unit-economics investment.

Effort tuning is the other lever. Sweep `medium` and `low` against the eval set
before launch; on Opus 5 the lower levels are strong enough that this may be
free quality-neutral savings.

## Evaluation

An eval set is a prerequisite for changing any prompt in this document, not a
nice-to-have. No prompt change ships without running it.

[OBSERVABILITY_AND_EVALS.md](OBSERVABILITY_AND_EVALS.md) owns the corpus, the
scoring method, the metric targets, and the CI gate. The constraint this document
imposes on it: every prompt here is a versioned file, and every generation records
the `prompt_version` that produced it, because otherwise an eval result cannot be
attributed to a revision and a regression cannot be bisected.

## Related Documents

- [WORKFLOW_SCHEMA.md](WORKFLOW_SCHEMA.md) owns FFIR, the validation rules, and
  the document limits.
- [NODE_REGISTRY.md](NODE_REGISTRY.md) owns the catalog, schema bundles, and the
  degradation ladder.
- [COMPILER_ARCHITECTURE.md](COMPILER_ARCHITECTURE.md) owns the dry-run gate.
- [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) owns the job the pipeline runs
  inside and where tenant provider credentials are stored.
- [SECURITY.md](SECURITY.md) owns secret handling and the prompt-injection
  posture.
- [OBSERVABILITY_AND_EVALS.md](OBSERVABILITY_AND_EVALS.md) owns evaluation and
  prompt versioning.
- [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) owns the import rule that keeps
  this layer platform-agnostic.
