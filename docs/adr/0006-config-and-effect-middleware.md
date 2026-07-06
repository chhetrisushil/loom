# ADR 0006 — loom.config (defineConfig) + effect middleware

- Status: Accepted (Tier 1 of the simplicity roadmap)
- Date: 2026-07-07

## Context

Standing up a Loom app cost ~550 lines across ~12 files, most of it a composition
root + transport copy-pasted verbatim across all 5 examples. Cross-cutting
concerns (retries, logging, auth, tracing) were unimplemented or inline. An
evaluation recommended adding `loom.config` and middleware as *static, replay-safe
layers over the existing DI* — not as dynamic plugin magic, and without
outsourcing the durable log.

## Decision

**Effect middleware seam (`@loom/effect-runtime`).** New `EffectMiddleware`
type; `EffectRuntime` takes a static, ordered `middleware[]` and folds it
right-to-left over the base effect call in `execute` (`middleware[0]` outermost).
Empty list ⇒ byte-identical prior behavior. Middleware runs only when an effect
actually executes — `WorkflowContext.run` short-circuits completed steps before
`execute` — so it is replay-safe by construction; the one in-flight step that
re-runs on crash-recovery re-runs its middleware too (at-least-once).

**`retryMiddleware` (`@loom/middleware`).** First reference middleware:
exponential backoff + deterministic pseudo-jitter (seeded off
`executionId:stepId:attempt`, no `Math.random`). Never retries `SuspendError`
(control flow) or a cancelled `ctx.signal`; backoff is cancellable; retries are
in-memory within one `execute` and emit no durable events (log stays
deterministic); exhaustion rethrows into the existing `STEP_FAILED` path.

**`defineConfig` (`@loom/app`).** Static sugar over `WorkflowRuntimeDeps`: from a
declarative `LoomConfig` it assembles stores (sqlite/memory), an `EffectRuntime`
wired with middleware, a projection runtime + surfaces, composed telemetry, the
`WorkflowRuntime`, registered flows (catalog + explicit), and the in-process A2A
bus with agent/capability routes. It returns the assembled pieces (`runtime`,
`effectRuntime`, `projectionRuntime`, `bus`, `stores`, `close()`) — the app still
owns its Orchestrator and HTTP routes. The copy-pasted `InProcessA2ABus`,
`BroadcastingProjectionRuntime`, and `progressHub` were promoted into `@loom/app`.

Invariants honored: static/deterministic wiring (a resume / remote worker
reconstructs the same flows/effects/middleware); sugar not replacement (returns
the same objects hand-wiring produces; the DI path and `wireRuntime()` test
pattern still work); storage stays behind `EventStore`/`SnapshotStore` — the log
stays ours.

## Consequences

- Apps drop the composition-root/transport boilerplate: `incident-war-room` lost
  338 lines (the 3 promoted files + a shrunk `app.ts`), and its test suite passes
  **unchanged** through `defineConfig` — the proof that config is behavior-
  preserving. The other 4 examples still carry local copies and can migrate later.
- Middleware gives a single, replay-safe home for cross-cutting concerns; retries
  fill a real gap (failures were previously terminal).
- New packages: `@loom/middleware`, `@loom/app`; `@loom/effect-runtime` gained an
  optional constructor arg (backward compatible).

## Verification

- `@loom/effect-runtime`: 12 tests (chain order deterministic; short-circuit
  without `next`; no middleware for an unregistered tool; empty-list parity).
- `@loom/middleware`: 8 tests (retry succeeds/exhausts; never retries
  SuspendError/cancel; `isRetryable`; exponential + deterministic-jitter delays;
  `onRetry`) with an injected clock (no real waits).
- `@loom/app`: 5 tests (start→suspend→resume; retry recovers a flaky effect;
  middleware NOT re-invoked for replayed/completed steps; telemetry forwarded;
  folded-state parity with a hand-wired runtime).
- `incident-war-room/test/server.test.ts` passes unchanged (fork/simulate/promote
  + auto-remediate). Full repo: build + typecheck clean, 70/70 test tasks green,
  biome clean (508 files).
