# FlowForge v0.5.0 Release Report: Milestone 8, "AI layer against fixtures"

> **Repository snapshot:** This report documents the repository as verified on
> **2026-08-02** at commit **`11cc14e`** (`main`). All test counts, repository
> state, release counts, and verification results refer to that snapshot and are
> intentionally not updated as later milestones progress. Where the report
> describes work as deferred or not yet implemented, read that as true of the
> snapshot, not necessarily of the repository today.

## Executive Summary

Milestone 8 (M8) is complete and released as `v0.5.0` from commit `11cc14e`. It delivers the full generation path: a `ModelProvider` interface with an Anthropic implementation and a record/replay implementation, both generation passes, request-time schema synthesis, a deterministic merge into the project's intermediate representation, and a new `packages/pipeline` that orchestrates them. Verification was re-run against the released commit: 1241 tests pass across six packages with zero failures and zero skips, typecheck is clean, the working tree is empty, `git fsck` reports no problems, and `HEAD` matches `origin/main`. Every guarantee in this release is proven against recorded fixtures rather than a live model, which is why the release title carries the qualifier "(against fixtures)". The next milestone, M9, removes that qualifier.

**At a glance**

| | |
| --- | --- |
| Milestone | M8, "AI layer against fixtures" |
| Commit | `11cc14e` (49 files, +7830 / -62) |
| Tag / release | `v0.5.0`, "AI Generation Working (against fixtures)" |
| Tests | 1241 passed, 0 failed, 0 skipped, 55 files |
| Typecheck | Clean |
| What is proven | Sentence to validated document to n8n export, entirely from recorded fixtures |
| What is not proven | Anything requiring a live API call. No request has ever been sent |
| Next | M9: live generation, retry ladder, repair prompt, compile dry-run gate |

**Contents**

