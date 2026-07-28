# System Architecture

How FlowForge runs as a service. The other documents describe the generation
engine; this one describes the system that operates it.

Owns: runtime topology, the durable job model, the HTTP API, the data model,
multi-tenancy, metering, and caching.

## Topology

```
                    ┌──────────────────────────────┐
   Browser  ◄──SSE──┤  Next.js on Vercel           │
      │             │  - pages, React Flow canvas  │
      └────HTTP────►│  - route handlers (thin)     │
                    └───────┬──────────────────────┘
                            │ enqueue + read
                            ▼
                    ┌──────────────────────────────┐
                    │  Postgres                    │
                    │  jobs, events, workflows,    │
                    │  versions, usage, audit      │
                    └───────┬──────────────────────┘
                            │ claim
                            ▼
                    ┌──────────────────────────────┐
                    │  Worker (pipeline)           │
                    │  ai → registry → compiler    │
                    └───────┬──────────────────────┘
                            │
                 ┌──────────┴──────────┐
                 ▼                     ▼
        Model provider          Object storage
        (Anthropic)             (registry artifacts,
                                 compiled exports)
```

Route handlers stay thin on purpose. They authenticate, authorize, validate
input, write a row, and return. All real work happens in the worker. That
separation is what keeps request latency flat regardless of how long generation
takes.

## Generation Is a Durable Job

The most consequential runtime decision in the system.

Generation runs 10 to 20 seconds, and up to roughly 40 with repairs. Running
that inside a single HTTP request has three problems, and the third is the one
that matters:

1. It sits close to serverless platform time limits, with no headroom for a slow
   provider or a repair cycle.
2. A network blip loses the whole thing.
3. **A closed tab destroys work the user has already been billed for.** At
   roughly $0.09 a generation and a metered plan, that is charging someone for
   something they never received.

So: the request creates a job and returns. The worker runs the pipeline and
appends events. The client subscribes and can reconnect, close the tab, or come
back tomorrow.

### Job state machine

```
queued ──► running ──┬──► succeeded
   │         │       ├──► failed
   │         │       └──► cancelled
   │         │
   │         └──► retrying ──► running
   │
   └──► expired          (never claimed within its TTL)
```

| State | Meaning |
| --- | --- |
| `queued` | Row written, not yet claimed. |
| `running` | Claimed by a worker, lease held. |
| `retrying` | A repair cycle is in progress. Still billable as one generation. |
| `succeeded` | Validated FFIR persisted as a workflow version. |
| `failed` | Terminal. Carries a structured error. |
| `cancelled` | User aborted. Partial cost still recorded. |
| `expired` | Never claimed. Not billed. |

A worker claims a job with `SELECT ... FOR UPDATE SKIP LOCKED` and holds a lease
with a heartbeat. A lease that expires without a heartbeat returns the job to
`queued` with an incremented attempt count. Past a maximum attempt count it goes
to `failed`. This is a standard Postgres queue and it is deliberately boring:
introducing a separate queue system is a dependency the traffic does not yet
justify, and the interface is small enough to swap later.

### Event log

Every meaningful pipeline transition appends a row to `generation_events`. This
is what the SSE stream replays and what observability reads. The job row holds
current state; the event log holds how it got there.

Events are append-only and monotonically sequenced per job, which is what makes
reconnect correct rather than approximate.

## SSE Contract

`GET /api/generations/:id/stream`

On connect, the server replays all events with `seq > Last-Event-ID`, then tails
live. The client sends `Last-Event-ID` on reconnect. Because the log is durable
and sequenced, a reconnecting client misses nothing, which is the property a
purely live stream cannot offer.

```
id: 7
event: stage
data: {"stage":"pass_a","label":"Designing the workflow..."}

id: 8
event: node_drafted
data: {"nodeId":"n_trigger","label":"New employee in BambooHR"}

id: 12
event: done
data: {"workflowId":"wf_...","versionId":"wv_..."}
```

Event types: `stage`, `node_drafted`, `warning`, `error`, `done`. The
`node_drafted` events are what turn a 15 second wait into visible progress, and
they come from incrementally parsing pass A's stream. See
[AI_SPEC.md](AI_SPEC.md).

### Known ceiling

SSE connection concurrency on serverless is the practical bound on simultaneous
generations, and it binds well before compute or database capacity does. Each
open stream holds a function instance for the duration of a generation.

