# Development Roadmap

Milestones sized to one coding session each. Every milestone has a "done when"
that is a command you can run, not a feeling.

## Sequencing Principle

**M1 through M8 build and prove the entire generation engine with no UI at all.**

That is deliberate for three reasons. The compiler and validator are where
correctness lives, and they are testable as pure functions. A bug found in M5 by
a golden-file test costs minutes; the same bug found through a canvas in M14
costs an afternoon of guessing whether the problem is the compiler, the renderer,
or React state. And it front-loads the work that has no framework prerequisites,
which matters given the current skill ramp.

By the end of M8 you can type a sentence into a terminal and get a workflow file
that imports into n8n. Everything after that is making it a product.

## Phase 1: The Engine (no UI)

### M1. Workspace and FFIR types (done)
Scaffold the pnpm workspace. `packages/ffir` with types, JSON Schema, and stage 0
and 1 validators (document limits, schema conformance).

**Done when:** `pnpm test` passes with tests proving a valid document validates,
a malformed one fails with the right error code, and a document exceeding each
limit in the limits table is rejected.

Met on 2026-07-28. 71 tests, all nine limits covered by a test that fails if a
limit is added to the table and left untested.

### M2. Expression parser (done)
Grammar v1 parser producing an AST. Version dispatch on `expression_grammar`.

**Done when:** every example in the WORKFLOW_SCHEMA grammar section parses to the
expected AST, malformed expressions produce positioned errors, and an unknown
grammar version is rejected rather than parsed.

Met on 2026-07-29. 158 tests. The dispatch table is pinned to
`SUPPORTED_EXPRESSION_GRAMMARS` by a test, and a second test pins the parser's
path depth against the stage 0 scanner's regex approximation, which is the one
place two implementations of the same idea coexist by design.

### M3. Graph validator (done)
Validation stage 4: rules 1 through 18. Returns all failures, not the first.

**Done when:** one test per rule, each with a document that violates only that
rule, asserting the specific error code. Plus one document violating three rules
that returns exactly three errors.

Met on 2026-07-29. 276 tests. Fifteen rules, not eighteen: rules 7, 8, and 13
resolve against the node registry, which `ffir` must not import, so they are
stages 2 and 3 and land in M5. `RULE_OWNERSHIP` in `validate/graph.ts` records
the split in code and a test pins it, so the gap cannot be forgotten.

Rule 4 is the one rule that cannot be violated alone: an edge into the trigger
comes either from a node the trigger reaches, which is a cycle, or from one it
does not, which is unreachable. Its test asserts both codes and says why.

### M4. Registry format and fixtures
`packages/registry`: types, loader, resolver, alias index. Hand-write capability
and binding fixtures for six integrations covering the worked example. No
generator yet.

**Done when:** the loader reads the fixture artifacts, `resolve()` returns the
right entry, alias search finds `slack.message.send` from "post to slack", and
the split `capabilities/` and `bindings/n8n/` artifacts join correctly by ID.

Met on 2026-07-31. 204 tests. Six integrations: `core` and `http` for the two
reserved namespaces, `slack`, `bamboohr`, and `google_workspace` for the worked
example, and `openai` so that every node kind except `error_handler` has a
capability behind it, which M6b needs for a golden case per kind. The artifacts
live in `packages/registry/fixtures/<version>/`, a sibling of the gitignored
`build/`, because M20 has to diff a generated build against them.

`buildIndex` is a pure function and a test asserts the shipped `index.json` is
byte-identical to its output, so the one derived artifact cannot go stale.

The loader enforces the subset of the seven build validation rules that are
properties of a loaded registry rather than of a build process: a duplicate ID,
an orphaned binding, a colliding alias, or a `parameter_map` naming an
undeclared parameter would each corrupt the in-memory model silently. The full
gate stays with the generator in M20. `validate-params.ts` is deliberately
absent, being validation stage 3 and therefore M5.

The bindings are written from n8n's documentation rather than from
introspection, which makes node types and parameter paths the fixtures' weakest
claim. M20's generator and M9's manual import gate are what settle them.

### M5. Parameter validation
Validation stages 2 and 3, including the parameter **name** check.

**Done when:** an unknown capability is rejected, an unknown parameter name is
rejected, a bad value is rejected by its registry rule, and each produces its own
error code. The name check has an explicit test, because it is the one guarding
against a weaker future provider.

