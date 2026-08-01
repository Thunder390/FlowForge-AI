# Project Structure

The workspace layout, what each package is responsible for, and the dependency
rules that keep the architecture's guarantees true in code rather than only on
paper.

## Workspace

pnpm workspace. TypeScript throughout, so one FFIR type definition is shared by
the AI layer, the compiler, and the UI. A type that exists once cannot drift.

```
flowforge/
├── apps/
│   ├── web/                    Next.js: UI + route handlers
│   └── worker/                 Job consumer
├── packages/
│   ├── ffir/                   Schema, types, validator, migrations
│   ├── registry/               Registry loader and types
│   ├── compiler/               FFIR -> platform artifacts
│   ├── renderers/              FFIR -> mermaid, guide, integrations, canvas
│   ├── ai/                     Prompts, providers, generation, validation 2-3
│   ├── pipeline/               Orchestrator. Owns the generation state machine.
│   ├── db/                     Schema, migrations, repositories
│   ├── evals/                  Corpus, runner, scoring
│   ├── ui/                     Design system primitives
│   └── config/                 Shared tsconfig, eslint, prettier
├── tools/
│   └── registry-gen/           Build-time n8n introspection
└── docs/                       These documents
```

## The Dependency Rule

This is the most important thing in this document.

```
                    ffir          (depends on nothing)
                   ╱   ╲
           registry     renderers
             │  ╲          │
             │   ╲         │
            ai    compiler │
             ╲       │    ╱
              ╲      │   ╱
               pipeline          (imports all of the above)
                  │
              apps/*
```

**`packages/ai` must not import `packages/compiler`.** Both depend on `ffir` and
`registry`. Neither depends on the other.

This is the structural expression of the architecture's central decision: the AI
layer produces FFIR and knows nothing about any target platform. The moment the
AI layer can import the compiler, someone will reach for a platform detail from
inside a prompt, and the claim that adding Make.com requires no AI change becomes
false.

### Why `packages/pipeline` exists

Validation stage 5 is a compile dry-run, which means something has to call both
`ai` and `compiler`. That something cannot be `ai`.

`pipeline` is that layer. It owns the generation state machine: classify, pass A,
retrieve, pass B, merge, validate stages 0 through 4, compile dry-run, persist.
It is the only package that imports both.

Without it the import rule is unenforceable and the architecture quietly
collapses into a single tangled layer. Naming the orchestrator is what keeps the
boundary real.

### Enforcement, not assertion

A rule in a document is a suggestion. Three mechanisms make this one binding:

1. **ESLint `no-restricted-imports`** in `packages/ai/.eslintrc`, banning
   `@flowforge/compiler` and every target package. Fails lint, fails CI.
2. **`dependencies` in `packages/ai/package.json` simply do not list the
   compiler.** A pnpm workspace with strict node-linker means the import fails to
   resolve at build time, not at review time.
3. **A CI check** that reads each package's manifest and asserts the dependency
   graph matches the diagram above.

Layer 2 is the one that actually works. The others catch it earlier and explain
why.

## Packages

### `packages/ffir`

The schema and everything that operates on it. Depends on nothing.

```
ffir/
├── src/
│   ├── types.ts              Node, Edge, Credential, Variable, Document
│   ├── schema.json           JSON Schema for the document
│   ├── validate/
│   │   ├── limits.ts         Stage 0, document limits
│   │   ├── schema.ts         Stage 1
│   │   ├── graph.ts          Stage 4, rules 1-18
│   │   └── codes.ts          Error code enum, shared vocabulary
│   ├── expression/
│   │   ├── parse.ts          Grammar v1 -> AST
│   │   ├── ast.ts
│   │   └── grammar/v1.ts     Dispatched on expression_grammar
│   └── migrations/
│       └── v1_to_v2.ts       Added per major version
```

Validation stages 2 and 3 live in `registry` rather than here, because they need
the registry and `ffir` must not depend on it. `ai` re-exports them, since
owning those stages is a fact about the architecture rather than about which
package the code sits in. Stages 0, 1, and 4 are pure structure and belong here.