1. [Orientation](#1-orientation) (read this first if you do not know the repository)
2. [Build Verification](#2-build-verification)
3. [Repository Health](#3-repository-health)
4. [Milestone Completion](#4-milestone-completion)
5. [Design Decisions](#5-design-decisions)
6. [Issues Found During Verification](#6-issues-found-during-verification)
7. [Technical Debt](#7-technical-debt)
8. [Release](#8-release)
9. [Next Milestone (M9)](#9-next-milestone-m9)
10. [Current Project Status](#10-current-project-status)
- [Appendix A: Verification Method and Corrections](#appendix-a-verification-method-and-corrections)

---

## 1. Orientation

This section exists so the rest of the report can be read without prior exposure to the codebase. Readers familiar with FlowForge can skip to [section 2](#2-build-verification).

### 1.1 What the system does

FlowForge turns a sentence describing an automation ("when a new hire is added, create their accounts and post to Slack") into a workflow file that can be imported into a workflow automation platform. The current target platform is **n8n**. The path is: natural language, then a model-generated intermediate document, then validation, then compilation to the target platform's file format.

The central design choice is that the model never writes the target platform's file format. It writes a platform-neutral document, which is validated independently, and a separate compiler translates that document into the platform artifact. This is what allows the model's output to be checked before anything reaches the user.

### 1.2 Glossary

| Term | Meaning |
| --- | --- |
| **FFIR** | FlowForge Intermediate Representation. The platform-neutral workflow document that the AI layer produces and the compiler consumes. Defined in `docs/WORKFLOW_SCHEMA.md`. |
| **Registry** | Data describing every supported **capability**: its parameters, their types and constraints, and how each maps onto a target platform. |
| **Capability** | One addressable action in the registry, written as `integration.object.verb`, for example `slack.message.send`. |
| **Integration** | The external service a capability belongs to (Slack, HTTP, BambooHR). Credentials are scoped per integration. |
| **Pass A** (plan) | The first model call. Chooses the capability set and the node ids, and produces the graph. Emits no parameter values. |
| **Pass B** (parameters) | The second model call. Fills in parameter values against a JSON Schema synthesized specifically for the workflow pass A just planned. |
| **Schema synthesis** | Building pass B's JSON Schema at request time from registry data, rather than shipping one fixed schema. Implemented in `packages/ai/src/schema-synth.ts`. |
| **Closed schema** | A JSON Schema with `additionalProperties: false` at every level, so the API itself rejects any key not declared. The core guarantee of this milestone. |
| **`ModelProvider`** | The interface every model backend implements. Two exist: an Anthropic client, and a replay provider. |
| **Replay provider** | A `ModelProvider` that serves previously recorded responses instead of calling the network. Every test below M9 runs against it. |
| **Fixture** | One recorded request and response pair used by the replay provider. |
| **Worked example** | The canonical end-to-end case used across the test suite: a BambooHR employee-onboarding workflow. |
| **Milestone (M*n*)** | A numbered unit of the roadmap in `docs/DEVELOPMENT_ROADMAP.md`. M8 is the subject of this report; M9 is next. |

### 1.3 Three numbering systems, and how this report disambiguates them

The repository contains **three independent stage vocabularies**. All three start at zero, two of them have a "stage 5" and a "stage 6" that mean entirely different things, and two of them happen to have exactly five stages currently running. This is the single largest source of ambiguity in the project's documentation, and it caused a real error during preparation of this report (Appendix A, [Correction 3](#correction-3)).

To remove the ambiguity, this report prefixes every stage reference with a letter:

| Prefix | Vocabulary | Defined in | Range |
| --- | --- | --- | --- |
| **V** | Validation pipeline. What must be true of an FFIR document. | `docs/AI_SPEC.md` | V0 to V5 |
| **C** | Compiler pipeline. The passes that turn FFIR into an n8n file. | `docs/COMPILER_ARCHITECTURE.md` | C1 to C6 (no stage 0) |
| **P** | Generation pipeline. The orchestrator's own state machine. | `packages/pipeline/src/stages.ts` | P0 to P6 |

**The V, C, and P letters are this document's convention. They are not identifiers used in the codebase**, where each vocabulary simply calls its own members "stage N".

The three vocabularies in full:

| | Validation (V) | Compiler (C) | Generation pipeline (P) |
| --- | --- | --- | --- |
| 0 | Limits | *(none)* | Classify *(deferred to M9)* |
| 1 | Schema | Validate | Plan (pass A) |
| 2 | Registry | Resolve | Retrieve |
| 3 | Parameter | Normalize | Parameters (pass B) |
| 4 | Graph | Lower | Merge |
| 5 | Compile dry-run *(deferred to M9)* | Emit | Validate |
| 6 | *(none)* | Verify | Compile dry-run *(deferred to M9)* |

Three collisions are worth fixing in the reader's mind up front, because the prose in the repository does not always disambiguate them:

- **The compile dry-run is both V5 and P6.** It is validation stage 5 in the specification's numbering and the `compile` stage at index 6 in the orchestrator's. Both descriptions are correct; they are different vocabularies.
- **"The five stages that run" is ambiguous without a prefix.** Validation currently runs five stages (V0 to V4, with V5 deferred). The generation pipeline also currently runs five stages (P1 to P5, with P0 and P6 deferred). These are different fives.
- **"Stage 6" is only ever a compiler stage.** Validation has no stage 6. Where this report says a value "passes stage 6", it means C6, the compiler's verify pass.
- **The compiler has no stage 0, and its own documentation cites a V-stage inside a C-stage section.** `docs/COMPILER_ARCHITECTURE.md` describes stage C1 (validate) and notes within it that "Stage 0 document limits run first". That stage 0 is **V0**, not a compiler stage: C1 runs the shared validation rules, of which V0 is the first. A reader who takes it as C0 will build a seven-stage compiler model that does not exist. This trap caught the preparation of this report (Appendix A, [Correction 6](#correction-6)).

For orientation when reading the compiler: stages C1 to C3 are target-independent and shared by every target, while C4 to C6 are the `Target` interface. Roughly two thirds of the compiler is written once.

---

## 2. Build Verification

Every row below was produced by running the command against the released commit during preparation of this report.

| Check | Command | Result |
| --- | --- | --- |
| Test suite | `pnpm test` | 1241 passed, 0 failed, 0 skipped, across 55 test files |
| Per-package tests | `pnpm test` | `ffir` 276, `registry` 319, `compiler` 305, `ai` 172, `renderers` 112, `pipeline` 57 |
| Types | `pnpm typecheck` | 7 of 8 workspace projects selected; 6 report `Done`; `packages/config` skipped |
| Build | `pnpm build` | No-op by design (see below) |
| Working tree | `git status --short` | Empty |
| Object integrity | `git fsck` | No output, no errors |
| Remote sync | `git rev-parse HEAD origin/main` | Both `11cc14e58f9c0ead817c96cfa96e7f4399527c55` |
| Releases | `gh release list` | Five releases, `v0.1.0` through `v0.5.0` |

**What each check proves.** The test suite proves behaviour, including the two milestone criteria in [section 4](#4-milestone-completion). Typecheck proves the sources are internally consistent under the full TypeScript compiler, which matters because Vitest transpiles without type checking and therefore cannot catch type errors on its own. The typecheck run selects 7 of 8 workspace projects and 6 report `Done`; the difference is `packages/config`, which holds only `tsconfig.base.json` and declares no scripts at all. `git fsck` and the empty working tree together prove the released commit is complete and uncorrupted rather than merely tagged.

**Why `pnpm build` produces no output, and why that is correct.** The root script is `pnpm -r --if-present build`, and no package in the workspace defines a `build` script, so the command fans out and finds nothing to run. This is the intended state, not a misconfiguration. Every package is marked `private` and points `main` and `types` directly at `./src/index.ts`, so packages are consumed in-workspace from TypeScript source and there is no compiled artifact to produce. A no-op confirms the workspace layout is as intended. The anomaly would be a build step appearing without a corresponding change to how packages are consumed.

---

## 3. Repository Health

- **Git status.** Clean. `git status --short` returns no lines; nothing is untracked, staged, or modified.
- **Commit cleanliness.** M8 landed as a single commit, `11cc14e`, changing 49 files with 7830 insertions and 62 deletions. The commit body records all three specification deviations described in [section 5](#5-design-decisions), so the reasoning is recoverable from `git log` alone rather than only from the roadmap.
- **Dependency updates.** Two additions, both to `packages/ai`: `@anthropic-ai/sdk` at `^0.115.0` and `ajv` at `^8.20.0`. `pnpm-lock.yaml` was updated in the same commit. No other manifest gained a runtime dependency.
- **Object integrity.** `git fsck` reports no dangling, missing, or corrupt objects.
- **Release and tag status.** `HEAD`, `origin/main`, and the `v0.5.0` tag all resolve to `11cc14e`. Five GitHub releases exist, `v0.1.0` through `v0.5.0`, and the release checkpoint table in the roadmap is now fully satisfied.

---

## 4. Milestone Completion

M8 has two stated completion criteria, plus a review checkpoint that gates entry to M9.

### Requirement 1: a recorded fixture set drives a full generation to validated FFIR with no live model call

**How it was proven.** `packages/pipeline/src/generate.test.ts` runs the worked example's sentence through the orchestrator backed by the replay provider, and asserts that the result:

- passes every validation stage the build runs (`generate.test.ts:39`);
- reaches the same graph the hand-written worked example describes (`generate.test.ts:63`);
- compiles to n8n without errors (`generate.test.ts:203`);
- is byte-identical across two invocations (`generate.test.ts:146`);
- emits exactly the pipeline stages this build declares it runs (`generate.test.ts:156`).

**Scope of "every validation stage".** The specification defines six validation stages, V0 to V5. This build runs V0 to V4. V5, the compile dry-run, is M9 work and does not execute inside `generate()`. The n8n compilation asserted at `generate.test.ts:203` is a separate export check in its own describe block, not the V5 gate. Read the claim as the five stages that run, not as all six the specification names (Appendix A, [Correction 2](#correction-2)).

**Why this evidence satisfies the milestone.** The determinism assertion holds only because the merge is a pure function that takes `generated_at` and the document id as arguments rather than reading a clock or a UUID generator, so the test asserts on a whole document rather than one with two fields excused. The absence of a network call is structural rather than incidental: the replay provider serves recordings, so a code path that tried to reach the network would fail the test rather than silently succeed.

### Requirement 2: `schema-synth` produces a closed schema whose `additionalProperties` is false at every level for the worked example

**How it was proven.** `packages/ai/src/schema-synth.test.ts:55`, named "closes every object at every level, which is the whole guarantee". The test walks every object in a synthesized schema rather than inspecting only the top level.

**Why this evidence satisfies the milestone.** The traversal is what makes the evidence sufficient. A single nested level left open would leave every other test in the workspace green while the guarantee quietly stopped holding, so a top-level assertion would not detect the failure this test exists to catch.

**Why the guarantee holds.** Because pass A has already committed to a capability set and node ids before pass B runs, the exact parameter schema for one workflow can be built from registry data at request time. With `additionalProperties: false` throughout, the model cannot emit a parameter name that does not exist. This is an API-enforced constraint rather than a probabilistic one. Invented parameter *values* remain possible, and are caught downstream by the registry's `pattern` and `one_of` rules at validation stage V3.

### Review checkpoint 1: confirm the dependency graph, the AI-to-compiler import ban, and a running CI dependency check

**Status: partly met, and recorded in the roadmap as partly met.**

The checking half is done. `packages/pipeline/src/boundary.test.ts` reads every package manifest and asserts the real dependency graph against the one `docs/PROJECT_STRUCTURE.md` draws: every package the diagram names exists, no package has a dependency the diagram disallows, `ffir` depends on nothing in the workspace, `ai` and `compiler` are siblings in both directions, `pipeline` is the only package depending on both, the graph has no cycles, and `n8n-nodes-base` appears in no runtime manifest. `packages/ai/src/boundary.test.ts` scans every source file and every prompt for a compiler import or platform vocabulary.

The remaining half is infrastructure rather than checking: ESLint `no-restricted-imports` requires a lint setup and the CI dependency check requires CI, and the workspace has neither. Both would catch the same faults earlier and explain them better, but neither catches anything the boundary tests do not.

---

## 5. Design Decisions

Three points where the AI specification (`docs/AI_SPEC.md`) was implemented differently from its literal text. Each is recorded in the roadmap and in the commit body, so the divergence is discoverable from the repository rather than only from this report.

### 5.1 Required-ness of optional parameters

**The rule as written.** The specification places an optional parameter that has no default into the schema's `required` array, and instructs the model to emit an empty string when the parameter does not apply.

**Why following it literally fails.** The rule is correct for strings and incorrect for every other type. `""` is not a legal `number`, `boolean`, `array`, or `object`, and it is not legal even for a string carrying a `pattern` or a `not_empty` constraint. Those keys would therefore fail validation stage V3 (parameter) on every single generation. No repair could recover, because the repair would have to omit a key that the schema simultaneously demands.

**What was implemented.** A narrower rule: a registry-optional parameter is marked required only when the empty sentinel would actually survive validation. The decision is made by `emptyStringIsLegal()` in `packages/ai/src/schema-synth.ts`.

**Why this is safer.** It removes a guaranteed, unrepairable failure on every generation involving a non-string optional parameter. `additionalProperties` is untouched in either branch, so the central closed-schema guarantee does not rest on this decision.

### 5.2 Parameters a closed schema cannot describe

**The rule as written.** Every parameter is expressed in the synthesized schema.

**Why following it literally fails.** An `object` parameter with no declared `fields` is opaque by design: HTTP headers and a Slack Block Kit payload have no fixed key set. Since `additionalProperties` may only be `false` in this schema dialect, there is no way to express such a parameter at all.

**What was implemented.** The parameter is dropped and reported: a warning when it is optional, because a person can still set the value afterwards, and an error when it is required, because pass B could otherwise never produce a document that validates. The live cases are `slack.message.send`'s `blocks` and `http.request.send`'s `headers`, `query`, and `body`.

**Why this is safer.** Dropping with a report is better than emitting a schema that cannot be satisfied, and better than silently omitting the parameter with no signal at all. The failure becomes visible at the point where something can be done about it.

### 5.3 Credential scope is derived, not read

**The rule as written.** Pass A emits a `capability_scope` value, and the merge consumes it.

**Why following it literally is weaker.** Reading a model-supplied value means trusting a field the model could get wrong, when the same value is derivable from data already in hand.

**What was implemented.** `merge.ts` joins against the integration the capability actually resolves to. For any well-formed plan the derived and emitted values agree; when the model is wrong, only the derived value is correct. The model's own value is still read, and a disagreement is recorded as a warning.

**Why this is safer.** It removes a hallucination surface rather than validating it after the fact. Retaining the comparison preserves the signal: a model contradicting a value it could have derived is a prompt-quality problem worth counting rather than discarding.

### 5.4 Two further decisions that shape how the milestone is tested

**The replay provider matches on a request digest, not on call order.** A sequential fixture set becomes quietly wrong the moment two passes are reordered or a retry is inserted: every later call is served the wrong recording and the tests still pass. Fixtures build their requests through the same builders the orchestrator calls, so they match by construction, with no hash to maintain by hand. The accepted cost is that prompt drift no longer fails a fixture, which is why `packages/ai/src/prompts.test.ts` pins the load-bearing instructions directly. A prompt change should fail the test that is about prompts.

**The Anthropic integration is split on testability.** Every decision (which parameters are set, which are deliberately absent, where the prompt-cache breakpoint lands, and how a finished message is read) lives in `anthropic-wire.ts` as pure functions with their own tests. What remains in `anthropic.ts` is a loop over a stream. Three parameters are absent on purpose and are easy to "fix" by mistake: `temperature`, `top_p`, and `top_k` each return a 400 on the target model, and omitting `thinking` entirely is what runs adaptive thinking on Opus 5. Model output is still validated even though the provider guarantees the response shape, because that guarantee belongs to one provider rather than to the architecture, and it does not hold at all against a replay fixture, which is what every test below M9 runs against.

---

## 6. Issues Found During Verification

### 6.1 Problems found before release

Three documentation defects, all caught by reading the docs against the repository rather than against the diff:

- The `v0.4.0` tag had been created and pushed, but no corresponding GitHub release existed, which the roadmap's release checkpoint table requires. The release was published, covering M6b and M7.
- `README.md` claimed the AI-layer boundary rule was "enforced in CI", which was false because no CI exists. The claim now names the package manifest as the actual enforcement point.
- `docs/PROJECT_STRUCTURE.md` package trees were corrected to match the shipped layout.

The lesson these share: a diff review would have passed all three, because none of them is wrong relative to the change that introduced it. They are wrong relative to the repository as it now stands.

### 6.2 Bugs discovered by testing

- **The streaming label watcher announced variable labels as workflow steps**, producing output such as `Planning "Temporary password"...`. It now anchors on `kind` with a guard against an intervening brace. `generate.test.ts:165` covers the behaviour.
- **A fixture written to exercise validation turned out to prove something different.** The closed schema catches a missing required parameter earlier, at pass B, before validation runs at all. The test was rewritten to assert what actually happens, rather than reshaping the fixture to preserve the original assumption.

Both matter for the same reason: a test bent to fit an expectation stops being evidence for anything.

### 6.3 Final fixes

`pnpm typecheck` caught two type errors in test files that the Vitest run did not: a cast required by `exactOptionalPropertyTypes`, and an unused import. Vitest transpiles without type checking, so a type error in a test file passes the suite silently. This is the concrete reason typecheck is a separate release gate rather than an assumed consequence of green tests.

---

## 7. Technical Debt

### 7.1 No new technical debt

M8 shipped no placeholder implementations, no skipped or `todo` tests, and no unreconciled error vocabularies. `packages/pipeline/src/errors.ts` reconciles four error vocabularies (the compiler's, `ffir`'s and `registry`'s shared one, the AI layer's, and the future API envelope) without renumbering any existing code, so every failure keeps the code that appears in the specs and in logs. The items in 7.2 and 7.3 are recorded scope boundaries and pre-existing carries, not shortcuts introduced by this milestone.

### 7.2 Deferred work

Each item below is a deliberate scope boundary with a known owner or milestone.

- **ESLint `no-restricted-imports` and the CI dependency check.** Review checkpoint 1's remaining half. Blocked on lint and CI infrastructure the workspace does not yet have.
- **The secret detector's missing field names.** `packages/compiler/src/targets/n8n/verify.ts:141` calls `findSecret(value)` without `fieldNames`, unlike `packages/ffir/src/validate/graph.ts:547`, which passes them. The generic high-entropy detector therefore never fires in the compiler path, so a long opaque value in a parameter named `password` passes compiler stage C6 (verify). Carried since M6b; deserves its own commit and test.
- **Silently dropped unmapped parameters.** An FFIR parameter with no `parameter_map` entry is dropped without a warning. Registry build rule 4 permits this, and the closed five-code warning vocabulary has no member that fits it. `core.loop.for_each`'s `items` is the case where this costs something real.
- **The full registry build validation rules.** All seven rules, plus `tools/registry-gen`, are scheduled for M20.
- **An open question carried from `v0.4.0`.** Whether the renderers' reading order should be extracted into a shared package instead of duplicated. Still unanswered.

### 7.3 Known limitations

These are properties of what shipped, not work items with a scheduled owner.

- **No live model call has ever been made.** Everything in this release is proven against recorded responses. The request shape is transcribed from current provider documentation and unit-tested, not confirmed against the API.
- **The classifier and the compile dry-run are declared but not implemented.** `stages.ts` names all seven generation stages P0 to P6 because tracing, the event log, and the UI must name the same ones. `IMPLEMENTED_STAGES` records the five that run (P1 to P5), `DEFERRED_STAGES` records P0 and P6, and a test pins emitted events against them so the two cannot drift.
- **Pass B's prompt-cache breakpoint may not cache.** The instruction block it sits behind may fall under Opus 5's 512-token minimum cacheable prefix. This is genuinely unknown rather than assumed working: nothing errors if it fails to cache. The way to measure it is `usage.cache_creation_input_tokens`, which is threaded through the provider interface for exactly this purpose.
- **The unknown-capability ladder does not exist.** An unknown capability is reported as a warning, and the synthesized schema simply has no shape for that node.
- **Two n8n claims remain documentation-derived and unverified:** the error connection key, and the hand-written `parameter_map` paths, notably `core.branch.if` mapping `case_sensitive` to `options.caseSensitive`.

---

## 8. Release

| | |
| --- | --- |
| **Commit** | `11cc14e58f9c0ead817c96cfa96e7f4399527c55`, "feat: complete milestone 8 (AI layer against fixtures)" |
| **Tag** | `v0.5.0` |
| **Release** | [github.com/Thunder390/FlowForge-AI/releases/tag/v0.5.0](https://github.com/Thunder390/FlowForge-AI/releases/tag/v0.5.0) |
| **Title** | "v0.5.0 - AI Generation Working (against fixtures)" |

**Why the title says "(against fixtures)".** "AI Generation Working" on its own would be read as a claim that the system generates workflows against a live model. That is not what has been demonstrated. What has been demonstrated is that a sentence becomes a validated FFIR document that compiles to n8n, with every step driven by recorded fixtures and no network call anywhere in the path.

Naming that boundary in the title means a reader who goes no further than the release list still forms an accurate belief about what works. It also makes M9 the release that earns the unqualified claim. The qualifier costs one parenthetical and buys the reader's trust in every other statement in the notes.

---

## 9. Next Milestone (M9)

M9 is "Live generation and the repair loop". It is complete when `pnpm generate "when a stripe charge succeeds post to #finance"` prints valid FFIR and writes an importable n8n file, and when a deliberately broken fixture triggers a repair that succeeds.

| Workstream | What it involves |
| --- | --- |
| **Live model integration** | The first real calls against the Anthropic API, using `claude-opus-5` for generation and `claude-haiku-4-5` for the classifier. This is where a wrong parameter name or an unsupported parameter combination surfaces for the first time, and where the cache-breakpoint question in 7.3 becomes measurable. |
| **Retry ladder** | Structured handling of transient and structural failures, extending the state machine in `packages/pipeline/src/generate.ts`. |
| **Repair prompt** | Issued as a conversation continuation rather than a fresh request, so the model repairs in the context that produced the failure. |
| **Compile dry-run gate** | Validation stage V5, which is stage P6 (`compile`) in the orchestrator's vocabulary. Owned by `pipeline` because the AI layer may not import the compiler. `IMPLEMENTED_STAGES` and `DEFERRED_STAGES` must be updated together, since a test pins emitted events against them. |
| **Unknown-capability ladder** | Alias search, the same-integration retry, and honest HTTP degradation, replacing the current warning-only behaviour. |
| **Manual n8n import validation** | Importing three generated workflows into a real n8n instance and confirming they load without error. Required, and cannot be automated. This is also what finally settles the two documentation-derived n8n claims listed in 7.3. |

---

## 10. Current Project Status

The repository is in a healthy and internally consistent state. Milestones M1 through M8 are complete, each carrying a dated "Met on" note in the roadmap, with M6 recorded as two milestones, M6a and M6b. The working tree is clean, the released commit matches `origin/main`, and 1241 tests plus a clean typecheck run against the tag.

The generation engine is complete end to end and provably so within the boundary it claims: fixtures, not a live model. The architecture's stated invariants are enforced by tests that read the repository itself rather than by convention, most notably the closed-schema guarantee and the package dependency graph. The known gaps are documented rather than discovered, and the largest of them, that no request has ever been sent to a real API, is precisely what the next milestone exists to close.

---

## Appendix A: Verification Method and Corrections

### A.1 Method

No prior report file existed in the repository, so this document was reconstructed from primary sources rather than from any earlier summary. Every figure above was re-derived from one of:

- a live command run against the released commit (`pnpm test`, `pnpm typecheck`, `pnpm build`, `git status`, `git fsck`, `git rev-parse`, `gh release list`);
- the `11cc14e` commit object and the `v0.5.0` release body;
- `docs/DEVELOPMENT_ROADMAP.md`, `docs/AI_SPEC.md`, `docs/COMPILER_ARCHITECTURE.md`, `docs/PROJECT_STRUCTURE.md`, or `docs/WORKFLOW_SCHEMA.md`;
- the named source and test files.

Claims about the Anthropic API were checked against current provider documentation rather than recalled.

### A.2 Corrections made during verification

Six corrections were applied. They are recorded here because a reader comparing this report against earlier session notes will otherwise see contradictions. Corrections 1 to 5 were made while verifying the report's claims; correction 6 was caught during the final editorial pass.

<a id="correction-1"></a>
**Correction 1: typecheck package count.** Earlier notes stated typecheck reports `Done` for five packages. Measured against the released commit, `pnpm -r --if-present typecheck` selects 7 of 8 workspace projects and **six** report `Done`. The five-package figure predates `packages/pipeline`, which M8 added. `packages/config` is the project that reports nothing, and it declares no `scripts` block at all rather than merely lacking a `typecheck` entry. Referenced from [section 2](#2-build-verification).

<a id="correction-2"></a>
**Correction 2: "passes every validation stage" needed qualification.** The specification names six validation stages, V0 to V5. This build runs V0 to V4; V5, the compile dry-run, is M9. The unqualified phrasing could be read as claiming the compile gate ran inside `generate()`, which it does not. Qualified in [section 4](#4-milestone-completion).

<a id="correction-3"></a>
**Correction 3: three distinct stage numberings were being conflated.** The validation pipeline is numbered 0 to 5, the compiler's own stages 0 to 6, and the orchestrator's generation stages 0 to 6. The compile dry-run is validation stage V5 *and* generation stage P6; both are correct in their own vocabulary. The `verify.ts` secret-detector gap sits at compiler stage C6, not at a validation stage. This is the correction that motivated the V/C/P convention introduced in [section 1.3](#13-three-numbering-systems-and-how-this-report-disambiguates-them), and every stage reference in this report now carries its prefix.

<a id="correction-4"></a>
**Correction 4: milestone count.** "Eight milestones complete" was imprecise. M4 and M5 lack a `(done)` suffix in their roadmap headings even though both carry dated "Met on" notes, and M6 is recorded as M6a and M6b. Restated as "M1 through M8" with the M6 split noted, in [section 10](#10-current-project-status).

<a id="correction-5"></a>
**Correction 5: technical-debt claim made checkable.** The `findSecret` deferral now cites both call sites, `verify.ts:141` (no `fieldNames`) against `graph.ts:547` (passes them), so the asymmetry can be confirmed without searching. See [section 7.2](#72-deferred-work).

<a id="correction-6"></a>
**Correction 6: the compiler has no stage 0.** While building the stage table in [section 1.3](#13-three-numbering-systems-and-how-this-report-disambiguates-them), the compiler pipeline was drafted as C0 to C6 with C0 as "document limits". That is wrong: `docs/COMPILER_ARCHITECTURE.md` defines stages 1 through 6 only. The "Stage 0 document limits" sentence appears *inside* its stage 1 (validate) section and refers to validation stage V0, which C1 runs as part of the shared validation rules. The table now shows the compiler with no stage 0, and the trap is documented in 1.3 so the next reader does not repeat it. This correction affects only this report; no claim about shipped behaviour changed.

### A.3 Claims checked and confirmed correct

Two claims were checked specifically because they were the most likely to be stale. **Both were confirmed correct and required no change:**

- Claude Opus 5's minimum cacheable prompt prefix is **512 tokens**, down from 1024 on Opus 4.8. The concern recorded in [section 7.3](#73-known-limitations) is therefore stated against the right threshold.
- `temperature`, `top_p`, and `top_k` are removed on Opus 5 and return a 400. This is unconditional, not contingent on whether thinking is enabled.

Three related claims also check out: omitting `thinking` runs adaptive thinking on Opus 5, unlike the 4.x family; the model IDs `claude-opus-5` and `claude-haiku-4-5` are current; and the beta header `server-side-fallback-2026-07-01` matches the documented value for the `fallbacks: "default"` form. No correction was required to any caching, sampling-parameter, or model-ID statement in this report.
