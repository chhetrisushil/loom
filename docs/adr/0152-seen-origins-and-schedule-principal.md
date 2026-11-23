# ADR 0152 — Kernel seams for task-authority slice 2: run-level seen origins on the effect context; a principal hook for scheduled occurrences

- Status: **Proposed** (2026-11-23) — owner answered the four open questions the same day (see "Owner rulings") and an Opus design review was applied (see "Revision"); nothing here is built
- Date: 2026-11-23
- Builds on: [ADR 0150](0150-task-scoped-authority.md) (D7 instruction provenance across lineages, D12 root authority
  for scheduled runs, and the 2026-11-23 slice-2 amendment), [ADR 0151](0151-effect-context-flush.md) (the model for an
  optional, additive `EffectContext` field that is absent where no fold backs the context),
  [ADR 0085](0085-untrusted-content-integrity-axis.md) (taint is a value wrapper with an origin label),
  [ADR 0109](0109-bounded-history-and-continue-as-new.md) D8 (the fleet gate pattern, `kernel.features.continueAsNew`),
  [ADR 0111](0111-durable-principal.md) (the start principal is recorded on `EXECUTION_STARTED`),
  [ADR 0115](0115-open-vocabularies.md) (the `_resources` fold precedent),
  [ADR 0130](0130-sealed-payload-delivery-guard.md) D11 (occurrence and driver leases),
  [ADR 0138](0138-compaction-archives-what-it-removes.md) (the compaction `ArchiveStore`, D5 reads, D22 incarnation),
  [ADR 0083](0083-second-consumer-rule.md) (second consumer).
- Found by: ADR 0150 slice-2 research (2026-11-23). Owner decisions: D7 through a KERNEL `EffectContext` field so the
  policy covers every flow, not only agent loops; D12 through a small `TimerService` principal hook.
- Gate: second consumer. D1: (1) `@loomwork/task-authority` `directedBy` (ADR 0150 D7); (2) audit and "why did this run
  see untrusted content" tooling, which today can only re-scan the log offline. D2: (1) task-authority scheduled roots
  (ADR 0150 D12); (2) any multi-tenant app whose schedules must run as a service principal of one tenant.
- Placement verdict: **kernel, two small seams.** D1 is a fold step (in `replay-vm`) plus one optional field wired in
  `WorkflowContext`; only the kernel sees every value that crosses into a flow, and a per-loop local (`sawTaintFrom` in
  `agentLoop$`) cannot cover flows that are not agent loops. D2 is one optional `TimerServiceOptions` field in
  `workflow-runtime`; `TimerService` owns `startOccurrence` and no outside code can set the start principal of a tick. All
  policy (what is foreign, what to do about it, which principal a schedule has) stays in 1P `@loomwork/task-authority`.
- Version/compat impact: **D1 bumps EVENT_SCHEMA 1.26.0 to 1.27.0 and is gated per fleet.**
  - `EXECUTION_STARTED` gains the optional payload field `seenOriginsLimits` (D1 "Presence and limits"); there is no new
    event kind. The fold gains the reserved variable `_seenOrigins` (the folded bytes change, as at 1.23.0 and 1.26.0).
  - **Nothing is stamped, scanned or exposed until `kernel.features.seenOrigins` is enabled** (D1 "Fleet gate"); with the
    gate off a run's log and folded state are byte-identical to 1.26.0 apart from the version string. With it on, a run's
    state differs from 1.26.0 (the key is always written), so there is no "byte-identical with no taint" claim.
  - `EffectContext.seenOrigins` is optional and additive; it is ABSENT until the gate is on and the run is tracked.
  - D2 is additive and opt-in: absent hook, byte-identical behaviour, no schema change. No KERNEL_ABI change.
  - Kernel budget (`packages/spec/kernel-budget.json` budgets only `packages/workflow-runtime/src`): `WorkflowRuntime.ts`,
    `LogLifecycle.ts`, `WorkflowContext.ts` and `TimerService.ts` grow and need `LOOM_KERNEL_BUDGET_ADR=0152`. The fold
    code lands in `packages/replay-vm`, which has NO budget guard today (the growth there is not enforced; it is stated
    here so a reviewer sees it). Realistic growth: about 100-150 code lines across the budgeted files, and a new
    `replay-vm` module of similar size.

## Context

ADR 0150 D7 asks: has this run been SHOWN content that another task lineage authored? The answer decides whether a
write effect is attributed, parked or denied. Research at main 7409550f found:

- `agentLoop$` keeps `sawTaintFrom` as a **local string** (`packages/agent/src/agentLoop$.ts:1283`): the origin of the
  FIRST untrusted thing that loop was shown. It is invisible to middleware, covers one origin, and exists only inside
  agent loops. A plain flow that reads an inbox message and calls a tool has no equivalent.
- The kernel taints inbox deliveries (`WorkflowContext.deliveredValue`, `inbox:<topic>`), but only on the VALUE handed
  to the flow. Nothing records that the run was shown it. Re-tainting keeps the original origin
  (`packages/classify/src/taint.ts`), so a payload written as `lineage:A` keeps `lineage:A` through the delivery wrapper.
