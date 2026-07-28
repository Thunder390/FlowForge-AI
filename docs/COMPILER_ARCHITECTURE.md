# Compiler Architecture

How FFIR becomes a valid n8n workflow, and how the same pipeline supports
Make.com, Zapier, and Node-RED without the AI layer changing at all.

## Design Goal

There is one goal, and every decision below is subordinate to it:

**Adding a new platform must not require touching the AI layer.**

If shipping Make.com support means editing a prompt, the abstraction has failed.
The test is concrete: adding a target should mean writing one `Target`
implementation plus adding one key to each capability's `bindings` block in the
registry. Nothing in `packages/ai`, nothing in `packages/ffir`, nothing in the
validator.

The compiler is a pure function. `compile(ffir, target, registry)` returns
output or a typed error. No network, no filesystem, no clock, no randomness.
This makes it exhaustively testable with golden files, which matters because
compiler bugs are silent: a workflow that imports cleanly and then does the
wrong thing at runtime is the worst failure mode this product has.

## Pipeline

```
FFIR document
     |
  [1] Validate          FFIR is well-formed and semantically legal
     |
  [2] Resolve           Capabilities -> registry entries + bindings
     |
  [3] Normalize         Defaults applied, expressions parsed to AST
     |
  [4] Lower             FFIR graph -> platform-specific IR
     |
  [5] Emit              Platform IR -> the platform's file format
     |
  [6] Verify            Structural self-check on the emitted output
     |
   Output + warnings
```

Stages 1 through 3 are **target-independent**. Every target shares them. Stages
4 through 6 are the `Target` interface. That split is where the leverage is:
roughly two thirds of the compiler is written once.

### Stage 1: Validate

Runs the validation rules owned by
[WORKFLOW_SCHEMA.md](WORKFLOW_SCHEMA.md), which is authoritative for the full
list and their error codes. Returns all failures at once, not just the first,
because the AI repair loop needs the complete list to fix everything in a single
retry.

Stage 0 document limits run first and are terminal rather than repairable, which
matters here because the compiler is a public library boundary that will receive
untrusted documents from the marketplace.

Note that the AI layer runs this same validator before it ever calls the
compiler. Running it again here is deliberate: the compiler is a public library
boundary and must not assume its caller validated. Hand-written and imported
FFIR must hit the same gate as generated FFIR.

### Stage 2: Resolve

Each `nodes[].capability` is looked up in the registry. This produces a
`ResolvedNode` carrying the FFIR node, its registry entry, and the binding for
the requested target.

Three outcomes per node:

| Outcome | Action |
| --- | --- |
| Binding exists | Proceed normally. |
| Binding is explicitly `null` | Degrade to `http.request.send`, emit warning. |
| Binding key is absent | Registry gap. Degrade, emit warning, log for backlog. |

Degradation is never silent. Every degraded node produces a
`metadata.warnings` entry that the UI renders as a badge on the node and the
setup guide renders as an explicit section. A user who exports a workflow with a
degraded node knows which step needs manual work before they import it.

### Stage 3: Normalize

Target-independent cleanup:

- Registry `default` values fill absent optional parameters.
- Absent `error_policy` gets the workflow default (`stop`, no retry).
- Every expression string is parsed into an AST. Downstream stages receive
  structured references, never raw text.
- Nodes are topologically sorted from the trigger. Independent branches sort
  by node ID so ordering is deterministic.
- Node IDs are mapped to stable per-target display names.

Expression parsing happening here, once, is important. If each target
regex-rewrote expression strings independently, escaping bugs would be
per-target and would be found by users rather than tests.

### Stage 4: Lower

The first target-specific stage. Walks the normalized graph and produces the
platform's own node and connection model. Detailed per target below.

### Stage 5: Emit

Serializes platform IR into the platform's file format. Deliberately dumb: it
does key ordering and JSON formatting, and nothing else. All decisions were made
in stage 4.

Emit is where determinism is enforced. Object keys are written in a fixed order,
arrays are sorted where order is not semantically meaningful, and no timestamps
or UUIDs are generated. Same input, byte-identical output, always.

### Stage 6: Verify

A structural self-check on the compiler's own output. Cheap, and it catches a
class of bug that unit tests miss.