Met on 2026-07-31. 595 tests across the three packages. The rules live in
`packages/registry/src/validate-params.ts` because they *are* registry data;
`packages/ai/src/validate.ts` walks the document and turns what comes back into
FFIR codes. That is the whole of `packages/ai` so far. Rule 8 reports
`invalid_parameter_value` and carries the specific NODE_REGISTRY failure code in
`details.failure`, so the repair prompt can print `param_pattern_failed` while
the vocabulary in `codes.ts` keeps one code per rule.

A value carrying an expression is exempt from every rule about its shape.
`"#{{ $vars.channel }}"` is legal for a parameter whose pattern demands a
leading `#`, and what it resolves to is unknowable until the workflow runs, so
checking it would reject most real workflows. Detecting one needs no parser:
grammar v1 has no escape for a literal `{{`, which makes its presence an exact
test.

Stage 2 also checks that every `credentials[].capability_scope` names a real
integration, the second half of its row in the AI_SPEC stage table and something
rule 10 cannot see, because rule 10 compares a scope against the capabilities
that reference it and a credential no node uses is invisible to it. That is the
one new error code, `unknown_capability_scope`.

Neither stage reads a binding, and a test proves it by validating against a
registry with every binding stripped and getting an identical result. Whether a
target can express a capability is settled at registry load and again at the
compile dry-run, which is stage 5 and belongs to `pipeline` because it is the
only layer allowed to call both sides.

### M6a. Compiler core (done)
Stages 1 through 3 of the pipeline, which every target shares, plus the `Target`
interface stages 4 through 6 implement and the error model. No target.

**Done when:** `pnpm test` passes with the worked example normalizing to a graph
whose node order, display names, and applied defaults are pinned by assertion;
normalizing twice producing byte-identical output; a `null` binding and an
absent binding key each degrading to `http.request.send` under their own warning
code; and the capability pre-check rejecting a branching document against a
`linear_only` target by node id.

Met on 2026-08-01. 142 tests in `packages/compiler`, 741 across the workspace.

Split out of M6 because the target-independent half is two thirds of the
compiler and is worth proving on its own. Written with no target to lean on, its
independence is a property of the code rather than an intention: the only thing
implementing `Target` is a test double whose capabilities are settable per test,
which is also what let the pre-lowering check be driven through combinations no
real platform has yet.

Stage 1 forced a decision. The compiler is a public library boundary and must
not assume its caller validated, so it runs the full gate, but validation stages
2 and 3 lived in `ai` and `compiler` may not import it. They moved to
`registry`, which is where the rules they walk already lived and which both
packages already depend on; `ai` re-exports all three, so its surface is
unchanged. Duplicating the walk would have put rules 7, 8, and 13 behind two
implementations that drift.

Three ordering decisions are pinned by tests because determinism rests on them.
Parameter keys are emitted in the registry's declaration order rather than the
document's, so two documents differing only in JSON key order normalize
identically. Topological ties break on node id. Display names are assigned in
document order rather than topological order, so that rewiring an edge cannot
rename an unrelated node and break every expression referencing it by name.

`transforms.ts` is deliberately absent. Named transforms run during parameter
mapping, which COMPILER_ARCHITECTURE places in stage 4, so they belong to M6b
along with `parameter_map`.

### M6b. n8n target (done)
Stages 4 through 6 for n8n, covering all nine node kinds. Deterministic emit.

**Done when:** the BambooHR onboarding example from WORKFLOW_SCHEMA compiles to
n8n JSON matching a golden file, compiling twice produces byte-identical output,
and there is a golden case per node kind.

Met on 2026-08-01. 305 tests in `packages/compiler`, 904 across the workspace.
Seven golden cases in `test/golden/`, covering all nine kinds between them, with
a test that fails if a kind stops being covered. `UPDATE_GOLDEN=1 pnpm test`
regenerates them.

Adding the target required no change to `ffir`, `registry`, `ai`, or any shared
compiler stage. That is the design goal tested rather than asserted, and a test
now pins it: no file outside `targets/` may contain the string
`n8n-nodes-base`.

Node ids are UUIDv5 of the workflow id and the node id, checked against RFC
4122's own published vector so the claim is that it *is* UUIDv5 rather than that
it is some stable hash of ours. Every nested id n8n wants, Set-node assignments
and condition rows among them, is derived the same way. Without this there are
no golden files, because every compile would differ.

