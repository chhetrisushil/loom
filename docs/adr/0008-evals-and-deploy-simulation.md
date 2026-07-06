# ADR 0008 — Evals (log-as-fixture) + Deploy-simulation

- Status: Accepted (Tier 3 of the simplicity roadmap)
- Date: 2026-07-07
- Builds on: [ADR 0007](0007-manifest-and-a2a-adapter.md)

## Context

Tier 3 delivers the two capabilities that justify keeping the durable log in-house
(rather than outsourcing to Restate/Inngest): using the log as an eval fixture,
and simulating a deploy against historical logs. Both build on the fact that
effect outputs are recorded in the log, so a run replays deterministically with no
live LLM/tool calls.

## Decision

**`@loom/eval` — the log is the fixture.**
- `replayAsFixture(log)` folds a recorded event log back into its `ExecutionState`
  (seeding identity from the first envelope, since `executionId`/`workflowId` are
  runtime-seeded, not folded). Deterministic, no live calls.
- `recordedStepOutputs(log)` extracts each step's recorded output.
- `diffRuns(golden, candidate)` compares two logs (terminal status, final output,
  per-step outputs, missing/extra steps) — the engine behind golden-fixture
  regression: `expect(diffRuns(golden, next)).toEqual([])`.
- `scoreRun(state, scorers)` runs named scorers over the folded outcome.

**`@loom/deploy-sim` — replay old logs against new code.**
`simulateDeploy(logs, next)` folds each historical log and checks it structurally
against the new flow definitions (`next` is any `getFlow`-shaped resolver — a real
`WorkflowRuntime` satisfies it), reporting resume-breaking changes *before*
promoting:
- `flow-missing` (breaking) — the flow is gone; in-flight runs are stranded.
- `step-removed` (breaking) — a step that already ran was renamed/removed, so its
  recorded output is orphaned and the new runner would re-execute it live.
- `suspended-carryover` (warning) — an in-flight suspended execution must resume on
  the new code; surfaced so you review it (the "48-hour approval + deploy" case).

Gate promotion on `report.ok` (no breaking issues). `workflowVersion` is *not* in
the log, so a version-diff check is deliberately omitted — the check is structural,
which is what actually determines resumability.

## Consequences

- The same durable journal is the runtime, the regression fixtures, and the
  pre-deploy compatibility gate — the concrete pay-off for owning the log.
- Both packages are pure over logs (no runtime coupling beyond the fold), so they
  run anywhere and are trivially testable.
- New packages: `@loom/eval`, `@loom/deploy-sim`. `@loom/eval`'s `replayAsFixture`
  now seeds identity from the envelope (a correctness fix that also benefits any
  fold-only consumer).

## Verification

- `@loom/eval`: record a real run → `replayAsFixture` reconstructs terminal state
  with no live calls; `recordedStepOutputs` extraction; `diffRuns` empty for
  identical logs and flags a changed step output; `scoreRun` over the outcome.
- `@loom/deploy-sim`: identical deploy passes; flow removal and step rename are
  breaking; an in-flight suspended execution is a non-breaking carryover warning.
- Full repo: build + typecheck clean, 74/74 test tasks green, biome clean (529).