For n8n: every `connections` entry names an existing node, every node has a
`type` and `typeVersion`, node names are unique, every referenced credential
appears in the credential list, and the JSON round-trips through parse and
stringify unchanged. Failure here is an internal error, not a user error. It
means the compiler has a bug and the correct response is to fail rather than
hand the user a broken file.

## The Target Interface

```ts
interface Target {
  readonly key: string;              // "n8n" | "make" | "zapier" | "node-red"
  readonly displayName: string;
  readonly fileExtension: string;

  readonly capabilities: TargetCapabilities;

  lower(graph: NormalizedGraph, ctx: CompileContext): PlatformIR;
  emit(ir: PlatformIR, ctx: CompileContext): EmitResult;
  verify(output: EmitResult): VerifyResult;
}

interface TargetCapabilities {
  branching: "full" | "linear_only" | "router";
  loops: boolean;
  errorRouting: boolean;
  retryPolicy: boolean;
  parallelBranches: boolean;
  expressionSyntax: "n8n" | "make" | "zapier" | "javascript";
  maxNodes?: number;
}
```

`TargetCapabilities` is what makes honest failure possible. Before lowering, the
compiler compares what the FFIR document needs against what the target declares
it can do. A mismatch produces a clear error naming the exact node:

```
Cannot compile to Zapier: this workflow uses conditional branching
(node "n_branch_is_manager", kind "branch"), and Zapier Zaps are linear.
Remove the branch or export to n8n or Make.com instead.
```

That message is the alternative to silently dropping a branch and handing the
user a workflow that quietly does the wrong thing. Compare the design system's
error guidance: "Invalid API Key format" rather than "Failed". Same principle.

## Target: n8n

The MVP target. Output is a JSON file importable via n8n's "Import from File".

### Output structure

```json
{
  "name": "Employee onboarding",
  "nodes": [],
  "connections": {},
  "settings": { "executionOrder": "v1" },
  "pinData": {},
  "meta": { "instanceId": "flowforge" }
}
```

### Node lowering

Each `ResolvedNode` becomes an n8n node object:

```json
{
  "id": "a1b2c3d4-...",
  "name": "Send welcome message",
  "type": "n8n-nodes-base.slack",
  "typeVersion": 2.2,
  "position": [640, 300],
  "parameters": {
    "resource": "message",
    "operation": "post",
    "channel": "#general",
    "text": "=Welcome {{ $('New employee in BambooHR').item.json.employee.first_name }}!"
  },
  "credentials": {
    "slackOAuth2Api": { "id": "REPLACE_ME", "name": "Slack workspace" }
  },
  "onError": "continueErrorOutput",
  "retryOnFail": true,
  "maxTries": 3,
  "waitBetweenTries": 1000
}
```

Field by field:

| n8n field | Source |
| --- | --- |
| `id` | Deterministic UUIDv5 from workflow ID plus node ID. Not random. |
| `name` | FFIR `label`, de-duplicated with a numeric suffix if needed. |
| `type` | `bindings.n8n.node_type` |
| `typeVersion` | `bindings.n8n.type_version` |
| `position` | Computed by the layout algorithm. |
| `parameters` | `static_parameters` merged with mapped FFIR `parameters`. |
| `credentials` | Keyed by `bindings.n8n.credential_key`, value is a placeholder. |
| `onError` | Mapped from `error_policy.on_error`. |
| `retryOnFail` etc. | Mapped from `error_policy.retry`. |

`id` being a deterministic UUIDv5 rather than `randomUUID()` is what makes
golden-file testing possible. It is a small decision with outsized value.

### Parameter mapping

`parameter_map` paths use dots for nesting, so `otherOptions.thread_ts` builds
`{ "otherOptions": { "thread_ts": ... } }`. `static_parameters` merge in first
and mapped FFIR parameters override, which lets a capability pin
`resource: "message"` while still allowing FFIR to drive everything else.

Named `transform` functions from the binding run during mapping. They come from
a closed, unit-tested table. Registry data never contains executable code.

### Expression translation

The expression AST compiles to n8n syntax. n8n expressions are strings prefixed
with `=`, and node references go through `$('Node Name')`.

| FFIR AST | n8n output |
| --- | --- |
| `NodeRef("n_trigger", ["employee","email"])` | `{{ $('New employee in BambooHR').item.json.employee.email }}` |
| `NodeRef` on the immediate predecessor | `{{ $json.email }}` |
| `VarRef("company_domain")` | `{{ $vars.company_domain }}` |
| `Builtin("now")` | `{{ $now }}` |