- The effect context (`WorkflowContext.ts` ~1015-1060) carries `flush`, `readResources` and `resources` (ADR 0151) and
  nothing about provenance.
- `TimerService.startOccurrence` (`TimerService.ts:487-526`) starts a tick with `runtime.start(flow, def.input,
  { executionId, ...systemOptions() })` and **no principal**.
- Approvals are park-bound (`APPROVAL_GRANTED` is verified on resume), so a schedule needs a run to hang its grant on (ADR 0150 amendment).

## Decision

### D1 — `EffectContext.seenOrigins`: the origins this run has been shown

```ts
interface EffectContext {
  // ...
  /**
   * ADR 0152 D1 — the distinct taint origins of every tainted value that has crossed INTO this
   * execution so far, as recorded in the log: a sorted-per-event union in first-seen order, a copy,
   * live (read at call time). When the set overflowed the list ends with SEEN_ORIGINS_OVERFLOW:
   * a consumer MUST treat that as "unknown, treat as foreign".
   * ABSENT means UNTRACKED: the fleet gate is off, no fold backs the context (the transient seam,
   * the decide scope's invokeTransient, test harnesses), or this run predates tracking and has not
   * been adopted yet. A consumer that needs the set MUST fail closed when it is absent.
   */
  readonly seenOrigins?: () => readonly string[];
}
export const SEEN_ORIGINS_OVERFLOW = "unknown:seen-origins-overflow";
```

#### Presence and limits (the state shape)

The fold variable is `variables._seenOrigins`:

```ts
{ v: 1,
  limits: { maxOrigins: number; maxScanNodes: number },   // recorded at start, read from state ever after
  origins: string[],                                      // first-seen order, at most limits.maxOrigins
  overflow?: true,                                        // sticky
  through: number }                                       // the sequence of the last event this key was folded through
```

- **A present key means "folded by a 1.27 kernel from sequence 0".** When the payload of `EXECUTION_STARTED` carries a valid
  `seenOriginsLimits`, the fold writes `_seenOrigins { limits, origins: [], through: 0 }` immediately, so a clean run that
  has seen no taint is distinguishable from a run that was never tracked. A run without that payload field folds no key
  and is UNTRACKED (see "Adoption" for how a tracked key is created for it).
- **The tail fold reads its limits from state**, never from runtime options. Recording the limits in the log
  (`seenOriginsLimits`, ruling S-R8) and carrying them in the key means replay, a snapshot plus tail, and a node with different
  config all fold the same. The fold ignores an invalid recorded field (non-integers or out of range) and uses the defaults, as the other
  validated carry seeds do.
- **Configured through runtime options.** `WorkflowRuntimeOptions.seenOriginsLimits?: { maxOrigins?: number; maxScanNodes?: number }`,
  threaded from `defineConfig({ kernel: { seenOrigins: { maxOrigins, maxScanNodes } } })`. Defaults 64 and 10_000. Ranges:
  `maxOrigins` 1..1024, `maxScanNodes` 100..100_000; an out-of-range or non-integer value is REFUSED at runtime construction.
  The limits stamp is written at the two bootstrap sites in `WorkflowRuntime.ts`: `start` (~3757) and the continuation
  start (~8708). A fork copies its parent's prefix, which carries the parent's stamp.
- **The per-origin cap stays fixed at 256 characters.** It bounds a FORGED origin: an attacker who controls an origin label (a
  peer id, a tool name) must not inflate every snapshot, and a per-run knob would let one misconfigured app reopen that.

#### Fleet gate (`kernel.features.seenOrigins`)

A 1.26 node folds a 1.27 log by spreading `...state.variables` (`EXECUTION_STARTED` and every other handler), so it copies
`_seenOrigins` through UNCHANGED and can persist it in a snapshot: a stale set that reads as complete. That is the same
rolling-deploy hazard ADR 0109 D8 gates for `continueAsNew`, and the remedy is the same pattern.

- `WorkflowRuntimeDeps.seenOriginsEnabled?: boolean` (default `false`), set by `defineConfig({ kernel: { features: { seenOrigins: true } } })`,
  mirroring `continueAsNewEnabled` (`WorkflowRuntime.ts:384`, `:1220`).
- **Off (default):** nothing is stamped (`seenOriginsLimits` is not written), the fold writes no key, `EffectContext.seenOrigins` is
  ABSENT, the helper of "Seeding sites" is a no-op. Behaviour is byte-identical to 1.26.0. Consumers treat absent as
  "untracked".
- **On:** `start` and the continuation start stamp the limits; the driver paths adopt untracked runs (see "Adoption");
  `seenOrigins` is present for a tracked run.
- **The operator turns the gate on only after every node runs a 1.27.0+ kernel**, the ADR 0109 D8 rule. The way to know it is
  safe: every node reports `EVENT_SCHEMA_VERSION >= "1.27.0"` (the version string a node exposes through the existing version
  surface) and `knownEventTypes()` is unchanged; the docs for the flag say so next to `continueAsNew`'s.