Stating it explicitly so it is hit deliberately: at the point where concurrent
generations approach the platform's concurrent-invocation budget, the migration
is to a managed pub/sub layer with the clients subscribing there instead of to a
function. The event log stays exactly as it is, which is what makes that
migration cheap. Polling with backoff is the fallback that requires no new
infrastructure at all.

## Data Model

Postgres. Every tenant-scoped table carries `org_id` as the first column of its
primary index.

```
organizations
  id, name, plan, created_at, settings

users
  id, email, name, identity_provider, created_at

memberships
  org_id, user_id, role                       -- owner | admin | member | viewer

workflows
  id, org_id, name, description,
  current_version_id, visibility,             -- private | org | unlisted | public
  created_by, created_at, archived_at

workflow_versions
  id, org_id, workflow_id,
  parent_version_id,                          -- append-only DAG, see below
  ffir jsonb,
  registry_version, prompt_version, model_id,
  created_by, created_at

generations
  id, org_id, workflow_id, version_id,
  status, attempt, prompt, prompt_hash,
  base_version_id,                            -- iteration base, see below
  input_tokens, output_tokens, cost_cents,
  provider, model_id, effort,
  error jsonb, created_at, started_at, finished_at

generation_events
  id, org_id, generation_id, seq, type, payload jsonb, created_at

usage_records
  id, org_id, period, kind, quantity, generation_id, created_at

provider_credentials
  id, org_id, provider, encrypted_key, created_by, created_at

audit_log
  id, org_id, actor_user_id, action, subject_type, subject_id,
  metadata jsonb, created_at                  -- append-only, never updated
```

### Versions form a DAG, not a list

`workflow_versions` is append-only with a `parent_version_id`, and every
iteration request carries the base version it derives from.

Chat iteration is a full regeneration using the current FFIR as context, which
means two teammates iterating concurrently on one workflow would otherwise
produce a lost update. Losing 20 seconds and $0.09 of someone else's work
silently is not acceptable behavior for a collaborative product.

With a parent pointer, a concurrent edit is detected (the base version is no
longer `current_version_id`) and surfaces as a fork the user can resolve, rather
than an overwrite nobody notices.

This is cheap now and genuinely painful later: retrofitting it means a schema
migration, changes to every write path, and a history backfill for data that was
never recorded.

`workflows.current_version_id` is a pointer into the DAG. Advancing it is the
only mutating write in the versioning path.

### Audit log

Append-only, never updated or deleted. Distinct from `generations` because the
questions differ: `generations` answers "what did this cost and did it work",
`audit_log` answers "who did what". Enterprise buyers ask the second question
and will not accept an inferred answer.

Actions recorded: workflow created, version created, workflow exported, workflow
shared, visibility changed, member invited or removed, role changed, provider
credential added or rotated, plan changed.

## API Surface