The expression parser is here, not in the compiler, so every consumer parses
identically. Regex-rewriting expressions per target is how escaping bugs get
shipped.

### `packages/registry`

Loads and serves built registry artifacts. Does not build them.

```
registry/
├── src/
│   ├── types.ts              Capability, Parameter, Binding, Auth
│   ├── load.ts               Version-keyed artifact loading, LRU
│   ├── resolve.ts            Capability ID -> entry
│   ├── index.ts              Alias search for retrieval
│   ├── validate-params.ts    Names and values against an entry
│   └── validate-document.ts  Validation stages 2 and 3, over a document
└── build/<version>/          Published artifacts, gitignored
    ├── capabilities/
    ├── bindings/<platform>/
    └── index.json
```

`validate-params.ts` implements validation stage 3's rules, covering parameter
**names** as well as values. `validate-document.ts` walks a document through
stages 2 and 3 using them. Both live here because the rules are registry data
and the walk needs nothing but FFIR types and a `Registry`.

They are also the only stages two sibling packages both need: `ai` runs them
before generating, and `compiler` runs them at stage 1 because it must not
assume its caller validated. Neither may import the other, so a home under the
package they both already depend on is the only one that serves both without
duplicating rules 7, 8, and 13.

### `packages/compiler`

FFIR to platform artifacts. A pure function.

```
compiler/
├── src/
│   ├── compile.ts            The 6-stage pipeline
│   ├── validate.ts           Stage 1, composed from ffir and registry
│   ├── resolve.ts            Stage 2, bindings and degradation
│   ├── normalize.ts          Stage 3, target-independent
│   ├── capabilities.ts       The pre-lowering capability check
│   ├── errors.ts             CompileError, CompileWarning, CompileResult
│   ├── target.ts             Target and TargetCapabilities interfaces
│   ├── transforms.ts         Named parameter transforms, closed set
│   ├── uuid.ts               Deterministic UUIDv5 for node and part ids
│   └── targets/
│       ├── n8n/
│       │   ├── ir.ts         n8n's own workflow model
│       │   ├── lower.ts      All 9 node kinds, and connections
│       │   ├── parameters.ts static + parameter_map + transform + `=` prefix
│       │   ├── conditions.ts Branch conditions and operand type inference
│       │   ├── layout.ts     Layered graph layout
│       │   ├── emit.ts       Deterministic serialization
│       │   ├── verify.ts
│       │   └── expression.ts AST -> n8n syntax
│       ├── make/             Post-MVP
│       └── zapier/           Post-MVP
└── test/golden/<case>/
    ├── input.ffir.json
    └── expected.n8n.json
```

No network, no filesystem, no clock, no randomness. Node IDs are deterministic
UUIDv5 rather than random, which is what makes golden-file testing work. A test
reads every source file and fails on `Date`, `Math.random`, `randomUUID`, or a
filesystem import.

Adding a target adds one directory under `targets/` and touches nothing else.
The n8n target proved that: it required no change to `ffir`, `registry`, `ai`,
or any shared compiler stage. A test keeps it true by failing if the string
`n8n-nodes-base` appears in any file outside `targets/`.

### `packages/renderers`

FFIR to human-facing artifacts. Siblings of the compiler, not targets of it,
because their correctness criteria differ: a target must satisfy another
platform's semantics, a renderer must be readable.

```
renderers/
└── src/
    ├── mermaid.ts
    ├── setup-guide.ts        Needs registry for auth setup notes
    ├── integrations.ts
    ├── react-flow.ts         Uses metadata.layout
    └── order.ts              Reading order, shared by mermaid and the guide
```

Depends on `ffir` and `registry`, and on neither `compiler` nor `ai`. A test
reads the manifest and every source file to keep that true. The temptation it
guards against is concrete: `react-flow` needs canvas positions and the compiler
has a layout algorithm, so importing it would be one line. Instead the positions
travel through `metadata.layout`, which keeps one producer for a value the
canvas and the exported file must agree on.

