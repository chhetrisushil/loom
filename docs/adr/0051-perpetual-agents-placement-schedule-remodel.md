# ADR 0051 — Perpetual-agent workloads: schedule remodel, durable state, claim-check — placement verdicts

- Status: Accepted (2026-07-15) — design; implementation tracked per-workstream (each lands with its own ADR/PR)
- Date: 2026-07-15
- Builds on: [the perpetual-agents requirements rewrite](../requirements/2026-07-15-perpetual-agents-sentinel-workloads.md),
  T1 timers/schedules (ADR 0025), K10 log lifecycle (ADR 0022), K11 code versioning (ADR 0023),
  the content-store seam (ADR 0046), effect middleware (ADR 0006), plugin packaging (ADR 0043).
- Part of: the kernel/1P/3P triage discipline (P10 — bias outward). Additive/opt-in (G2)
  throughout; KERNEL_ABI unchanged; at most one additive MINOR event-schema change (D6).

## Context

The database-copilot introduces two workload patterns: agent runs that never logically
terminate (sentinels waking every ~5 minutes, indefinitely) and effect data volumes that would
swamp the event log (telemetry reads whose raw payloads are high-frequency, individually
low-value). An initial requirements draft proposed kernel primitives for both: `rotate$` run
chaining with atomic suspension handoff, and a `tool$` result-by-reference subsystem with a
first-class `finding$` event.

Two independent evaluations converged after synthesis (recorded in the requirements rewrite):
the draft derived kernel requirements from an application modeling choice — one perpetual
execution per sentinel — and from problem statements that predate K10.4 compaction, K11
versioning, and T1 schedules. Evaluated against the *best userland alternative* rather than
against "an app approximating the proposed primitive," almost everything lands outside the
kernel.

## Decisions

### D1 — Sentinels are schedules over bounded runs, not perpetual executions

A sentinel is a `schedule$` cron entry; **every occurrence starts a new, bounded execution on
currently-deployed code**. This dissolves, with zero new mechanism: per-run log growth and
replay depth (each wake is a fresh small log), the code-versioning tension (every wake
re-versions; no months-old run pinned to a stale flow hash), exactly-once wake delivery (T1's
deterministic `scheduleId@occurrenceMs` ids + idempotent starts + K9.4 fencing), and chain
identity/lineage (the chain *is* the schedule; runs enumerate by id scheme or a projection).

The Temporal `continue-as-new` analogy was considered and rejected as a justification for a
chaining primitive: Temporal needs it because signals address a stable workflow id and durable
keyed state outside workflow history is not idiomatic there. Loom shares neither premise —
it has first-class schedules and (with D2) contract-validated durable state. See ADR 0052 for
the deferred chaining draft and its evidence gate.

### D2 — Typed carry state is a first-party plugin (`@loom/plugin-durable-state`), built as recorded effects

Schedule-driven sentinels need state that survives across runs, validated on read, migratable
on contract evolution. `memory$` cannot carry this: it is an agent/app-layer side channel —
flows cannot reach it, writes are not logged, reads are not replay-deterministic (by design;
it is mutable conversation state, not a fold input).

The plugin therefore exposes `load(key)`/`save(key, value)` as **effects**: results land in
`STEP_COMPLETED`, so replay folds the recorded value and never re-reads the store —
replay-correct by construction. Values carry a `{ contractVersion, revision, payload }`
envelope; `load` validates against the flow-declared Zod contract, applies registered
version-to-version transforms (recording the migration in the load result), and **fails
loudly** (`StateContractMismatch`) when no path exists — never silent coercion. `save`
supports compare-and-set on `revision` so an accidentally-overlapping occurrence fails fast
instead of lost-updating. Backends ride ADR 0043 storage presets.

Kernel-placement rejected: no new event kinds, no ABI surface, and the capability is general
to any long-lived keyed state — chain or no chain.

### D3 — Claim-check middleware over `ContentStore`; the reference is the recorded value

`claimCheckMiddleware` on the ADR 0006 seam: when an effect result exceeds a configurable
inline cap (default 16 KB), store the payload via `ContentStore.put` and return
`{ ref: ContentRef, size, digest }` as the effect output — which is what the log records.
The **digest is declared alongside the tool's result schema** as a pure function of the
payload: it is the deterministic projection orchestration may branch on. Tools without a
declared digest record `{ ref, size }` only.

**This is deliberately NOT ADR 0046 externalization**, and the distinction is the contract:

| | 0046 externalization | claim-check (this ADR) |
|---|---|---|
| Log records | value logically inline, physically external | the ref + digest **as the value** |
| Fold/replay | `ContentResolvingEventStore` resolves bytes back; blob is load-bearing | never resolves; replay touches no content store |
| Erasure of blob | loud `ContentMissingError` on fold | invisible to replay (only `resolveRef` outside the determinism boundary notices) |
| For | PII/residency: log must never have contained the bytes | telemetry: replaying a million stat rows verifies nothing |

Both ride the same `ContentRef`/`ContentStore` SPI (content-addressing gives tamper-evident
evidence for free: a finding's cited EXPLAIN plan verifies byte-for-byte against its hash).
A reach-through lint (flow control that resolves a `ContentRef` instead of branching on the
recorded digest) lives in first-party dev tooling (`tools/*`, per ADR 0044/0047), not the
kernel.

### D4 — Findings are application domain events; no `finding$` primitive

"Finding" (category, severity, confidence, target objects, evidence refs, acting model) is
copilot vocabulary. Apps emit findings via `ctx.emit` with an app-owned Zod schema — durable,
inline (small by construction; evidence goes by reference per D3), and queryable by
projections. A kernel `finding$` would be exactly the genericity violation the K7–K12
gatekeeping exists to catch. Promote to a contrib package only when a second application
wants the schema — not before.

### D5 — K10.6: a pin seam in retention (kernel accepts a predicate; the plugin owns the index)

Evidence cited by a finding must outlive both raw-telemetry TTL and archival of the run that
recorded it — today neither `LogLifecycle.applyRetention` nor content-blob reclamation can
know that. The retention path gains a **pin predicate** ("refs/executions reachable from
designated event kinds are exempt"), evaluated before archive/delete/reclaim. The kernel
checks the predicate; *what pins* (findings) and the pin bookkeeping (refcount vs
mark-and-sweep) live in the claim-check plugin, which knows the envelope format. This is also
the missing shape for ADR 0046's deferred **refcounted blob GC** — one seam serves both.
Pins survive run archival by construction: the index is keyed by ref, not by run.

### D6 — K11.5: contract-versioned state migration on resume (general, not chain-specific)

K11 migrates **code**; a *suspended* execution whose folded state must transform to match an
evolved contract has no path — `resumeAs` replay-check rightly refuses it today, and no ADR
flagged the gap. `resumeAs` gains an optional registered state transform (old contract →
new), applied at migration time and recorded durably (extend `EXECUTION_MIGRATED`'s payload
or one new kind — additive MINOR on EVENT_SCHEMA 1.14.0; decide in the implementation ADR).
Absent a needed transform, migration fails explicitly, exactly as now. Specified as a K11
amendment precisely so it is built once: sentinels barely need it (D2 owns carry-state
migration), but any long-suspended execution — human gates, A2A waits — has this problem.

### D7 — Opt-in `inputSchema` enforcement at `start()`

`FlowDefinition.inputSchema` is metadata today (manifest/deploy tooling only). An opt-in
runtime flag parses input at `start()` for every entry path (schedules, A2A submit, direct).
Unwired = byte-identical (G2).

## Rejected / deferred

- **`finding$` kernel primitive** — rejected (D4).
- **Identity-preserving transfer of live suspensions across executions** (the original
  RC-4 option a) — rejected permanently; recorded with rationale in ADR 0052.
- **`rotate$` run chaining** — deferred with an explicit evidence gate: ADR 0052.
- **`checkpoint$`** — not needed; snapshots (`snapshotEvery`, `loadLatestBefore`) + K10.4
  compaction already bound replay depth.

## Consequences

- Kernel surface: two seams (D5 predicate hook, D6 transform hook) + one opt-in flag (D7).
  No new syscalls; KERNEL_ABI stays 1.1.0; EVENT_SCHEMA bumps once, additively, in D6.
- New 1P packages: `@loom/plugin-durable-state`; claim-check lands in `@loom/middleware`
  beside retry/redaction (same seam, same wiring discipline).
- The copilot ships on today's kernel: D1 is a pattern, D2/D3 are plugins. Kernel items
  D5–D7 harden guarantees but do not block the sentinel workload.
- Implementation order, ADR-per-PR: durable-state → claim-check → pin seam → K11.5 →
  D7 flag → lint → a DST-simulated 12-month sentinel example proving the acceptance
  criteria in the requirements doc.