Four decisions worth recording. The `=` prefix is applied last, to the finished
string after transforms run, because `object_to_json_string` turns a whole
object into one string and the prefix belongs to that string rather than to
anything inside it; detecting one needs no bookkeeping, since grammar v1 has no
escape for a literal `{{`. Operand type inference reads the registry's declared
output type but cannot make `gt` or `lt` non-numeric, which is the case it
exists for. A node with an outbound error edge is routed regardless of its
policy, because the edge is the stronger statement. And `onError: stopWorkflow`
is omitted rather than written out, since it is n8n's own default and a golden
file should show the decisions a workflow actually made.

Two claims here are documentation-derived and are what M9's manual import gate
settles: the `error` connection key, which follows COMPILER_ARCHITECTURE's
connections example rather than the `main[1]` form recent n8n also accepts, and
the hand-written `parameter_map` paths in the fixtures. `core.branch.if` maps
`case_sensitive` to `options.caseSensitive`, which does not look like where n8n's
If node reads it; the compiler honours the binding anyway and carries the flag
into the condition group as well, because second-guessing registry data is not
its job.

The one thing knowingly lost: an FFIR parameter with no `parameter_map` entry is
dropped. Registry build rule 4 permits that, and the closed five-code warning
vocabulary has no member for it, so only the two cases the architecture names
raise a warning. `core.loop.for_each`'s `items` is the case that costs
something, since Split In Batches iterates whatever arrives on its input rather
than a collection the step names.

### M7. Renderers
Mermaid, setup guide, integrations list, React Flow layout data.

**Done when:** the worked example produces a mermaid diagram that renders, a
setup guide listing all three credentials with their scopes, and layout positions
on the grid.

### M8. AI layer against fixtures
`ModelProvider` interface, Anthropic implementation, replay provider, both
passes, schema synthesis, merge. Wired through `packages/pipeline`. Tested
entirely against recorded fixtures.

**Done when:** a recorded fixture set drives a full generation to validated FFIR
with no live model call, and `schema-synth` produces a closed schema whose
`additionalProperties` is false at every level for the worked example.

**Review checkpoint 1.** Before M9: confirm the dependency graph matches
PROJECT_STRUCTURE, that `packages/ai` has no path to `packages/compiler`, and
that the CI dependency check is actually running.

### M9. Live generation and the repair loop
Real model calls. Classifier, retry ladder, repair prompt, compile dry-run gate.

**Done when:** `pnpm generate "when a stripe charge succeeds post to #finance"`
prints valid FFIR and writes an importable n8n file. A deliberately broken
fixture triggers a repair that succeeds.

**Manual gate:** import three generated workflows into a real n8n instance and
confirm they load without error. This cannot be automated and is required.

## Phase 2: The Service

### M10. Database and repositories
`packages/db`: schema, migrations, org-scoped repositories, RLS policies.

**Done when:** migrations run clean, and an isolation test proves a query
authenticated as org A returns zero rows for org B data with RLS on and the
repository scope deliberately removed.

### M11. Durable job model
Jobs and events tables, Postgres queue with `SKIP LOCKED`, lease and heartbeat,
`apps/worker` consuming.

**Done when:** a job enqueued by a test is claimed and completed by the worker,
two workers never claim the same job, and a killed worker's job returns to
`queued` after lease expiry.

### M12. API and SSE
Route handlers, error envelope, idempotency keys, SSE with replay from
`Last-Event-ID`.

**Done when:** `POST /api/generations` returns 202 immediately, the SSE stream
delivers stage events, a client that disconnects mid-generation and reconnects
receives every missed event exactly once, and a duplicate idempotency key returns
the original job.

### M13. Auth, tenancy, and metering
Auth provider, organizations, memberships, roles, plan enforcement in the enqueue
transaction, usage records.

**Done when:** a Hobby org is blocked at its sixth generation of the month, the
block happens before enqueue, and concurrent requests at the limit boundary do
not both succeed.

**Review checkpoint 2.** Before M14: security review against SECURITY.md.
Tenant isolation tests, secret scanner coverage, rate limits in place.

## Phase 3: The Product

### M14. Results view
The four-tab result: visual flow, mermaid, n8n JSON, setup guide. Design system
tokens and primitives.

**Done when:** a generated workflow renders in all four tabs and the JSON tab
downloads a file that imports into n8n.

Built before the canvas deliberately: it is where the value is delivered, and it
needs no interactive graph editing.

### M15. Canvas
React Flow, dot grid, node cards with app-type color edges, animated edges.

**Done when:** the worked example renders with correct layout, branches read
clearly, and error edges are visually distinct.

