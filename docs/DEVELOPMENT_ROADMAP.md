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

### M5. Parameter validation
Validation stages 2 and 3, including the parameter **name** check.

**Done when:** an unknown capability is rejected, an unknown parameter name is
rejected, a bad value is rejected by its registry rule, and each produces its own
error code. The name check has an explicit test, because it is the one guarding
against a weaker future provider.

### M6. n8n compiler
The 6-stage pipeline, `Target` interface, and the n8n target covering all nine
node kinds. Deterministic emit.

**Done when:** the BambooHR onboarding example from WORKFLOW_SCHEMA compiles to
n8n JSON matching a golden file, compiling twice produces byte-identical output,
and there is a golden case per node kind.

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
| M6, M7 | ffir, registry |
| M8, M9 | ffir, registry, compiler, renderers |
| M10 to M13 | db, pipeline |
| M14 to M19 | the full engine plus the service |
| M20 to M23 | everything |

`packages/ui` tokens are needed from M14 and are created there.

## Related Documents

- [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) defines the packages named here.
- [OBSERVABILITY_AND_EVALS.md](OBSERVABILITY_AND_EVALS.md) defines M21 and M22.
- [SECURITY.md](SECURITY.md) defines the checkpoint 2 review criteria.