- **If the gate is enabled while a 1.26 node still folds these runs** the runtime cannot see that node, but the key detects the
  damage: `through` is advanced by every 1.27 fold step and a 1.26 node leaves it stale. A 1.27 node that loads a snapshot
  whose `through !== snapshot.sequence` treats the key as untrustworthy: a driver site rebuilds it by rescan from sequence 0
  (D1 "Rescan"), and a read-only site reports overflow. A 1.26 node's own effects have no `seenOrigins` (the field does not
  exist there), so a consumer sees absent = untracked on that node and fails closed. The residual is a 1.26 node writing a
  snapshot at exactly the sequence of a stale key; that cannot happen, because it advances `snapshot.sequence` past `through`
  with every event it folds.

#### What feeds it (the channels)

One module in `replay-vm` (`seenOrigins.ts`) is called from the fold loop after each handler when the state carries the key,
so all channels share one scan, one bound and one set of rules, and the handlers themselves do not change. Verdicts:

| Channel (event, field) | Verdict | Why |
|---|---|---|
| `STEP_COMPLETED.output` | **scan** | Tool, memory, LLM and child results. Human-step answers (`WorkflowContext.ts` ~932) and in-doubt adoptions (~904) commit the same event, so they are covered by this row. |
| `MESSAGE_CONSUMED` | **scan when `isKernelWritten(event)` and not a duplicate**: origin `inbox:<topic>` plus a scan of `payload` | The fold already ignores a consume that is not kernel-stamped or whose messageId is in the dedupe window; a delivery that never reached the flow did not show it anything. The topic is added with the same origin `deliveredValue` stamps. |
| `EXECUTION_RESUMED`, positional payload | **scan** `payload` (not when `isStatusOnlyResume`) | A gate resume payload is handed to the flow. |
| `EXECUTION_RESUMED`, wait-addressed `{ waitId, payload }` | **scan** the unwrapped inner payload, only when the answer is recorded (`addressed.answer`) | The same value enters `_waitAnswers`; an addressed inbox answer also has its `MESSAGE_CONSUMED`. |
| `DECISION_RECORDED.choice` | **scan** | A decider reads untrusted data through transient calls or memory recall, and `ctx.decide` hands the choice back to the flow. `alternatives`, `context` and `policy` are NOT scanned: they are the decider's inputs recorded for audit and are not returned to the flow. |
| `STEP_FAILED.payload` (DE-4 typed failure) | **scan** | A typed failure's payload is delivered to the flow's `catch` as data. `STEP_FAILED.error` is not scanned: it is serialized error text, never a wrapper (the agent loop wraps tool errors itself, `tool-error:`, in an OUTPUT). |
| `PARALLEL_COMPLETED.errorPayload` | **scan** | The same typed-failure data on a parallel scope. |
| `EXECUTION_MIGRATED.migratedInput` | **scan** | The migrated input replaces `_input`. |
| `EXECUTION_STARTED.input` | **scan** | The flow input. |
| continueAsNew carry | **carry the set**: add `carried.seenOrigins` to `carriedOf` (`continuation.ts:194`, as `resources`) and seed the successor from it, validated like `seedResources`; the carry itself is also the successor's `input`, so it is scanned too | Without it, rotating through `continueAsNew` launders every origin seen so far. If the predecessor had no key the successor starts with `overflow` (it cannot prove a clean past). |
| fork | **follows `forkResources`** (`eventHandlers.ts` ~514-540): a fork of a chain member keeps `carried.seenOrigins`; an ordinary fork copies its prefix, key included | A fork must not shed what its parent was shown. |
| child results | **not propagated by the kernel** | Reading another execution's fold from inside this one would couple two logs and add an unbounded cross-execution read. The 1P orchestration supervisor taints the `CHILD_DONE` body with the child's seen origins (task-authority slice 2, S5), so the ordinary `STEP_COMPLETED` or inbox scan recovers them; the kernel carries opaque strings and stays out. |
| the decide scope's `invokeTransient` and other transient calls | **absent** | They emit nothing and have no fold; `seenOrigins` is undefined there (M8), and a consumer fails closed. |

**No new syscall and no new event.** A flow-scope "add an origin" syscall is rejected (Rejected alternatives): a value not
from a recorded channel is outside the replay contract. With parallel branches the set at an effect is the fold at that
point, so it may include an output a sibling branch committed that the flow has not consumed yet: a superset of "consumed",
the safe direction for a security check.

#### The scan (determinism)

The live fold sees in-memory payloads, replay sees JSON from the store, and a store such as Postgres JSONB reorders object
keys, so the scan must be a pure function of the JSON VALUE, not of object identity or key order:

- **A vendored walk in `replay-vm`** (`replay-vm` has no `classify` dependency, and the kernel must not inherit later
  semantic changes to `scanTaint`): iterative, depth pinned at 64 (M6), over a normalized JSON view: own enumerable string
  keys of plain objects and arrays; `toJSON()` applied where present, and `Map`, `Set`, `undefined`, functions and symbols
  treated exactly as `JSON.stringify` treats them, on the live path and the replay path alike; non-finite numbers are leaves.
  **Cycle detection only** (an ancestor stack); there is NO shared-reference dedupe (a `WeakSet` would make the node count
  depend on object identity, which a JSON round trip changes). A cycle, a depth over 64, or more than `limits.maxScanNodes`
  visited nodes is `exceeded`. Node counting follows the JSON view, so it is independent of key order.