Two details that are easy to get wrong and are therefore explicitly specified:

1. n8n references nodes by **display name**, not by ID. The lowering stage holds
   the ID-to-name map built during normalization, and every reference goes
   through it. A renamed node must not break its own references.
2. Any parameter containing at least one expression gets the `=` prefix on the
   whole string. A parameter with no expressions stays a plain literal. Adding
   `=` unnecessarily makes n8n evaluate a literal as an expression, which breaks
   strings containing braces.

### Connections

n8n's `connections` object is keyed by source node **name**:

```json
{
  "connections": {
    "New employee in BambooHR": {
      "main": [[{ "node": "Build the email address", "type": "main", "index": 0 }]]
    },
    "Create Google Workspace account": {
      "main": [[{ "node": "Announce in Slack", "type": "main", "index": 0 }]],
      "error": [[{ "node": "Alert IT on failure", "type": "main", "index": 0 }]]
    }
  }
}
```

The nested array is `[outputIndex][connectionIndex]`. FFIR `port` maps to
`outputIndex`:

| FFIR port | n8n output index |
| --- | --- |
| `main` | `0` |
| `true` | `0` on an If node |
| `false` | `1` on an If node |
| `error` | the error output, with `onError: "continueErrorOutput"` set |
| named switch case | index of that case in the Switch node's rules |

### Node kind lowering table

Every one of the nine FFIR node kinds has a defined lowering. A kind absent from
this table cannot be compiled, and adding a kind to FFIR means adding a row here
for every target.

| FFIR kind | n8n node type | Connection semantics |
| --- | --- | --- |
| `trigger` | From `bindings.n8n.node_type`. Webhook, schedule, or app trigger. | No inbound. One `main` output. |
| `action` | From `bindings.n8n.node_type`. | One inbound, `main` output, optional `error` output. |
| `transform` | `n8n-nodes-base.set` | One inbound, one `main` output. |
| `branch` | `n8n-nodes-base.if` or `.switch` | See Branch lowering below. |
| `merge` | `n8n-nodes-base.merge` | N inbound mapped to numbered inputs, one `main` output. |
| `loop` | `n8n-nodes-base.splitInBatches` | See Loop lowering below. |
| `ai` | From `bindings.n8n.node_type`, typically `.openAi` or an LLM chain node. | One inbound, one `main` output. |
| `wait` | `n8n-nodes-base.wait` | One inbound, one `main` output. |
| `error_handler` | From `bindings.n8n.node_type`, whatever the handler actually does. | Inbound only from `error` ports. One `main` output. |

Four of these need more than a row.

**`transform`** lowers to a Set node in "manual mapping" mode. Each entry in the
FFIR `assignments` array becomes one field assignment, with the FFIR expression
compiled to n8n syntax and `includeOtherFields` set true so upstream data passes
through. A transform that assigns no fields is a validation error, not an
identity node.

**`merge`** is the only kind with multiple **inbound** connections, and n8n's
Merge node has numbered inputs rather than a single input. Inbound edges sort by
source node ID for determinism, and edge *i* connects to input index *i*. n8n's
Merge node supports a fixed maximum number of inputs, so a merge with more
inbound edges than the node allows lowers to a chain of Merge nodes. The FFIR
`mode` parameter maps to n8n's `combine`, `append`, or `chooseBranch` modes.

**`ai`** carries its prompt and output schema in `parameters`, which the binding
maps onto whichever LLM node the registry names. Two rules: the FlowForge system
prompt is never injected into a generated `ai` node, because that node runs on
the user's infrastructure with the user's own model credentials and has nothing
to do with our generation pipeline. And an `ai` node's declared output schema
becomes part of the registry-declared output shape for expression validation, so
downstream nodes can reference its fields.

**`error_handler`** is not a distinct n8n node type. It lowers exactly like an
`action`, and what makes it an error handler is purely that its inbound edges
carry `port: "error"`. The kind exists in FFIR so the canvas can render it on a
separate visual track and so the validator can enforce rule 17. The compiler
treats it as an action whose upstream nodes have
`onError: "continueErrorOutput"` set.

### Branch lowering