### `packages/ai`

Prompts, providers, generation passes, and the registry-dependent validation
stages. **Does not import `compiler`.**

```
ai/
├── src/
│   ├── provider/
│   │   ├── types.ts             ModelProvider, ProviderCapabilities
│   │   ├── anthropic-wire.ts    The wire format, as pure functions
│   │   ├── anthropic.ts         The SDK adapter over it
│   │   ├── replay.ts            Fixture playback for CI
│   │   └── resolve.ts           Per-tenant credential resolution
│   ├── retrieval/
│   │   ├── types.ts             CapabilityRetriever
│   │   ├── inline.ts            Full catalog in the cached prefix
│   │   └── tool-search.ts       Post-MVP, for >200 capabilities
│   ├── passes/
│   │   ├── call.ts              Stop reason, parse, validate. Shared by both.
│   │   ├── classify.ts          M9
│   │   ├── plan.ts              Pass A
│   │   ├── parameters.ts        Pass B, synthesizes the closed schema
│   │   └── repair.ts            M9
│   ├── merge.ts                 Pass output -> FFIR
│   ├── validate.ts              Stages 2 and 3, re-exported from registry
│   ├── structured.ts            Parse model output against a schema
│   ├── prompts.ts               Versioned prompt loading
│   ├── schema-synth.ts          Builds the pass B schema from registry data
│   └── __fixtures__/            Recorded provider responses
└── prompts/
    ├── classifier/v1.md         M9
    ├── pass_a/v1.md
    ├── pass_b/v1.md
    └── repair/v1.md             M9
```

Prompts are versioned files, not string literals, because a generation record
must be attributable to a prompt revision. `metadata.prompt_version` names each
of them rather than carrying one counter, because a generation uses several and
a single number bumped by hand drifts the first time two are edited together.
See [OBSERVABILITY_AND_EVALS.md](OBSERVABILITY_AND_EVALS.md).

`schema-synth.ts` is small and is the highest-value file in the package: it turns
a resolved capability set into the closed JSON schema that makes invented
parameter names structurally impossible.

`anthropic-wire.ts` and `anthropic.ts` are one integration split on
testability. Everything that constitutes a decision, which parameters are set,
which are deliberately absent, where the cache breakpoint lands, and how a
finished message is read, is a pure function with its own tests. What is left in
the adapter is a loop over a stream, which is the only part that genuinely needs
a network to be wrong.

`structured.ts` validates model output against the schema the request was
constrained to, which is redundant on a provider with strict structured outputs
and kept anyway. That guarantee belongs to one provider rather than to the
architecture, and it does not hold at all on a replay fixture, which is what
every test below M9 runs against.

### `packages/pipeline`

The orchestrator. Imports `ai`, `compiler`, `registry`, `ffir`, `renderers`, `db`.

```
pipeline/
├── src/
│   ├── generate.ts           The state machine
│   ├── iterate.ts            Chat iteration, carries baseVersionId (M17)
│   ├── stages.ts             Stage enum, shared with tracing
│   ├── events.ts             Event emission into the log
│   └── errors.ts             Unified error taxonomy across layers
```

`errors.ts` is where the compiler's `CompileError`, the AI layer's validation
codes, and the API's error envelope reconcile into one namespace. Three
independent error vocabularies is how a support conversation becomes
archaeology. The reconciliation deliberately does not renumber anything: each
failure keeps the code its own specification uses, because that code is what the
repair prompt prints and what someone greps a log for. What it adds is the two
things no single vocabulary provides, which stage produced the failure and
whether trying again could possibly help.

`stages.ts` declares all seven stages including the two M9 adds, for the same
reason `ffir`'s `codes.ts` declares codes for stages it does not implement: the
file is the vocabulary, and tracing, the event log, and the UI all have to name
the same stages. `IMPLEMENTED_STAGES` records which ones actually run, and a
test pins the events `generate` emits against it, so a stage cannot start or
stop running without the declaration following.