- **The wrapper shape** it recognises is classify's: an object whose `__loomTainted` is an object with a string `origin`
  and that has a `value` key. A test (in `replay-vm`, with classify as a dev dependency only) asserts every shape
  `tainted()` produces is recognised, so the two cannot drift silently.
- **Per-event origins are sorted** (code unit order) before they are unioned into the set, so first-seen order within an
  event never depends on object key order.
- **An exceeded scan sets `overflow` ONLY and drops the partial origins it found**, because which origins a bounded walk
  reaches first depends on traversal order.
- **Truncation before dedupe and count:** an origin longer than 256 characters is replaced, BEFORE it is deduped or counted, by
  `unknown:truncated:<fnv1a-64 hex of the full origin>` (M4). A deterministic non-cryptographic digest is enough: a collision
  only merges two labels that were both over-long. The 256 cap therefore bounds both the stored size and a forged flood.
- **The `maxOrigins + 1`th distinct origin sets `overflow`** and is dropped; overflow is sticky.
- **The determinism test** (required for S2) folds the same log (a) live, (b) by replay from JSON, (c) from a snapshot plus tail,
  and (d) through an event-store round trip that REORDERS object keys. (d) always runs against an in-memory decorator that
  re-emits every payload with reversed key order; and, in the Postgres-gated suite (the per-package test DB the repo already
  provisions, `reference_local_postgres_for_tests` recipe), against the real JSONB store. All four must produce equal
  `_seenOrigins`.

**Cost.** The scan is O(nodes of the scanned fields, up to `limits.maxScanNodes`) once per event and runs in the fold, which
also runs on replay. `maxScanNodes` bounds the walk's NODE count, NOT the CPU below payload size: a payload of a few nodes
with megabyte strings costs its serialization anyway, and `toJSON` normalisation touches every property. Only the fields in
the table are scanned; primitives and `null` return immediately; a snapshot carries the set so a resume scans only the
tail. A `*.perf.test.ts` is a REQUIREMENT of task S2, measured BEFORE the fold scan is committed (see "Implementation notes").

#### Seeding sites: one async snapshot-to-state helper

Every site that turns a loaded snapshot into a `ReplayVM` seed today calls the synchronous `normalizeSnapshotState`,
alone or through `WorkflowRuntime.seedOf`. A snapshot written by a pre-1.27 fold, or by one that never tracked, has no key (or a
stale one). The design is ONE async helper, `seedFromSnapshot(snapshot, { identity, retarget?, rescan })` (module
`packages/workflow-runtime/src/seenOriginsSeed.ts`), that every site below calls instead of `seedOf` /
`normalizeSnapshotState`. `normalizeSnapshotState` itself stays synchronous and pure.

- With the gate off it returns `normalizeSnapshotState(snapshot.state)` unchanged.
- With the gate on and the key present and `through === snapshot.sequence` it returns the state unchanged (trusted).
- Otherwise (key absent, or `through` stale):
  - `rescan: true` (a DRIVER site: it will write) rebuilds the key by the rescan below, once;
  - `rescan: false` (a READ-ONLY site) returns the state with `_seenOrigins` set to `{ limits, origins: [], overflow: true, through }`:
    **incomplete, never a tail-only set**. Such a state is never persisted (read-only folds are not saved).

Sites (all `packages/workflow-runtime/src` unless noted; line numbers are at main 7409550f):

| Site | Today | Mode |
|---|---|---|
| `WorkflowRuntime.ts:4016/4083` resume | `loadLatest` then `seedOf` | rescan |
| `WorkflowRuntime.ts:7357/7361` (flow migration) | `loadLatest` then `seedOf` | rescan |
| `WorkflowRuntime.ts:7692-7728` `foldState` | `loadLatest` then `seedOf` | read-only by default; its ~25 callers (`:1978, :3068, :3406, :3439, :3556, :4493, :4795, :4961, :5029, :5115, :5350, :5432, :5543, :5570, :5929, :5991, :6069, :6406, :6975, :6991, :7605, :8454, :8463, :8482, :8628`) that feed a write (the continuation predecessor at `:8628`, recovery re-drive at `:4493`) pass `rescan` |
| `WorkflowRuntime.ts:3451-3520` `restoreFromState` | a caller-supplied state | the caller's `_seenOrigins` is UNTRUSTED (M10): it is dropped and rebuilt from the log by `rescan`, never taken from the argument |
| `WorkflowRuntime.ts:8059/8890-8903` fork (`materializeStateAt`) | `seedOf(base, …, retarget)` over a `loadAt` base | rescan (a fork writes) |
| `LogLifecycle.ts:685-690` | `ReplayVM(suffix, normalizeSnapshotState(...))` | read-only |
| `LogLifecycle.ts:1163-1167` and `:1896-1897` (compact / fork-at, state at a sequence) | `normalizeSnapshotState(base.state)` plus identity | rescan: the state it saves or forks must carry a trustworthy key |
| `blankStream.ts:153, :228, :240, :527` | `normalizeSnapshotState` over stored snapshots | read-only (these compare or rewrite identity-free state; they never drive) |
| recovery (`recoverAbandoned.ts`, `redriveAbandoned.ts`) | through `resume` / `foldState` | via those rows |
| `loadState` (public) | `foldState` | read-only: reports incomplete, never tail-only |