### M16. Generation UX
Prompt input, real streaming stages driven by pipeline events, skeleton loaders,
clarification questions with clickable suggestions.

**Done when:** progress text advances from real events with no timers anywhere,
and an ambiguous prompt produces answerable questions.

### M17. Chat iteration
Iteration carrying `baseVersionId`, version DAG writes, conflict detection.

**Done when:** "add a Jira step" adds one node and preserves the other node IDs,
and two concurrent iterations from the same base produce a detected fork rather
than a lost update.

### M18. Dashboard and history
Workflow list, version history, re-export.

**Done when:** workflows list scoped to the org, an old version re-exports using
its pinned registry version.

### M19. Landing page
Hero with live prompt box, output section, pricing.

**Done when:** the hero input starts a real generation and the page passes
Lighthouse accessibility.

## Phase 4: Durability

### M20. Registry generator
`tools/registry-gen`: introspect, derive, merge overlay, build index, validate.

**Done when:** the generator reproduces the M4 hand-written fixtures from
`n8n-nodes-base` plus overlay, and the seven build validation rules all fail
correctly when violated.

Deliberately late. Hand-written fixtures unblock everything before it, and the
generator is only worth building once the format has been proven by real use.

### M21. Eval harness
Corpus of 50, runner, scoring, CI gating.

**Done when:** `pnpm eval` reports pass rate and cost per case, and a deliberately
degraded prompt causes a visible regression.

### M22. Observability
Tracing, structured logs, metrics, dashboards, alerts.

**Done when:** a generation produces a complete span tree, and the cache-hit-rate
alert fires against a synthetic prefix invalidation.

### M23. Marketplace foundations
Visibility field, publish flow, scrub gate, sanitized public copies, public
routes.

**Done when:** publishing runs the scrub, shows a diff of what will be removed,
and a workflow containing a fake secret and an internal hostname is blocked.

## Cut Lines

Decided now, so the decision is not made under pressure later.

**Cut first, in order:**

1. M19 landing page. A single static page is fine at launch.
2. M18 dashboard beyond a bare list.
3. M15 canvas. The mermaid tab conveys the structure and M14 already delivers the
   value. This is the biggest visual loss and the smallest functional one.
4. M23 marketplace. The schema support from M10 means it can land later without
   migration.

**Never cut:**

- M5 parameter validation. It is the correctness floor.
- M9's manual n8n import gate. Automation cannot replace it.
- M10 RLS and M13 metering. Shipping multi-tenant without isolation or a metered
  upstream without a limit are the two mistakes that are unrecoverable.
- M21 eval harness. Without it, no prompt change after launch is safe.

**Scope reductions preferred over cuts:** ship six integrations instead of
twenty-five, one target instead of four, no chat iteration. A narrower product
that is correct beats a broad one that is not.

## Dependency Check

No milestone depends on a package built later.

| Milestone | Needs |
| --- | --- |
| M1 to M3 | nothing |
| M4, M5 | ffir |
| M6a, M6b, M7 | ffir, registry |
| M8, M9 | ffir, registry, compiler, renderers |
| M10 to M13 | db, pipeline |
| M14 to M19 | the full engine plus the service |
| M20 to M23 | everything |

`packages/ui` tokens are needed from M14 and are created there.

## Release Checkpoints

Tags are cut at the points where the system gains a capability it did not have
before. Not one per milestone: a tag is a place worth returning to when hunting a
regression, and a milestone is a session's work.

| Tag | Cut after | Means |
| --- | --- | --- |
| `v0.1.0` | architecture freeze | Architecture Frozen |
| `v0.2.0` | M5 | Validation Engine Complete |
| `v0.3.0` | M6a | Compiler Core |
| `v0.4.0` | M7 | Compiler Complete |
| `v0.5.0` | M8 | AI Generation Working |
| `v1.0.0` | M19 | Public MVP |

Each tag is annotated and carries a GitHub release whose notes say what landed,
which decisions are load-bearing, and what is known to be weak. Tags are never
moved once pushed, so the table shifts down rather than reassigning a number
that has shipped: `v0.3.0` became Compiler Core when M6 split, and everything
below it moved by one.

## Related Documents

- [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) defines the packages named here.
- [OBSERVABILITY_AND_EVALS.md](OBSERVABILITY_AND_EVALS.md) defines M21 and M22.
- [SECURITY.md](SECURITY.md) defines the checkpoint 2 review criteria.
