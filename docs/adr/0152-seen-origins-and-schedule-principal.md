# ADR 0152 — Kernel seams for task-authority slice 2: run-level seen origins on the effect context; a principal hook for scheduled occurrences

- Status: **Proposed** (2026-11-23) — owner answered the four open questions the same day (see "Owner rulings"); nothing here is built
- Date: 2026-11-23
- Builds on: [ADR 0150](0150-task-scoped-authority.md) (D7 instruction provenance across lineages, D12 root authority
  for scheduled runs, and the 2026-11-23 slice-2 amendment), [ADR 0151](0151-effect-context-flush.md) (the model for an
  optional, additive `EffectContext` field that is absent where no fold backs the context),
  [ADR 0085](0085-untrusted-content-integrity-axis.md) (taint is a value wrapper with an origin label),
  [ADR 0111](0111-durable-principal.md) (the start principal is recorded on `EXECUTION_STARTED`),
  [ADR 0115](0115-open-vocabularies.md) (the `_resources` fold precedent), [ADR 0130](0130-sealed-payload-delivery-guard.md) D11 (occurrence leases),
  [ADR 0083](0083-second-consumer-rule.md) (second consumer).
- Found by: ADR 0150 slice-2 research (2026-11-23). Owner decisions: D7 through a KERNEL `EffectContext` field so the
  policy covers every flow and not only agent loops; D12 through a small `TimerService` principal hook.
- Gate: second consumer. D1: (1) `@loomwork/task-authority` `directedBy` (ADR 0150 D7); (2) audit and "why did this run
  see untrusted content" tooling, which today can only re-scan the log offline. D2: (1) task-authority scheduled roots
  (ADR 0150 D12); (2) any multi-tenant app whose schedules must run as a service principal of one tenant.
- Placement verdict: **kernel, two small seams.** D1 is a fold key (in `replay-vm`) plus one optional field wired in
  `WorkflowContext`; only the kernel sees every value that crosses into a flow, and a per-loop local (`sawTaintFrom` in
  `agentLoop$`) cannot cover flows that are not agent loops. D2 is one optional `TimerServiceOptions` field in
  `workflow-runtime`; `TimerService` owns `startOccurrence` and no outside code can set the start principal of a tick. All
  policy (what is foreign, what to do about it, which principal a schedule has) stays in 1P `@loomwork/task-authority`.
- Version/compat impact: **D1 bumps EVENT_SCHEMA 1.26.0 to 1.27.0; no new event kind, no payload change, no KERNEL_ABI
  change.** A new fold variable changes the folded BYTES of state, which is exactly what 1.26.0 (ADR 0138 D8: no kind,
  no payload change, bytes changed) and 1.23.0 (`_resources.custom`) bumped for. an old snapshot is rescanned once by the
  runtime at load (D1, "Snapshots"); `normalizeSnapshotState` stays pure. `EXECUTION_STARTED` gains the optional `seenOriginsLimits` (D1, "Bound"). `EffectContext.seenOrigins` is optional and additive. D2 is additive and
  opt-in: absent hook, byte-identical behaviour; no schema change. Kernel budget: `WorkflowContext.ts`, `TimerService.ts` and
  the replay-vm fold grow by the wiring (`LOOM_KERNEL_BUDGET_ADR=0152`; the kernel-budget file covers `workflow-runtime/src`, and
  the fold growth is checked against the replay-vm guard if one exists at implementation time).

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
  nothing about provenance, so a middleware cannot ask what the run has seen.
- `TimerService.startOccurrence` (`TimerService.ts:487-526`) starts a tick with `runtime.start(flow, def.input,
  { executionId, ...systemOptions() })` and **no principal**. The tick's effects run as an anonymous root, so a lease
  or grant middleware has nothing to key on. A schedule cannot carry authority of its own.
- Approvals are park-bound: `APPROVAL_GRANTED` is verified on resume (`verifyApproval`). A schedule has no park to
  attach one to, which is why D12 mints its grant in a one-off approval run (ADR 0150 amendment).