(The review named a `loadLatestBefore`; the code has no such method. Fork's base is `snapshotStore.loadAt` at
`LogLifecycle.ts:1772` and `plugins/content/src/gc.ts:932`, both covered by the rows above; `gc.ts` only reads and is read-only.)

#### Adoption of an untracked run

With the gate on, a driver site that finds a run with no key (started before the gate or before 1.27) ADOPTS it: it seeds
`_seenOrigins { limits: <current configured limits>, origins: [], through: -1 }` and folds the run from sequence 0. For a run with no snapshot
this is just the ordinary full fold with a seeded key (no extra reads). For a run with a snapshot it is the rescan below.
The limits chosen at adoption are written into the key and persist with it; because a run adopted this way has no
`seenOriginsLimits` on its `EXECUTION_STARTED`, replay of that log WITHOUT a snapshot would fold untracked. That is
acceptable: tracking is a property of the persisted snapshot chain, and an untracked read reports absent or overflow, never a
wrong "clean".

#### Rescan (owner ruling 2: rescan, do not fail closed)

When a driver site must rebuild the key, the helper folds the history `[0 .. snapshot.sequence]` with the scan rules and seeds
the result into the snapshot state; the tail then folds on top as usual (`fold(snapshot, tail) == fold(events)`).

- **A new runtime dependency, `WorkflowRuntimeDeps.compactionArchive?: ArchiveStore`.** Today the runtime holds only `inboxArchive`
  (wired in `defineConfig` only under `kernel.features.inbox`); the compaction archive reaches `LogLifecycle`, not the
  runtime. `defineConfig` passes the same `ArchiveStore` it builds from `retention` as `compactionArchive`, independently of the
  inbox feature (`defineConfig.ts` ~2300-2320). The runtime reads it through the GUARDED store stack (the same decorated event
  store, per ADR 0138 D22: the archive's incarnation is the digest of the bootstrap envelope as the reading store presents it), so
  a view that rewrites the bootstrap is refused as a foreign incarnation instead of mixed in. This is a deliberate, single
  exception to ADR 0138 D5's "the resume path never touches the archive": it runs once per adopted or rebuilt run.
- **Paged, not `readWithArchive`.** `LogLifecycle.readWithArchive` loads the whole log (`:1467`), which is the unbounded read the
  snapshot design exists to avoid. The rescan checks coverage from `archive.headers` (contiguous from 0 to the first live
  sequence), then reads archive segments one at a time (`archive.read(id, { from, through })`, a whole segment per call, digest-verified) and
  the live log in fixed-size pages (`eventStore.readRange`), folding each page into the scanner and DISCARDING the events, so memory is O(page), not O(history).
- **Error classes.** Permanent errors produce a STICKY overflow (`{ overflow: true }`, persisted by the next snapshot; the run
  continues, it is not failed): `ArchiveIncompleteError`, `ArchiveGapError`, `ArchiveDigestError`, `ArchiveIncarnationError`,
  `ArchiveLogMismatchError`, `ArchiveUnserializableError`, `ArchiveTenantMismatchError`, `PlaintextArchiveError`,
  `PayloadShreddedError`, `SealedStreamUnreadableError`, and "the log is compacted and no archive is configured". The write-side
  conflicts and construction errors (`ArchiveConflictError`, `CompactionArchiveRequiredError`,
  `ReservedStreamArchiveRequiredError`, `InboxArchiveRequiredError`) cannot occur on a read and are not caught.
  Transient errors (a timeout, a connection error, a store that is unavailable: anything else an archive or event-store read throws)
  produce a RETRYABLE resume failure, `SeenOriginsRescanUnavailableError` (`retryable = true`): the resume fails without appending, **nothing is persisted and
  nothing is memoized**, and the next attempt rescans. Treating an outage as sticky overflow would permanently mark a healthy run as
  foreign.
- **Lease renewal.** The rescan runs inside the driver's hold on its heartbeat lease (`acquireDriverLease`, taken before the fence at
  `WorkflowRuntime.ts:~4238`; a helper call from a non-driver site takes its own hold and releases it in a `finally`). The
  `DriverLeases` keeper renews on a timer, so the rescan only has to yield: it awaits an I/O page at a time and never runs a long synchronous
  loop. A lost hold (`acquire` returns `null`) stands the rescan down as a retryable failure.
- **Memo.** The rebuilt key is kept in the seed for that resume and persisted by the next snapshot the cadence writes. The runtime also
  memoizes the result in a bounded LRU keyed by `(executionId, snapshot.id, snapshot.sequence)` (M9), so a repeated resume of the
  same old snapshot does not rescan; a new snapshot has its own key; only successful and permanent-overflow results are memoized.
