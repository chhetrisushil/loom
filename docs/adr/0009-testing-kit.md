# ADR 0009 — @loom/testing fixtures kit

- Status: Accepted (DX tooling — Phase 1)
- Date: 2026-07-07

## Context

Standing up a Loom app for tests repeats ~35 lines of store/projection/bus wiring
plus a hand-rolled `sleep`/poll loop per test (verified identical across the
examples). Authoring tests/evals against LLM-backed flows also needs a way to
avoid live model calls. This is the first DX-tooling phase; it must be a thin
layer over what already exists, not new infrastructure.

## Decision

New `@loom/testing`, entirely over `defineConfig` and the existing runtime:

- `createTestApp(config?)` → the full `LoomApp`, defaulting to in-memory storage.
  Same objects production uses (the app still builds its own orchestrator on top).
- Wait helpers: `waitFor(pred, {timeoutMs, intervalMs})` (throws on timeout — fails
  loud, unlike the silent example loops), `waitForPhase`, `getSurfaceState`,
  `driveToSuspend`, `resumeWith`, `captureGolden` (reads the durable log for use
  as an `@loom/eval` fixture).
- **VCR LLM provider**: `recordingProvider(real, cassette)` / `replayingProvider(cassette)`
  keyed by a deterministic `hashRequest` that excludes the non-serializable
  `signal` (and uses no `Math.random`/time). Record once against a live model,
  persist the cassette as JSON, then replay deterministically offline —
  complementary to log-as-fixture (which replays a whole recorded run).

## Consequences

- Test wiring collapses to a `createTestApp(...)` call; polling loops collapse to
  `waitForPhase(...)`. Zero coupling — it returns the same DI objects.
- Full `createTestApp`-replaces-`wire()` substitution applies to examples once
  they're on `@loom/app` (TS treats the per-example `InProcessA2ABus`'s private
  members nominally, so the promoted bus can't type-substitute into examples not
  yet migrated). `incident-war-room` (already on `@loom/app`) was migrated to the
  wait helpers as the proof.
- New package: `@loom/testing` (deps: app, core, event-runtime, llm,
  projection-runtime, workflow-runtime).

## Verification

- `@loom/testing`: 6 tests — `createTestApp` runs a flow suspend→resume and
  `captureGolden` reads the log; `waitFor` resolves and times out; VCR
  `hashRequest` is deterministic + signal-agnostic, records once then replays,
  and throws on a cassette miss.
- `incident-war-room/test/server.test.ts` migrated to `waitForPhase` (dropping its
  local silent poll loop) — passes unchanged.
- Full repo: build + typecheck clean, 76/76 test tasks green, biome clean (537).