## Decision

### D1 — `EffectContext.seenOrigins`: the origins this run has been shown

```ts
interface EffectContext {
  // ...
  /**
   * ADR 0152 D1 — the distinct taint origins of every tainted value that has crossed INTO this
   * execution so far, as recorded in the log. A copy, live (read at call time), in first-seen
   * order. When the set overflowed, the list ends with SEEN_ORIGINS_OVERFLOW: a consumer MUST treat
   * that as "unknown, treat as foreign". Absent where no fold backs the context (the transient
   * seam, test harnesses): a consumer that needs it MUST fail closed.
   */
  readonly seenOrigins?: () => readonly string[];
}
export const SEEN_ORIGINS_OVERFLOW = "unknown:seen-origins-overflow";
```

**What "shown" means.** A tainted value crossed into the flow through one of the channels whose payload the log
already holds:

| Channel | Event | What the fold scans |
|---|---|---|
| Step / effect output (tool results, memory recall, an LLM turn, a child result) | `STEP_COMPLETED.output` | the output |
| Inbox delivery | `MESSAGE_CONSUMED` | the topic (as `inbox:<topic>`, exactly the origin `deliveredValue` stamps) and the delivered `payload` (a payload written as `lineage:A` is reported as `lineage:A`) |
| Gate / human resume payloads (a human step completes through `STEP_COMPLETED`; other gates through their resume event, named at implementation) | the resume payload | the payload |
| Flow input and a successor's carry | `EXECUTION_STARTED.input`, `continuedFrom.carried` | the value |

The fold scans exactly those fields with `scanTaint` from `@loomwork/classify` and unions the origins.

**Derived from the log, no new event, no syscall.** The set is a pure function of the event prefix, so replay, a
snapshot plus tail, and a second node recompute the same set. A flow-scope "add an origin" syscall is **rejected**
(Rejected alternatives): flow code that obtains a tainted value another way has either got it through one of the
channels above (and it is already in the set) or from outside the log (a closure, a module global), which breaks
replay purity regardless of provenance and is not a channel the kernel can vouch for. ADR 0150 D7 already says Loom
only sees Loom-owned channels. Interleaving note: with parallel branches the set at an effect is the fold at that
point, so it may include an output a sibling branch committed that the flow has not yet consumed. That is a
superset of "consumed" and the safe direction for a security check.

**Where it lives.** `state.variables._seenOrigins`, shape `{ origins: string[]; overflow?: true }`, in first-seen order.
It is a fold variable like `_resources`, `_inbox` and `_quarantined`, so it is also visible to introspection and audit
readers with no new API. Absent until the first tainted value is folded (a log that never carries taint folds
byte-identically to 1.26.0 apart from the version string).