- **Cost:** one read plus one fold of the whole history, once per adopted or stale run that has a snapshot. A run with no snapshot pays nothing extra.

#### Wiring

`WorkflowContext` adds, next to `readResources`, `seenOrigins` ONLY when the gate is on and the folded state has the key at
context-build time: `seenOrigins: (): readonly string[] => this.seenOriginsCopy()`, a copy of the key's list plus the overflow marker.
Mutating the result never reaches the fold (the ADR 0151 D6 rule).

#### What D1 does NOT do

- It decides nothing. Foreign versus own, which effects are checked, and attribute / park / deny belong to
  `@loomwork/task-authority` `directedBy` (ADR 0150 D7, S-R2/S-R3). A consumer treats an ABSENT `seenOrigins` as untracked and
  (recommended, as for an absent `flush` in ADR 0151 D4) fails closed for an effect it checks.
- It does not know the word "lineage". Origins are opaque strings.
- It does not tag writers (S-R1) and does not see channels outside the log.
- It does not un-see: the set only grows within an execution; a continuation inherits it through the carry.

### D2 — `TimerServiceOptions.principalFor`: a principal for a scheduled occurrence

```ts
interface TimerServiceOptions {
  // ...
  /**
   * ADR 0152 D2 — the principal a scheduled occurrence starts as. MUST be idempotent and free of side effects
   * for a given (schedule, occurrence): it can run on several racing nodes and again on every retry poll.
   * Absent: the occurrence starts with no principal, exactly as before. A throw, a rejection or a timeout skips THIS occurrence.
   */
  readonly principalFor?: (
    schedule: ScheduleDefinition,
    occurrence: number,
    ctx: { readonly signal: AbortSignal }
  ) => PrincipalChain | undefined | Promise<PrincipalChain | undefined>;
  /** ADR 0152 D2 (M2) — how long the hook may take before it counts as a throw. Default 5000 ms; 1..60_000. */
  readonly principalForTimeoutMs?: number;
}
```

In `startOccurrence`, after `getFlow` and before `start`, the hook runs **in its own `try`** (M1), so that any throw, rejection
or timeout becomes a `SchedulePrincipalError` reported through `onError(executionId, err)` and returns `"done"`. The hook is NOT left to
the surrounding `catch`, which classifies `ExecutionAlreadyExistsError` as "already started" and `StartLeaseHeldError` as `"retry"`: a hook that threw
either would otherwise be mistaken for a start outcome. A timeout aborts the `signal` and rejects the race, so the `ticking` flag (which stops overlapping polls, `TimerService.ts:409-433`) cannot stick behind a
hung hook; the hook's work may still be running, which is one more reason it must be side-effect free.

Then `runtime.start(flow, def.input, { executionId, ...(principal !== undefined && { principal }), ...systemOptions() })`.

- **Recorded per ADR 0111** on `EXECUTION_STARTED` and rehydrated on every execute, so the tick's effects run as that principal and
  the grant it carries, never as the system. The system grant still bypasses the execution authorizer for the lifecycle op `start`
  (`systemOptions()` is spread unchanged): the hook supplies who the run acts as, not who authorized the start.