All routes require authentication except where noted. All tenant-scoped routes
resolve `org_id` from the session and never from the request body.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/generations` | Start a generation. Returns `202 {jobId}`. |
| `GET` | `/api/generations/:id` | Job status and result. |
| `GET` | `/api/generations/:id/stream` | SSE event stream. |
| `POST` | `/api/generations/:id/cancel` | Request cancellation. |
| `GET` | `/api/workflows` | List, paginated. |
| `GET` | `/api/workflows/:id` | Current version plus metadata. |
| `GET` | `/api/workflows/:id/versions` | Version DAG. |
| `POST` | `/api/workflows/:id/iterate` | Chat iteration. Body carries `baseVersionId`. |
| `GET` | `/api/workflows/:id/export/:target` | Compiled artifact. |
| `POST` | `/api/workflows/:id/publish` | Request publication. See SECURITY.md. |
| `GET` | `/api/library/:slug` | Public workflow. No auth. |
| `GET` | `/api/usage` | Current period usage against plan limits. |

### Request idempotency

`POST /api/generations` accepts an `Idempotency-Key` header. A repeat with the
same key returns the original job rather than starting a second one. Without
this, a double-clicked button or a client retry bills twice for one intent.

### Error envelope

One shape everywhere, matching the design system's requirement that error text be
actionable rather than generic:

```json
{
  "error": {
    "code": "plan_limit_exceeded",
    "message": "You have used all 5 generations on the Hobby plan this month.",
    "details": { "limit": 5, "used": 5, "resets_at": "2026-08-01T00:00:00Z" },
    "request_id": "req_01HQ..."
  }
}
```

`code` is stable and machine-readable. `message` is written for the end user.
`request_id` is what a support conversation references, and it appears in every
log line for that request. The error taxonomy is shared with the compiler's
`CompileError` stages and the AI layer's validation codes; there is one namespace,
not three.

## Multi-Tenancy

**Invariant: every tenant-scoped query is filtered by `org_id`, and that filter
is enforced at the data-access layer rather than trusted to callers.**

The mechanism is a repository layer that takes an authenticated context and
refuses to build a query without an org scope. Postgres row-level security is
enabled as a second line of defence, so a bug in the repository layer produces
zero rows rather than another tenant's data.

Two layers because tenant isolation is the failure that ends a B2B company, and a
single layer means one missed `WHERE` clause is a breach.

Roles: `owner`, `admin`, `member`, `viewer`. Permissions are checked at the route
handler against the membership row, and the check is a shared helper rather than
ad-hoc conditionals, so a new route cannot forget it by omission.

## Metering and Plan Enforcement

The product strategy document's tiers are unenforceable without this.

| Plan | Generations/mo | n8n export | Iterations | History |
| --- | --- | --- | --- | --- |
| Hobby | 5 | no | no | 30 days |
| Pro | 100 | yes | yes | unlimited |
| Agency | unlimited, fair use | yes | yes | unlimited |

Enforcement runs **before** the job is enqueued, inside the same transaction that
writes the job row. Checking after the fact means a burst of concurrent requests
all pass a stale check and the plan limit is advisory.

```sql
BEGIN;
  SELECT quantity FROM usage_records
    WHERE org_id = $1 AND period = $2 AND kind = 'generation'
    FOR UPDATE;
  -- compare against plan limit, abort if exceeded
  INSERT INTO usage_records ...;
  INSERT INTO generations ...;
COMMIT;
```

Usage is recorded at enqueue, not at completion, and refunded on `expired` or on
a failure that is our fault rather than the user's. Recording at completion lets a
user start unlimited concurrent jobs before any of them finish.

"Unlimited, fair use" on Agency means a soft limit with alerting rather than no
limit. An unbounded plan tier against a metered upstream provider is an
unbounded liability.

## Caching

Three distinct caches with different keys and different value.

| Cache | Key | Honest value |
| --- | --- | --- |
| Provider prompt cache | Prefix bytes | High. The stable system prefix is nearly free after first use. |
| Generation cache | `hash(prompt, registry_version, model, prompt_version, effort)` | Narrow. See below. |
| Compiled artifact cache | `hash(ffir, target, registry_version)` | High and cheap. |

**The generation cache was over-sold in earlier drafts and this correction is
deliberate.** Free-text prompts are long-tail; two users rarely type the same
sentence. Its real value is the template gallery and marketplace flows, where the
same prompt genuinely does re-run constantly, and there it makes the experience
instant. It is not a general cost lever, and the cost model should not assume it.

An explicit regenerate action bypasses it, because a user who re-runs expecting
variation and gets a byte-identical answer will read that as the product being
broken.

**The compiled artifact cache earns its keep unconditionally.** The compiler is a
pure function, so the cache is trivially correct, and it means an export endpoint
does not recompile on every download. A popular marketplace workflow compiles
once, not once per visitor.

## Registry Artifact Loading

Registry builds are immutable and published to object storage, not bundled into
the deploy. See [NODE_REGISTRY.md](NODE_REGISTRY.md).

At runtime a worker loads a registry version once per process into an in-memory
LRU keyed by version. Registry data is large and never changes, which makes it an
ideal cache. A compile resolves the version pinned in the FFIR document; a
generation uses the current default.

Cold-start cost is the tradeoff, and it is bounded by loading only the
`capabilities/` artifact in the AI path and only the relevant
`bindings/<platform>/` artifact in the compile path. This is the payoff from the
artifact split.

## Related Documents

- [AI_SPEC.md](AI_SPEC.md) owns the generation pipeline the worker runs.
- [SECURITY.md](SECURITY.md) owns tenant isolation controls, secret handling, and
  publication gating.
- [OBSERVABILITY_AND_EVALS.md](OBSERVABILITY_AND_EVALS.md) owns what the event log
  and metrics are used for.
- [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) owns where this code lives.