**Bound (configurable, recorded per run: ruling S-R8).** Two limits, `maxOrigins` (default 64, range 1..1024) and
`maxScanNodes` (default 10_000, range 100..100_000; the classify scan default is `TAINT_SCAN_MAX_NODES = 100_000`).
- **Recorded, so replay never reads the current config.** The limits in force when a run starts are written on
  `EXECUTION_STARTED` as the optional payload field `seenOriginsLimits: { maxOrigins, maxScanNodes }`, and the fold reads
  the limits from that recorded field, never from runtime options. Changing the config therefore never changes what an
  existing log folds to. A run started before 1.27 has no recorded field and uses the defaults (64 and 10_000). A field
  that is present but out of range or not integers is ignored by the fold and the defaults apply (the same "invalid parts
  are ignored" rule as the other validated carry seeds). The field is covered by the same 1.27.0 bump; absent, a log folds
  as under 1.26.0.
- **Configured through runtime options.** `WorkflowRuntimeOptions.seenOriginsLimits?: { maxOrigins?: number; maxScanNodes?: number }`,
  threaded from `defineConfig({ kernel: { seenOrigins: { maxOrigins, maxScanNodes } } })` (the `kernel` group, next to
  `kernel.divergence` and `kernel.continuation`). Out-of-range or non-integer values are REFUSED at runtime construction
  (a thrown error naming the option), not clamped. The effective limits are stamped on each new `EXECUTION_STARTED`.
- **The per-origin length cap stays fixed at 256 UTF-16 units** (a longer origin is truncated by a fixed rule so the fold is
  deterministic). It is not configurable because it bounds a FORGED origin: an attacker who controls an origin label
  (a peer id, a tool name) must not be able to inflate every snapshot, and a per-run knob would let one misconfigured app
  reopen that. With the number of origins capped too, the set is at most `maxOrigins * 256` units.
- **Overflow.** The `maxOrigins + 1`th distinct origin sets `overflow: true` and is dropped; `overflow` is sticky.
  `seenOrigins()` appends `SEEN_ORIGINS_OVERFLOW` when set. A scan that hit `maxScanNodes` or the depth bound
  (`scanTaint` `exceeded`) also sets `overflow`, because "too big to look at" is not "clean". A consumer fails closed on
  the marker: under task authority it counts as a foreign lineage.

**Cost.** The scan runs in the fold, which also runs on replay, so it must be cheap on the common path:

1. Only the five fields above are scanned; primitives, `null` and `undefined` return immediately.
2. The kernel passes the run's recorded `maxScanNodes` (default 10_000, versus the classify default of 100_000) to
   `scanTaint`; an output over it sets `overflow` (fail closed) instead of costing 100k node visits per fold.
3. The fold does the walk only once per event: a snapshot carries the set, so resume from a snapshot scans the
   tail only (`fold(snapshot, tail) == fold(events)`).
4. The cost is O(size of the recorded fields) once per event, the same order as the append's own serialization. A
   `*.perf.test.ts` (never a timing assertion in a `*.test.ts`) is a REQUIREMENT of task S2, measured BEFORE the fold
   scan is committed (see "Implementation notes for S2"). If it shows a material regression, the fallback is the
   producer-side variant in Rejected alternatives.

**Snapshots: rescan once at upgrade, fail closed only when the prefix is unavailable (owner ruling).** A pre-1.27 snapshot
has no `_seenOrigins`, and a fold of its tail alone would miss everything the snapshot compacted. The rebuild cannot live in
`normalizeSnapshotState`: that function is synchronous, pure and has no store access (it only repairs shapes in O(1) or
O(frames)). It lives where the runtime turns a loaded snapshot into a replay seed, the `loadLatest` then `seedOf(snapshot, ...)`
path in `WorkflowRuntime` (resume at ~4016/4083, and the other `seedOf` callers). On a snapshot whose `variables` has no
`_seenOrigins` key, the runtime:

1. reads the execution's retained events from sequence 0 (`eventStore.read`);
2. if the log was compacted (the first retained sequence is above 0, or the archive's `headers` cover `[0 .. first-1]`), also reads
   the archived range. The runtime already holds the compaction `ArchiveStore` (the same store as the inbox archive, ADR 0139 D1,
   passed as `compactionArchive` and wired by `defineConfig` from `retention`), and `LogLifecycle.readWithArchive` is the one read
   that stitches `archived ∪ log`, verifying each segment's digest (ADR 0138 D5). The rescan uses that read path. It is a
   deliberate, single exception to ADR 0138 D5's "the resume path never touches the archive": it runs once per old execution, only
   when the key is absent;
3. folds the prefix `[0 .. snapshot.sequence]` with the same scan rules, using the limits recorded on that prefix's
   `EXECUTION_STARTED` (defaults when absent: a pre-1.27 run has none), and seeds the result into the snapshot state. The tail then folds on top as
   usual, so `fold(snapshot, tail) == fold(events)` holds.

Only when neither source yields the FULL prefix does it set `{ origins: <what was found>, overflow: true }` (fail closed):
no archive configured for a compacted log, `ArchiveIncompleteError` (a pre-ADR-0138 compaction, or an archive that lost segments), an
`ArchiveDigestError`, a sealed archive whose key was shredded (`PayloadShreddedError`), or an erased subject. None of these
throws out of the resume; the run continues with the marker. The rebuilt key is kept in the seed for that resume and is
persisted by the next snapshot the cadence writes; a runtime also memoizes the rebuilt set per execution (bounded) so a
repeated resume of the same old execution before its next snapshot does not rescan.

**Cost of the rescan:** one read plus one fold of the whole history, ONCE per pre-1.27 execution that has a snapshot (an execution
with no snapshot folds its whole log anyway and pays nothing extra; one that starts after the upgrade never rescans). It is O(events) store reads, not
O(1), which is why it is a one-time upgrade cost and not a per-resume cost. A pre-1.27 node folding a 1.27 log ignores the key
(the documented mixed-fleet exception, as 1.26.0).

**Wiring.** `WorkflowContext` adds, next to `readResources`:
`seenOrigins: (): readonly string[] => this.seenOriginsCopy()` (a copy of the fold's list plus the overflow marker).
Mutating the result never reaches the fold, the same rule as ADR 0151 D6.

**What D1 does NOT do.**
- It decides nothing. Foreign versus own, which effects are checked, and attribute / park / deny belong to
  `@loomwork/task-authority` `directedBy` (ADR 0150 D7 and S-R2/S-R3 of the slice-2 plan).
- It does not know the word "lineage". Origins are opaque strings; `lineage:<rootId>` is task-authority's convention.
- It does not tag writers. Content-level tagging (`tainted(value, "lineage:<rootId>")`) is the 1P writers' job (S-R1).
- It does not see channels outside the log (a file in a shared bucket, timing).
- It does not un-see: the set only grows within an execution. A child execution has its own set; a continuation inherits
  the parent's through the carry scan.

### D2 — `TimerServiceOptions.principalFor`: a principal for a scheduled occurrence

```ts
interface TimerServiceOptions {
  // ...
  /**
   * ADR 0152 D2 — the principal a scheduled occurrence starts as. Called once per occurrence this node is about
   * to start, after the already-started check and before `runtime.start`. Absent: the occurrence starts with no
   * principal, exactly as before. A throw or rejection skips THIS occurrence (it is reported through `onError`).
   */
  readonly principalFor?: (
    schedule: ScheduleDefinition,
    occurrence: number
  ) => PrincipalChain | undefined | Promise<PrincipalChain | undefined>;
}
```

In `startOccurrence`, after `getFlow` and before `start`: `const principal = await this.principalFor?.(def, occurrence)`,
then `runtime.start(flow, def.input, { executionId, ...(principal !== undefined && { principal }), ...systemOptions() })`.

- **Recorded per ADR 0111.** The principal is written on `EXECUTION_STARTED` and rehydrated on every execute through the
  codec/resolver, so the tick's effects run as that principal and the grant it carries, never as the system.
- **The system grant still bypasses the execution authorizer** for the lifecycle op `start`, as today
  (`systemOptions()` is spread unchanged). The hook supplies WHO the run acts as; it does not make the start an
  authorized-as-that-principal operation. That is deliberate: a timer has no caller to authorize.
- **Absent means byte-identical.** No hook, no extra await, no extra option key.
- **Occurrence fencing and recovery.** The deterministic id `${def.id}@${occurrence}` and every guard in
  `startOccurrence` are unchanged: `loadState` fast path, `ExecutionAlreadyExistsError` for a raced loser, `StartLeaseHeldError`
  mapped to `"retry"` (ADR 0130 D11), and the L12 rule of no fence on this start. Because two nodes can race the same occurrence, the hook may run on
  both and the FIRST successful `start` wins and records its principal; the hook must therefore be deterministic for a
  given `(schedule, occurrence)` (a pure function of the schedule's recorded grant). A node that loses the race
  discards its principal with its refused start, and `redriveAbandoned` resumes the execution as the RECORDED principal, not
  by calling the hook again.
- **A throwing or rejecting hook skips that occurrence.** The start is never attempted, so nothing runs without the
  principal the app asked for (failing open to an anonymous root would be the unsafe direction). The error goes to
  `onError(executionId, err)`. The return value is `"done"` and the cursor advances, so the loop cannot spin; the occurrence is
  skipped, not retried. If an app wants retry for a transient hook failure, the hook itself retries or the app catches
  and returns a principal. The alternative (`"retry"`, which holds the cursor) is an open question below, because it also holds every
  later occurrence of that schedule behind one stuck hook.
- A hook returning `undefined` is "start with no principal" (the pre-0152 behaviour), so an app can scope the hook to the schedules
  that carry authority.

**What D2 does NOT do.** It mints nothing and verifies nothing: the schedule grant, its one-off approval run and the
per-tick child grants (ADR 0150 D12) are task-authority's. It does not change `systemOptions`, the lease or recovery
paths, and adds no event.

## Consequences

- A middleware can ask "have I been shown another lineage?" for any flow, from the same fold replay uses, with no
  per-loop state. `agentLoop$` keeps `sawTaintFrom` for prompt fencing; it need not change.
- Fail-closed by construction: a bounded scan, a capped set, an old snapshot and an absent field all read as
  "unknown / foreign", never as "clean".
- Cost: the fold scan (guarded as above), 64 short strings per run at worst, and no new store round trip. D2 costs nothing without the hook.
- Replay of an existing log is unchanged in meaning: taint that was never recorded is not invented, the same limit
  ADR 0085 states. A log carrying no taint folds identically.
- Residual: the set is evidence of what was shown, not of what influenced a decision. A model that was shown `lineage:A` and
  paraphrases it is still covered because the set is run-level; an effect directed by content that never entered through a recorded channel is invisible
  (ADR 0150 D7 "Does not").

## Rejected alternatives

| Alternative | Why rejected | What would reopen it |
|---|---|---|
| Keep it in `agentLoop$` (a set instead of `sawTaintFrom`) | Owner decision: the policy must cover every flow; a loop-local set cannot be read by lease middleware and is lost on a restart that replays the loop from a snapshot. | — |
| A flow-scope `ctx.markSeen(origin)` syscall | A new syscall and a way for flow code to forge or erase evidence; a value not from a recorded channel is outside the replay contract anyway. Flow code is already bounded, not trusted. | A recorded channel the kernel cannot see but must trust (name it with a second consumer). |
| Scan at commit and stamp the event (`STEP_COMPLETED.seen?`) | Cheapest fold, but a payload change on the hottest event, producers must agree, and the stamp can be absent or wrong with nothing to check it against. | The D1 perf gate shows a material fold regression. |
| Compute in `WorkflowContext` from values returned to the flow (no fold key) | No schema bump (the owner accepted 1.27.0, so this is moot), but the set is then invisible to introspection and audit readers, and a continuation or snapshot resume depends on the flow re-running from the start to rebuild it. | Evidence that the schema bump is unacceptable to the fleet. |
| Unbounded set | An attacker who controls many origins (peer ids, tool names) grows every snapshot. | — |
| Old snapshots read as overflow (fail closed) with no rescan | Owner ruling: an old run would be treated as foreign forever, so `directedBy` could park or deny every effect of every pre-upgrade execution until it ends. Rescan costs one pass; fail-closed stays as the floor. | A fleet where the history of old executions is unavailable (no archive for compacted logs) is the case the floor already covers. |
| Hard-coded, unrecorded limits, or limits read from current config at fold time | A config change would change what an existing log folds to, so replay would diverge from the original run. Limits are recorded per run (S-R8). | — |
| A configurable per-origin length cap | It bounds a forged origin; a knob would let one app reopen the snapshot-inflation attack. | Evidence of a real origin scheme longer than 256 units. |
| `principalFor` retries on a hook error (`"retry"`) | One stuck hook would hold the cursor and stall every later occurrence of the schedule. | Owner prefers stalling over skipping. |
| Start the occurrence anonymously when the hook throws | Fails open: effects would run with no grant and no lease. | — |
| Put the schedule grant on `ScheduleDefinition` | Couples the kernel schedule type to a 1P vocabulary; a callback keeps the kernel opaque and lets one hook serve many schedules. | — |

## Owner rulings (2026-11-23)

1. EVENT_SCHEMA 1.27.0 is accepted.
2. Old snapshots are RESCANNED at upgrade (D1 "Snapshots"), not failed closed; overflow only when the full prefix is unavailable.
3. A throwing or rejecting `principalFor` SKIPS the occurrence (D2).
4. The bounds are CONFIGURABLE, recorded per run (S-R8, D1 "Bound"). The per-origin length cap is fixed.

## Implementation notes for S2

Files the implementation will touch:
- `packages/replay-vm/src/eventHandlers.ts`: the `_seenOrigins` fold in `EXECUTION_STARTED` (reads `seenOriginsLimits`, seeds from `continuedFrom.carried`), `STEP_COMPLETED`, `MESSAGE_CONSUMED` and the resume payload event; `EVENT_SCHEMA_VERSION` to `1.27.0` and its history comment; the exported constants (`SEEN_ORIGINS_OVERFLOW`, defaults, per-origin cap).
- `packages/replay-vm/src/foldEvents.ts` / `packages/core`: the state/type for `_seenOrigins`; any exported schema constant.
- `packages/workflow-runtime/src/WorkflowContext.ts`: `seenOrigins` next to `readResources`, plus the `seenOriginsLimits` stamp on `EXECUTION_STARTED`.
- `packages/workflow-runtime/src/WorkflowRuntime.ts`: the `seenOriginsLimits` option with construction-time range validation, and the snapshot rescan beside `seedOf` (using `LogLifecycle.readWithArchive` / the compaction archive).
- `packages/effect-runtime/src/types.ts`: the `EffectContext.seenOrigins` field.
- `packages/app/src/defineConfig.ts` (+ its config docs and `configGroups` test): `kernel.seenOrigins`.
- `packages/spec/kernel-budget.json` (`LOOM_KERNEL_BUDGET_ADR=0152`), the EVENT_SCHEMA version tables and event docs the spec guards read, and `docs/architecture.md` / CHANGELOG.

Tests required:
- Determinism: the same log gives the same set live, on replay, from a snapshot plus tail, and across two nodes.
- Each feeding channel (output, inbox topic, nested `lineage:A` in an inbox payload, resume payload, input, carry), and a log with no taint folds byte-identically apart from the version.
- Bounds: the cap overflow, the sticky flag, scan-bound overflow, the 256 truncation, recorded limits used when config later changes, defaults when no field is recorded, invalid recorded limits ignored, and construction refusals at each range edge.
- `seenOrigins()` is a copy, live, and absent where no fold backs the context.
- Rescan: an old snapshot rebuilt from retained events; from a compacted log plus archive; overflow when no archive, on an incomplete or tampered archive, and on a shredded one; no rescan when the key is present; memoized per execution; `fold(snapshot, tail) == fold(events)`.
- **A `*.perf.test.ts` (REQUIREMENT, measured before the fold scan is committed):** fold time with and without the scan on (a) a taint-free log with large outputs and (b) a log with many small tainted outputs, plus a rescan of a long history. Report the numbers in the PR; a material regression on (a) switches the design to the producer-side stamp before merge. Deterministic evidence (nodes visited) goes in an ordinary `*.test.ts`, never a timing ratio.
- For D2 (task S3): hook absent is byte-identical; principal recorded on `EXECUTION_STARTED`; a throwing and a rejecting hook skip the occurrence with `onError`; two racing nodes; recovery resumes as the recorded principal.
