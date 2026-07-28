# Observability and Evaluation

How we know the system is working, and how we know a change made it better.

For a product whose core component is non-deterministic, these are not
operational afterthoughts. The eval harness is the only thing that makes prompt
and registry changes safe, and without it every change is a guess.

## The Core Problem

A traditional service either works or throws. FlowForge can produce a workflow
that is structurally valid, passes every check, exports cleanly, and is *wrong*.
The user asked for a Slack notification on new Stripe charges and got one on new
Stripe customers.

Nothing in the runtime detects that. Only an eval corpus with known-correct
outcomes does. That is why this document exists at the same tier as the
architecture documents rather than as an operations appendix.

## Telemetry Model

Three layers, each answering a different question.

| Layer | Question | Mechanism |
| --- | --- | --- |
| Traces | What happened in this one request? | Span tree, propagated `request_id` |
| Metrics | Is the system healthy right now? | Aggregates with alert thresholds |
| Generation records | What did the model actually do? | `generations` and `generation_events` |

The third is unusual and is the one that matters most. Every generation is
permanently recorded with its prompt, resolved capabilities, validation failures,
repair attempts, token counts, cost, and the exact `prompt_version`,
`registry_version`, and `model_id` that produced it. That record is
simultaneously the debugging trail, the eval corpus, and the cost ledger.

### Trace propagation

A single `request_id` follows a generation from the HTTP request, through the job
row, into the worker, and onto every model call. It appears in every log line and
in the API error envelope, so a user reporting a problem hands over the one
identifier that unlocks the whole trace.

Spans:

```
generation                                    root
├── classify                                  Haiku call
├── pass_a                                    Opus call
│   └── provider.request                      tokens, cache hits, latency
├── retrieve                                  local, registry lookup
├── pass_b                                    Opus call
│   └── provider.request
├── merge                                     local
├── validate
│   ├── stage_0_limits
│   ├── stage_1_schema
│   ├── stage_2_registry
│   ├── stage_3_parameter
│   └── stage_4_graph
├── repair                                    only when triggered, may repeat
└── compile_dry_run                           stage 5
```

Span names match the pipeline stage names in AI_SPEC exactly. When they drift,
the trace stops being readable against the spec.

### Structured logging

JSON lines. Every line carries `request_id`, `org_id`, `generation_id`, and
`stage`. Never a raw prompt at info level, because prompts contain customer
business detail. Provider credentials are redacted at the logger by field name
rather than at each call site, so a new call site cannot forget.

## Metrics

### Quality

The set that determines whether the product works.

| Metric | Target | Why it matters |
| --- | --- | --- |
| First-attempt validity | > 85% | Directly sets cost and latency. |
| Post-repair validity | > 98% | Below this the product feels broken. |
| Capability accuracy | > 95% | Right integration, right operation. Eval-only. |
| Expression validity | > 90% | Wrong field names are the subtle, silent failure. |
| Unnecessary node rate | < 10% | Guards against overbuilding. Eval-only. |
| Clarification rate | 10% to 25% | Too low means guessing, too high means interrogating. |
| Degradation rate | < 15% | Share of workflows with a degraded capability. Drives the registry backlog. |

Marked eval-only metrics cannot be computed in production because they need a
known-correct answer. Everything else is live.

### Cost and performance

| Metric | Target | Notes |
| --- | --- | --- |
| Cost per generation, p50 | < $0.12 | Protects Pro-tier margin. |
| Cost per generation, p95 | < $0.30 | Catches repair storms. |
| Repair rate | < 15% | Each repair is roughly $0.11. |
| Prompt cache hit rate | > 80% | Below this, something is invalidating the prefix. |
| End-to-end latency, p50 | < 15s | The strategy document's budget. |
| End-to-end latency, p95 | < 40s | |
| Time to first progress event | < 2s | Perceived responsiveness. |
| Queue depth | < 10 | Sustained growth means insufficient worker capacity. |
| Job claim latency, p95 | < 3s | Time from enqueue to worker pickup. |

**Prompt cache hit rate deserves its alert.** If it drops to zero, some byte in
the supposedly stable prefix is varying, and the cost per generation roughly
doubles silently. This is a known failure mode with a specific cause, so it gets
a specific alarm rather than being noticed on an invoice.

### Alert thresholds tied to unit economics

Alerts are set where the business breaks, not at arbitrary round numbers.

| Alert | Condition | Why that number |
| --- | --- | --- |
| Margin erosion | p50 cost > $0.15 for 1h | Pro tier stops being profitable. |
| Quality regression | First-attempt validity < 75% over 100 generations | Below the repair budget. |
| Cache broken | Cache hit rate < 40% for 30m | Doubles cost per generation. |
| Provider degraded | Error rate > 5% or p95 latency > 60s | User-visible. |
| Spend anomaly | Org spend > 5x its 7-day average | Abuse or a runaway loop. |
| Queue backing up | Depth > 50 or claim latency > 30s | Capacity shortfall. |
| Isolation canary | Any cross-tenant query returns rows | Page immediately. |

## The Eval Harness

### Corpus

Fifty prompts spanning the personas in the product strategy document, each with a
hand-checked expected outcome.

| Slice | Count | Purpose |
| --- | --- | --- |
| Simple linear, two or three steps | 15 | The common case. |
| Branching and conditions | 10 | Where graph reasoning breaks. |
| Loops and batch processing | 5 | Where structure breaks. |
| Error handling required | 5 | Tests judgment, not just structure. |
| Ambiguous, should clarify | 5 | Tests the classifier's restraint. |
| Unknown integrations | 5 | Tests honest degradation. |
| Adversarial and injection | 5 | Tests the security posture. |