A `branch` node with exactly two outbound edges (`true` and `false`) lowers to
`n8n-nodes-base.if`. Three or more named cases lower to
`n8n-nodes-base.switch`. FFIR condition operators map onto n8n's condition
model:

| FFIR operator | n8n |
| --- | --- |
| `equals` | `string.equals` |
| `not_equals` | `string.notEquals` |
| `contains` | `string.contains` |
| `greater_than` | `number.gt` |
| `less_than` | `number.lt` |
| `not_contains` | `string.notContains` |
| `is_empty` | `string.isEmpty` |
| `is_not_empty` | `string.isNotEmpty` |
| `matches_regex` | `string.regex` |

All nine FFIR operators map. `is_empty` and `is_not_empty` take no right operand
and lower to a single-operand n8n condition; the other seven take both.

Operand type is inferred from the registry's declared output type for the
referenced field, falling back to string. Getting this wrong means comparing
`"10" > "9"` lexically, which is false and surprising, so the inference is
tested against every operator.

### Loop lowering

`core.loop.for_each` lowers to `n8n-nodes-base.splitInBatches`, whose `done`
output is index 0 and `loop` output is index 1. Note this is inverted relative
to intuition and to FFIR's ordering, so the mapping is explicit:

- FFIR `each` port maps to n8n output index **1**
- FFIR `done` port maps to n8n output index **0**
- The FFIR back-edge maps to a connection from the last body node back into the
  Split In Batches node's input.

`max_iterations` has no direct n8n equivalent. The compiler emits it as
`batchSize` guidance plus a note in the setup guide, and records a warning that
the bound is advisory on this platform. That is an honest partial mapping rather
than a pretended one.

### Layout

The design system specifies a dot-grid canvas with Vercel-style deployment-card
nodes. Positions are computed by a layered graph layout:

1. Assign each node a layer equal to its longest path from the trigger.
2. Order nodes within a layer to minimize edge crossings.
3. Place at `x = layer * 220`, `y = index * 160`, both multiples of the grid.
4. Error handlers get a vertical offset so they read as a separate track.

Layout is computed for the export and also written to `metadata.layout` so the
React Flow canvas and the exported n8n file agree. A user who sees a shape in
FlowForge and a different shape in n8n loses confidence in the tool.

### Credentials

The compiler emits placeholders, never values:

```json
{
  "credentials": {
    "slackOAuth2Api": { "id": "REPLACE_ME", "name": "Slack workspace" }
  }
}
```

`name` comes from the FFIR credential `label`. On import, n8n shows an
unconfigured credential and the user selects or creates a real one. The setup
guide lists every credential with its auth type, required scopes, and the
registry's `setup_notes`.

The compiler refuses to emit any parameter value matching a secret pattern. This
duplicates a validator rule on purpose: it is a safety property, and safety
properties get belt and braces.

## Target: Make.com

Not in the MVP. Specified here to prove the abstraction holds.

Make scenarios are a flat module list with an explicit `flow` array and
`routes` for branching.

| Divergence | Handling |
| --- | --- |
| Modules are numbered, not named | Assign sequential IDs during lowering; expressions become `{{N.field}}` where N is the module number. |
| Branching uses a Router module | A `branch` node lowers to a Router plus one route per outbound edge, with filters carrying the conditions. |
| Loops use Iterator plus Aggregator | `core.loop.for_each` lowers to an Iterator; the `done` port needs an Aggregator inserted, which has no FFIR equivalent and is synthesized. |
| Error handling is per-module handlers | `on_error: "route"` lowers to an error handler route rather than a separate output port. |

`TargetCapabilities` for Make: `branching: "router"`, `loops: true`,
`errorRouting: true`, `retryPolicy: true`, `expressionSyntax: "make"`.

Nothing above requires an FFIR change. That is the claim being tested, and it
holds because FFIR describes intent rather than mechanism.

## Target: Zapier

The genuinely constrained one, and worth specifying precisely because it is
where the abstraction is most likely to leak.

`TargetCapabilities`: `branching: "linear_only"`, `loops: false`,
`errorRouting: false`, `retryPolicy: false`.

The pre-lowering capability check rejects any FFIR document using branch, loop,
or error routing, with the node-naming error message shown earlier. Zapier
export is therefore only offered when the generated workflow is linear, and the
UI should gray out the option with a tooltip explaining why rather than letting
the user click into a failure.