`events.ts` drives progress from real pipeline position, never from a timer. A
progress indicator that advances while nothing is happening is a lie the user
eventually notices, and it gives no signal when a call has stalled.

### `packages/db`

```
db/
├── src/
│   ├── schema.ts             Table definitions
│   ├── repositories/         Org-scoped access only
│   └── rls.sql               Row-level security policies
└── migrations/
```

Repositories take an authenticated context and cannot build a query without an
org scope. Raw query builders are not exported. RLS is the second layer. See
[SECURITY.md](SECURITY.md).

### `packages/ui`

The design system from the Design System document, as code.

```
ui/
├── tokens/
│   ├── colors.ts             #09090B, #18181B, #27272A, #EDEDED, #3B82F6, #8B5CF6
│   ├── typography.ts         Geist / Geist Mono
│   ├── spacing.ts
│   └── motion.ts
├── primitives/
│   ├── Button.tsx            primary | ai-action | ghost
│   ├── Input.tsx             Raycast style, borderless until focused
│   ├── Card.tsx
│   └── Skeleton.tsx          Shimmer, no spinners
└── patterns/
    ├── CommandPalette.tsx
    ├── NodeCard.tsx          Vercel-style, colored top edge by app type
    └── Toast.tsx
```

Tokens are data, not Tailwind classes, so the compiler's canvas layout and the UI
can agree on grid spacing. The dot-grid canvas and the exported n8n positions come
from the same numbers.

### `packages/evals`

```
evals/
├── corpus/                   50 cases as JSON
├── runner.ts
├── score.ts                  Assertion evaluation
└── report.ts
```

### `tools/registry-gen`

Build-time only. `n8n-nodes-base` is a `devDependency` here and appears nowhere
else in the workspace, which is what keeps it out of the runtime bundle.

```
registry-gen/
├── introspect.ts             Read n8n node descriptions
├── derive.ts                 resource x operation -> capability IDs
├── merge.ts                  Apply the curated overlay
├── build-index.ts
├── validate.ts               The 7 build rules
└── overlay/                  Hand-curated, committed to git
    ├── slack.json
    └── ...
```

`overlay/` is committed; `build/` is not. The overlay is the durable human asset
and is sparse: it states only what it improves.

## Apps

### `apps/web`

```
web/
├── app/
│   ├── (marketing)/          Landing, pricing
│   ├── (app)/                Dashboard, canvas, settings
│   ├── library/[slug]/       Public marketplace pages
│   └── api/                  Route handlers, thin
└── components/
```

Route handlers authenticate, authorize, validate, write a row, and return. No
business logic. Generation work happens in the worker.

### `apps/worker`

Claims jobs, runs `pipeline`, appends events, persists results. Deployable
independently of the web app so generation capacity scales separately from
request capacity.

## Testing Layout

| Kind | Location | Speed |
| --- | --- | --- |
| Unit | Colocated `*.test.ts` | Fast |
| Golden files | `compiler/test/golden/` | Fast |
| Fixture replay | `ai/fixtures/` | Fast |
| Integration | `pipeline/test/` | Medium |
| Eval, live model | `packages/evals` | Slow, nightly |

Everything except the eval suite runs on every commit. That is possible because
the compiler is pure and the provider is swappable for a replay implementation.

## Configuration

Environment variables are parsed once at startup through a schema and exported as
a typed object. `process.env` is not read anywhere else, so a missing variable
fails at boot with a clear message rather than as `undefined` in a request three
hours later.

| Variable | Used by |
| --- | --- |
| `DATABASE_URL` | web, worker |
| `ANTHROPIC_API_KEY` | worker (platform default only) |
| `REGISTRY_BUCKET_URL` | web, worker |
| `REGISTRY_DEFAULT_VERSION` | web, worker |
| `ENCRYPTION_KEY` | web, worker |

Tenant provider keys are **not** environment variables. They live encrypted in
`provider_credentials` and resolve per request. See
[AI_SPEC.md](AI_SPEC.md).

## Related Documents

- [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) owns what these apps do at
  runtime.
- [DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md) sequences the order these are
  built in.