The corpus lives in `packages/evals/corpus/` as JSON, versioned in git, and grows
from production failures. Every production bug that reaches a user becomes a
corpus entry in the same change that fixes it, which is what keeps the suite
honest over time.

### Scoring

Each case declares assertions rather than an exact expected document, because
there are many correct workflows for one prompt and exact-match scoring would
reward memorization.

```json
{
  "id": "eval_017",
  "prompt": "When a Stripe charge succeeds, post the amount to #finance in Slack",
  "assertions": {
    "must_validate": true,
    "must_compile": ["n8n"],
    "capabilities_required": ["stripe.charge.succeeded", "slack.message.send"],
    "capabilities_forbidden": ["stripe.customer.created"],
    "node_count_max": 3,
    "must_reference_fields": ["amount"],
    "must_not_clarify": true
  }
}
```

`capabilities_forbidden` is the assertion that catches the failure class this
document opened with: structurally perfect, semantically wrong. Without it,
charge-versus-customer confusion scores as a pass.

### Gating

The eval suite runs on every change to prompts, the registry, the model, or the
pipeline. A change ships only if:

- No case regresses from pass to fail.
- Aggregate first-attempt validity does not drop.
- p50 cost does not increase by more than 10% without an explicit note.

This is a real gate. The alternative, running evals and eyeballing the output, is
the thing that feels like rigor and is not.

## Prompt Versioning

Prompts are versioned artifacts in `packages/ai/prompts/`, not string literals.

```
packages/ai/prompts/
├── classifier/v1.md
├── pass_a/v1.md
├── pass_a/v2.md          current
├── pass_b/v1.md
└── repair/v1.md
```

Every generation records the `prompt_version` it used. Without that, an eval
result cannot be attributed to a prompt revision and a regression cannot be
bisected. This is the difference between an eval suite and eval theatre.

### Bisecting a regression

1. Quality metric drops.
2. Group recent generations by `prompt_version`, `registry_version`, `model_id`.
3. The dimension where the drop correlates is the cause.
4. Re-run the eval corpus against the previous value of that dimension to confirm.
5. Revert or fix, and add the failing production case to the corpus.

Step 3 only works because all three dimensions are recorded on every generation.
That is the entire justification for stamping them.

## Fixture Replay

Model calls are expensive and non-deterministic, which makes them unusable in CI.
But most of the pipeline is deterministic and deserves fast, free tests.

Recorded provider responses live in `packages/ai/fixtures/`. In replay mode the
provider is swapped for one that returns recorded responses keyed by request hash.

| Layer | Tested with | Runs |
| --- | --- | --- |
| FFIR, registry, compiler, renderers | Golden files, no model | Every commit |
| Merge, validation, repair loop | Recorded fixtures | Every commit |
| Prompt quality | Live model calls | Nightly and on prompt change |

This is what makes the `ModelProvider` interface pay for itself twice: it enables
multiple providers, and it makes the replay harness a swap rather than a mock
framework.

Fixtures are re-recorded deliberately when a prompt changes, and the re-recording
diff is reviewed. Stale fixtures that no longer match what the model would
actually return are worse than no fixtures, because they pass while production
fails.

## Registry Change Review

A registry bump can silently change generation behavior across every workflow, so
it gets the same rigor as a prompt change.

The generator emits a structured diff:

```
n8n@1.62.0+overlay.3 -> n8n@1.68.0+overlay.3

  + 23 capabilities added
  ~  4 capabilities changed
      slack.message.send: parameter "blocks" now optional
  !  1 capability removed upstream
      legacy.thing.do  -> marked deprecated, 12 stored workflows affected
```

Removals are the dangerous line. A capability is never deleted; it is marked
deprecated with a `replaced_by` pointer, so stored workflows still resolve. The
diff reports how many stored workflows reference it, which turns an abstract
change into a concrete blast radius.

The eval suite runs against the new registry before publication.

## Model Migration

A new model version is a change to the least controlled part of the system, and
gets the most controlled procedure.

1. Run the full eval corpus against the new model with the current prompts.
2. Compare every quality metric and cost metric against the incumbent.
3. Re-tune `effort` for the new model rather than assuming the setting transfers.
   Effort behavior differs meaningfully between model generations.
4. Re-record fixtures.
5. Canary a small traffic percentage with both models recorded, and compare live
   quality metrics.
6. Cut over, keeping the previous `model_id` configurable for fast rollback.

Because `model_id` is stamped on every generation, a bad migration is detectable
by grouping on it, and a rollback is a config change rather than a deploy.

## Dashboards

**Operator, live:** queue depth, claim latency, in-flight generations, error rate,
p50 and p95 latency, cache hit rate, spend today against a projected month.

**Quality, daily:** first-attempt validity trend, repair rate by failure code,
top validation failure codes, degradation rate by integration, clarification rate.

The top-failure-codes panel is the most actionable thing on either dashboard. It
converts diffuse "quality is bad" into "40% of failures are
`expression_forward_reference`", which points directly at a prompt fix.

**Business, weekly:** generations by plan, cost per org, margin per plan tier,
conversion from free to paid, most-requested unknown capabilities.

The last one is the registry roadmap, ranked by real demand rather than
speculation.

## Related Documents

- [AI_SPEC.md](AI_SPEC.md) owns the pipeline stages these traces mirror.
- [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) owns the tables this reads.
- [NODE_REGISTRY.md](NODE_REGISTRY.md) owns the registry build this reviews.
- [DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md) sequences when this is built.