This is the correct outcome. The alternative, silently flattening a branch into
a linear sequence, produces a Zap that runs both paths unconditionally. That is
a data-corrupting bug delivered as a feature.

## Target: Node-RED

`TargetCapabilities`: `branching: "full"`, `loops: true`, `errorRouting: true`,
`expressionSyntax: "javascript"`.

Node-RED's model is closest to FFIR's: a flat array of nodes each carrying a
`wires` array, which is nearly a direct transcription of FFIR's edge list. The
main divergences are that every node needs an `x`/`y`/`z` tab assignment, and
that Node-RED's message-passing model means `msg.payload` replaces the named
node references, so the expression compiler emits `msg.` paths and inserts
Change nodes where FFIR references a non-adjacent predecessor.

## Renderers Are Not the Compiler

Mermaid, the setup guide, and the integrations list are **renderers**, not
compiler targets. They live in `packages/renderers` as siblings of the compiler.

The distinction is real: a compiler target produces something executable on
another platform and must satisfy that platform's semantics. A renderer produces
something a human reads. They have different correctness criteria, different
tests, and no reason to share the `Target` interface.

| Renderer | Input | Output |
| --- | --- | --- |
| `mermaid` | FFIR | Mermaid `flowchart TD` source |
| `setup_guide` | FFIR + registry | Markdown |
| `integrations` | FFIR + registry | Structured list for the UI |
| `react_flow` | FFIR + `metadata.layout` | Nodes and edges for the canvas |

All four are pure functions of FFIR. This is the payoff from the
Claude-emits-FFIR-only decision: four artifacts, zero additional model calls,
zero additional hallucination surfaces, all unit-testable.

The mermaid renderer maps node `kind` to shape (`trigger` to stadium, `branch`
to rhombus, `action` to rectangle) and colors edges by port, matching the
design system's node-type color coding.

## Error Model

```ts
type CompileError =
  | { stage: "validate";  code: string; nodeId?: string; message: string }
  | { stage: "resolve";   code: "capability_unknown"; capability: string }
  | { stage: "lower";     code: "unsupported_feature"; feature: string; nodeId: string }
  | { stage: "emit";      code: "target_limit_exceeded"; detail: string }
  | { stage: "verify";    code: "internal_inconsistency"; detail: string };
```

Every error carries a stage, a stable machine-readable code, and where possible
the offending node ID so the UI can highlight it on the canvas. Stage tells the
caller what to do: `validate` errors feed the AI repair loop, `resolve` errors
trigger registry degradation, `lower` errors are shown to the user as an
unsupported-target message, and `verify` errors are internal bugs that page us.

Warnings are separate from errors and never block compilation:

```ts
type CompileWarning = {
  code: "capability_degraded" | "capability_unknown" | "policy_unsupported"
      | "trigger_mechanism_changed" | "loop_bound_advisory";
  nodeId?: string;
  message: string;   // written for the end user, actionable
};
```

## Testing Strategy

Because the compiler is a pure function, testing is unusually tractable and
should be exhaustive.

**Golden files.** `packages/compiler/test/golden/<case>/` holds `input.ffir.json`
and `expected.n8n.json`. The test compiles and diffs. Determinism is what makes
this work: no random UUIDs, no timestamps. Any intentional output change shows
up as a reviewable diff, which is exactly what you want from a component whose
bugs are otherwise silent.

**Property tests.** Over generated FFIR documents:

- Compiling twice yields identical bytes.
- Every FFIR node appears exactly once in the output.
- Every FFIR edge has a corresponding connection.
- No output contains a node type absent from the registry.
- No output contains a string matching a secret pattern.

**Round-trip tests.** For each target that has an importer, parse the emitted
output back and confirm the node and edge count matches.

**Manual import gate.** Before any release, a human imports the golden n8n
outputs into a real n8n instance and confirms they load without error. This is
the one thing automation cannot fully replace, and it is a required checkpoint
in the roadmap rather than a nice-to-have.

## Related Documents

- [WORKFLOW_SCHEMA.md](WORKFLOW_SCHEMA.md) defines the compiler's input.
- [NODE_REGISTRY.md](NODE_REGISTRY.md) defines the `bindings` the compiler reads.
- [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) shows where the compiler lives
  and the dependency rule it must obey.
