# FlowForge AI (Portfolio Piece)

**One-liner:** Describe an automation in plain English, get a working n8n
workflow blueprint: interactive flow diagram, importable JSON, and a setup guide.

- **Status:** Architecture frozen. Implementation started, M3 of 23 done.
- **Effort:** Large. See [DEVELOPMENT_ROADMAP.md](docs/DEVELOPMENT_ROADMAP.md)
  for 23 session-sized milestones. Next up is M4, the registry format.
- **Why it exists:** The headline portfolio piece. A real AI SaaS with a
  non-trivial engineering core, not a wrapper around a chat completion.

## What It Is

A user writes "when a Stripe charge succeeds, post the amount to #finance in
Slack". FlowForge returns four things: an interactive visual flow, a mermaid
diagram, importable n8n JSON, and a setup guide listing every credential needed.

The hard part is not calling a model. It is stopping the model from inventing
n8n node parameters that look correct and fail at runtime.

## The Four Invariants

Every document depends on these. A change that breaks one breaks the
architecture, so check them first.

**1. Claude produces FFIR and nothing else.**
Everything the user sees is derived from one model output. n8n JSON is a compile
of it, mermaid is a render of it, the setup guide is a render of it joined
against the registry. Four artifacts, one hallucination surface, and three of
them unit-testable.

**2. FFIR is flat and non-recursive.**
Nodes and edges are sibling arrays with string-ID references. Branching and
looping are edge properties, not nesting. This is what allows strict JSON-schema
enforcement of model output, which is what makes invented parameter names
structurally impossible.

**3. The AI layer never learns about a target platform.**
`packages/ai` cannot import `packages/compiler`, enforced in CI. Platform
knowledge lives entirely in registry bindings and compiler targets. Adding
Make.com is one `Target` plus per-capability bindings, and zero prompt changes.

**4. Validation does not trust its input's origin.**
Every document passes the same pipeline whether it came from the model, a human,
or the public marketplace. The strongest guarantee in the system is a property of
one model provider, so nothing is allowed to depend on it alone.

## Documents

Read in this order.

| Document | Owns |
| --- | --- |
| [WORKFLOW_SCHEMA.md](docs/WORKFLOW_SCHEMA.md) | FFIR: the schema, the expression grammar, all 19 validation rules, document limits |
| [NODE_REGISTRY.md](docs/NODE_REGISTRY.md) | Capability IDs, registry format, bindings, the generator, degradation policy |
| [COMPILER_ARCHITECTURE.md](docs/COMPILER_ARCHITECTURE.md) | FFIR to n8n and beyond, the `Target` interface, node-kind lowering |
| [AI_SPEC.md](docs/AI_SPEC.md) | Two-pass generation, provider abstraction, prompts, retry, validation stages 2 and 3 |
| [SYSTEM_ARCHITECTURE.md](docs/SYSTEM_ARCHITECTURE.md) | Runtime topology, durable jobs, API, data model, tenancy, metering |
| [SECURITY.md](docs/SECURITY.md) | Threat model, secret handling, tenant isolation, marketplace gating |
| [OBSERVABILITY_AND_EVALS.md](docs/OBSERVABILITY_AND_EVALS.md) | Telemetry, metrics, the eval harness, prompt versioning |
| [PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md) | Workspace layout, the dependency rule and its enforcement |
| [DEVELOPMENT_ROADMAP.md](docs/DEVELOPMENT_ROADMAP.md) | 23 milestones, checkpoints, cut lines |

Source material: the Product Strategy and Design System documents. Those define
what to build and how it looks. These nine define how it works.

## Stack

pnpm TypeScript monorepo. Next.js on Vercel, Postgres, a job worker, Claude via
the Anthropic API behind a provider interface. React Flow for the canvas.

## Running It

```
pnpm install
pnpm test        # every package
pnpm typecheck
```

Requires Node 20.11 or newer and pnpm 10. Built so far: `packages/config` and
`packages/ffir` (types, JSON Schema, the expression parser, and validation
stages 0, 1, and 4). Stages 2 and 3 need the registry and arrive with it.

## What It Proves to a Client

Schema design, compiler construction, LLM grounding against a real API surface,
multi-tenant SaaS architecture, and the judgment to know that the interesting
problem was never the prompt.

## Definition of Done

A stranger describes an automation, downloads the JSON, imports it into their own
n8n, connects their credentials, and it runs.