- **Absent means byte-identical.** No hook, no extra await, no extra option key. A hook returning `undefined` starts with no principal.
- **Idempotent and side-effect free (I7).** The hook may run on every node that polls an occurrence, and again on every retry poll
  (`StartLeaseHeldError` keeps the cursor). It must therefore be a pure function of `(schedule, occurrence)` and recorded data, and it must
  NOT mint, claim or reserve anything: whatever it mints would be orphaned by every call that loses the race. **S10 mints the tick grant inside the run, after
  `start` wins**, with the deterministic task id `<scheduleId>@<occurrence>` (which is the execution id), so a recovery or retry mints the same grant. The hook only
  names the principal (a reference such as the schedule grant's holder), which the first successful `start` records. A node that loses
  the race discards its principal with its refused start, and `redriveAbandoned` resumes the execution as the RECORDED principal without calling the hook.
- **Skipping is per node (M3).** The cursor lives in memory (`schedule.cursor`), and a skip returns `"done"` so the cursor advances and
  the loop cannot spin. Another node, or this node after a restart, whose hook succeeds may start that occurrence; the deterministic id
  `${def.id}@${occurrence}` keeps the start exactly-once. A skip is "not started by this node this process lifetime", not a durable tombstone.
- **Fencing and recovery are unchanged:** the `loadState` fast path, `ExecutionAlreadyExistsError` for a raced loser, `StartLeaseHeldError` → "retry"
  (ADR 0130 D11), and the L12 rule of no fence on this start.

**What D2 does NOT do.** It mints nothing and verifies nothing: the schedule grant, its one-off approval run and the per-tick child grants (ADR 0150 D12) are task-authority's.

## Consequences

- A middleware can ask "have I been shown another lineage?" for any flow, from the same fold replay uses, with no per-loop state.
  `agentLoop$` keeps `sawTaintFrom` for prompt fencing.
- Fail-closed by construction: a bounded scan, a capped set, a stale or foreign key, an unreadable archive and an absent field all read as "unknown / untracked / foreign", never as "clean".
- Cost: the fold scan, up to `maxOrigins` short strings per run, a one-time rescan per old run, and no new round trip per effect. D2 costs nothing without the hook.
- Enabling the gate is a fleet decision (all nodes on 1.27+), like `continueAsNew`; before that nothing changes.
- Residual: the set is evidence of what was shown, not of what influenced a decision. An effect directed by content that never entered through a recorded channel is invisible (ADR 0150 D7 "Does not").

## Rejected alternatives

| Alternative | Why rejected | What would reopen it |
|---|---|---|
| Keep it in `agentLoop$` (a set instead of `sawTaintFrom`) | Owner decision: the policy must cover every flow; a loop-local set cannot be read by lease middleware. | — |
| A flow-scope `ctx.markSeen(origin)` syscall | A new syscall and a way for flow code to forge or erase evidence; a value not from a recorded channel is outside the replay contract anyway. | A recorded channel the kernel cannot see but must trust (name it with a second consumer). |
| Scan at commit and stamp the event (`STEP_COMPLETED.seen?`) | Cheapest fold, but a payload change on the hottest event and a stamp nothing can check. | The S2 perf gate shows a material fold regression. |
| Compute in `WorkflowContext` from values returned to the flow (no fold key) | The set would be invisible to introspection and audit readers, and a snapshot resume depends on the flow re-running from the start. | — |
| Old snapshots read as overflow with no rescan | Owner ruling 2: an old run would be foreign forever, so `directedBy` could park or deny every effect of every pre-upgrade execution. Overflow stays as the floor when the prefix is unavailable. | — |
| Always write the key, no fleet gate | A 1.26 node copies the key through stale (spread) and persists it: a false "clean". | — |
| Absent key means "clean" | A run that was never tracked reads as having seen nothing. Absent means untracked. | — |
| The kernel propagates a child's set into the parent | Couples two logs and adds a cross-execution read to a fold. The 1P supervisor taints the `CHILD_DONE` body instead. | Evidence the supervisor path cannot cover a case. |
| Dedupe shared references with a `WeakSet` | Node counts then depend on object identity, which a JSON round trip changes: live and replay diverge. | — |
| Depend on classify's `scanTaint` in the fold | A later change to its semantics would silently change what old logs fold to. | — |
| `readWithArchive` for the rescan | Loads the whole history at once. | — |
| Treat an archive outage as sticky overflow | A transient failure would permanently mark a healthy run foreign. | — |
| Hard-coded or config-read limits at fold time | A config change would change what an existing log folds to. Limits are recorded (S-R8). | — |
| A configurable per-origin length cap | It bounds a forged origin. | Evidence of a real origin scheme longer than 256 characters. |
| Mint the tick grant inside `principalFor` | The hook runs on racing nodes and every retry poll, so it would orphan grants. | — |
| `principalFor` retries on a hook error (`"retry"`) | One stuck hook would hold the cursor and stall every later occurrence of the schedule. | Owner prefers stalling over skipping. |
| Start the occurrence anonymously when the hook throws | Fails open: effects would run with no grant and no lease. | — |
| Put the schedule grant on `ScheduleDefinition` | Couples the kernel schedule type to a 1P vocabulary. | — |

## Owner rulings (2026-11-23)

1. EVENT_SCHEMA 1.27.0 is accepted.
2. Old snapshots are RESCANNED at upgrade, not failed closed; overflow only when the full prefix is unavailable.
3. A throwing or rejecting `principalFor` SKIPS the occurrence.
4. The bounds are CONFIGURABLE, recorded per run (S-R8); the per-origin length cap is fixed.
5. Controller ruling R9 adopts the design-review fixes below.

## Revision (2026-11-23, design review)

An Opus design review of the first draft (1b191649) found seven Important flaws and eleven minors. D1 and D2 above are rewritten, not patched. What changed and why:

- **I1 presence and limits.** The key is written at `EXECUTION_STARTED` (`origins: []`), so "present" means "folded from sequence 0"; the tail reads limits from state. The earlier "absent until the first taint" shape could not tell a clean new run from an old snapshot, and lost the limits after a snapshot. The "byte-identical with no taint" claim is dropped.
- **I2 rolling deploys.** A fleet gate `kernel.features.seenOrigins` (ADR 0109 D8 pattern); a 1.26 node would copy a stale key through. The `through` field lets a 1.27 node detect that.
- **I3 channels.** A full per-channel table: resume (both shapes), `DECISION_RECORDED.choice`, typed-failure payloads, `EXECUTION_MIGRATED`, continueAsNew carry (laundering by rotation), fork, child results (1P), the transient seam (absent).
- **I4 seeding sites.** One async helper used by every site, with a read-only mode that reports overflow, never a tail-only set; `restoreFromState` treats the caller's key as untrusted (M10).
- **I5 rescan.** A `compactionArchive` runtime dependency read through the guarded store; error classes (permanent = sticky overflow, transient = retryable and never persisted); a paged read; lease held while it runs; a bounded LRU memo (M9).
- **I6 determinism.** Sorted per-event origins, overflow-only on an exceeded scan, a JSON-semantics scan with cycle detection only, a vendored walk with pinned depth (M6), truncation before dedupe with a reserved `unknown:truncated:<digest>` form (M4), corrected cost wording (M5), and a JSONB-reordering determinism test.
- **I7 and D2 minors.** `principalFor` must be idempotent and side-effect free; S10 mints inside the run; the hook has its own `try` (M1) and a timeout (M2); skipping is per node (M3).
- **M7 document fixes.** The header no longer says "no payload change"; the stamp sites are named; the budget paragraph names the files and the unguarded `replay-vm`; a realistic growth estimate; the S2 split below.
- **M11 deferred.** An attested inbox-sender origin (so a sender cannot choose the origin label of its own message) is a follow-up: it reopens ADR 0150 S-R1/S-R3 (writer tagging is content-level, foreign = a `lineage:` origin) and needs the owner's decision first.
- **Added by the revision, for owner review:** `through` as a staleness detector (the review asked for the gate; `through` is what makes a gate mistake detectable rather than silent).

## Implementation notes for S2

S2 is probably THREE PRs, each under the 200-line target for its budgeted files, split so each is safe to merge alone (the gate is off until the end):

1. **S2a, the fold.** `replay-vm`: `seenOrigins.ts` (vendored scan, channels, bounds, truncation, carry/fork seed), the hook in the fold loop and the `EXECUTION_STARTED` seeding, `EVENT_SCHEMA_VERSION` 1.27.0 and its history comment, `carriedOf` / `seedSeenOrigins`. Inert: nothing stamps `seenOriginsLimits` yet. The perf measurement and the determinism test land here.
2. **S2b, the gate and the context.** `kernel.features.seenOrigins` (`defineConfig`, `WorkflowRuntimeDeps.seenOriginsEnabled`), `seenOriginsLimits` option with range validation, the stamps at `WorkflowRuntime.ts:~3757` and `~8708`, `EffectContext.seenOrigins` in `WorkflowContext.ts` and `effect-runtime/src/types.ts`, kernel budget, docs. Untracked snapshots stay absent here (safe).
3. **S2c, adoption and rescan.** `seenOriginsSeed.ts`, every seeding site above, `compactionArchive` dependency, the error classification, paging, memo, lease handling, and the rescan tests.

Files: `packages/replay-vm/src/{eventHandlers.ts,foldEvents.ts,seenOrigins.ts}`; `packages/core` (state type, if exported); `packages/workflow-runtime/src/{WorkflowContext.ts,WorkflowRuntime.ts,LogLifecycle.ts,continuation.ts,blankStream.ts,seenOriginsSeed.ts,TimerService.ts (S3)}`; `packages/effect-runtime/src/types.ts`; `packages/app/src/defineConfig.ts` plus its config docs and `configGroups` test; `packages/spec/kernel-budget.json`; the EVENT_SCHEMA tables and event docs the spec guards read.

Tests required:
- Determinism (above): live, replay, snapshot plus tail, key-reordering store, and Postgres JSONB when the PG suite runs.
- Every channel row, including a non-kernel `MESSAGE_CONSUMED` and a duplicate (both ignored), both resume shapes, and carry / fork / continueAsNew rotation not laundering.
- Presence: a clean run has the key with `origins: []`; a run without `seenOriginsLimits` is untracked and `seenOrigins` is absent; with the gate off nothing is stamped and the folded state equals 1.26.0.
- Bounds: cap overflow, sticky flag, exceeded scan drops partial origins, truncation to `unknown:truncated:<digest>`, recorded limits survive a config change and a snapshot, invalid recorded limits ignored, construction refusals at each range edge; the vendored scan recognises every `tainted()` shape.
- Rolling deploy: a key left stale by a fold that does not advance `through` is detected (driver rebuilds, read-only reports overflow).
- Seeding: each site in the table uses the helper; a read-only site never returns a tail-only set; `restoreFromState` ignores a forged `_seenOrigins`.
- Rescan: from retained events; from a compacted log plus archive; each permanent error gives sticky overflow; a simulated timeout gives a retryable failure that persists and memoizes nothing; paged (peak events held is O(page)); the lease is held; the LRU memo.
- **A `*.perf.test.ts` (REQUIREMENT, measured before the fold scan is committed):** fold time with and without the scan on (a) a taint-free log with large outputs, (b) a log of many small tainted outputs, plus a rescan of a long history. Report numbers in the PR; a material regression on (a) switches the design to the producer-side stamp. Deterministic evidence (nodes visited) goes in a normal `*.test.ts`, never a timing ratio.
- D2 (task S3): hook absent is byte-identical; principal recorded; throw, reject and timeout each skip with `onError` and do not mis-classify as already-started or retry; `ticking` does not stick; two racing nodes; recovery resumes as the recorded principal; the hook is not called on a resume.
