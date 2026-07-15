# ADR 0053 — `@loom/plugin-durable-state`: typed, versioned carry state as recorded effects

- Status: **Accepted — shipped** (plugin + in-memory/SQLite/Postgres backends + conformance kit)
- Date: 2026-07-15
- Builds on: [ADR 0051 D2 (perpetual-agents placement)](0051-perpetual-agents-placement-schedule-remodel.md),
  the [requirements rewrite](../requirements/2026-07-15-perpetual-agents-sentinel-workloads.md) §3.1 (DS-1..5),
  ADR 0006 (effect seam), ADR 0021 (K9 idempotency), ADR 0025 (T1 schedules), ADR 0043 (plugin packaging).
- Part of: the perpetual-agents series (W1, issue #165). Additive; no kernel changes, no new
  event kinds, KERNEL_ABI and EVENT_SCHEMA untouched.

## Context

Schedule-driven agents (ADR 0051 D1) need state that survives across bounded runs, validated
on read, migratable when its contract evolves. `memory$` cannot carry this: flows cannot reach
it, writes are not logged, reads are not replay-deterministic — by design (mutable
conversation state, not a fold input). The requirements doc therefore specifies carry state as
**recorded effects** (DS-1): results land in `STEP_COMPLETED`, so replay folds the recorded
value and never re-reads the store.

## Decisions

### D1 — The SPI is a dumb keyed CAS store; all contract knowledge lives above it

```ts
interface DurableStateStore {
  load(key): Promise<DurableStateRecord | null>;          // { contractVersion, revision, payload }
  save(key, { contractVersion, payload }, expectedRevision): Promise<DurableStateRecord>;
  clear(key): Promise<void>;                               // idempotent
}
```

Revisions start at 1 and increment by exactly one; `expectedRevision: 0` creates; any mismatch
rejects with a structured `RevisionConflictError` (matched by `name` in conformance so 3P
backends need not share the class). Schemas and migrations live in `durableState()` — backends
stay trivially conformant, and the same store row can serve any contract version.

### D2 — `durableState()` exposes `ctx.execute`-able tasks (kind `"memory"`) + registered effects

The handle mints `TaskDefinition`s (`<id>.load` / `<id>.save` / `<id>.clear`, explicit
`toolId` so per-call `stepId` overrides still resolve) and matching `ToolEffect`s, wired via
`handle.register(effectRuntime)` — tool metadata and effect registration stay separate, per
the "tool$ is metadata-only" rule. `load` validates against the current Zod contract after
applying the version-to-version migration chain; every failure mode is a typed, loud
`StateContractMismatchError` (`no-migration-path` / `migration-failed` / `future-version` /
`validation-failed`) — a run never proceeds on unvalidated state (DS-2/DS-3). Migration is
applied on load and **persisted on the next save** (which always writes the current contract
version); the load result records `migrated: { from, to }` durably in the step output.

### D3 — `save` is honestly `idempotent: true` under K9: CAS + adopt-own-write

A crash between the store write and the `STEP_COMPLETED` append re-runs the effect (K9
at-least-once). Declaring `idempotent: false` would park every such recovery at
`EFFECT_INDOUBT` — needlessly, because the CAS gives a cheaper resolution: if the re-run's
`expectedRevision` conflicts at exactly `expected + 1` and the stored envelope is
canonically equal to the attempted write (stable-stringify, key order independent) at the
current contract version, the prior attempt committed — adopt it and return its revision. A
genuinely concurrent writer lands at a different revision or payload and still conflicts
loudly. DS-4's misconfiguration tripwire (two live writers) is preserved; recovery is silent
and correct.

### D4 — `sentinelState()` packages the §2 P-1 pattern as one declaration

Derives contract id (`<scheduleId>.state`) and key (`sentinel:<scheduleId>`) from the
schedule; `load(ctx)` / `save(ctx, value, revision)` for the wake-cycle shape. T1's
one-live-occurrence-per-schedule guarantee is what makes the CAS a tripwire rather than a
contention point.

### D5 — Backends and conformance

`InMemoryDurableStateStore` (reference, deep-cloning), `SqliteDurableStateStore`
(`@loom/plugin-sqlite`, own idempotent table migration like SqliteTimerStore),
`PostgresDurableStateStore` (`@loom/plugin-postgres`, table in the shared `migrate()` schema —
one backup captures events + carry state; CAS via guarded single-statement INSERT/UPDATE, safe
cross-node without locks). `runDurableStateStoreConformance` in `@loom/conformance`
(structural type, ADR 0033 idiom) is dogfooded by the in-memory and SQLite backends and by an
env-gated Postgres test.

**Precedent note:** this introduces the first plugin→plugin runtime dependency
(sqlite/postgres → durable-state, for the SPI types + `RevisionConflictError`). Accepted
deliberately: the alternative — hoisting the SPI into a kernel package or duplicating the
error class — is worse (P10: the seam belongs to the plugin that owns it). The dependency is
acyclic and interface-shaped.

## Consequences

- The sentinel pattern is fully expressible on today's kernel: `schedule$` + `sentinelState`
  + ordinary flow code. W7's DST example builds on exactly this.
- Replay correctness needs no new machinery: a fold over recorded load/save results never
  touches the store — proven by the plugin tests exercising effects through a TaskExecutor.
- `clear` is exposed but unmetered by retention; if durable-state keys ever need lifecycle
  policy (TTL, subject erasure), that composes at the backend/K10 layer, not in this SPI.
