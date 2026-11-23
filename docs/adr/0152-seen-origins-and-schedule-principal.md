# ADR 0152 — Kernel seams for task-authority slice 2: run-level seen origins on the effect context; a principal hook for scheduled occurrences

- Status: **Accepted** (2026-11-23) — accepted by the owner after the S2a/S2b reviews; D1 built in S2a–S2c (gate off by default), D2 (`principalFor`) builds in slice-2 task S3. History: proposed 2026-11-23, the owner answered the four open questions the same day (see "Owner rulings"), an Opus design review was applied, and ruling R11 moved the scan from the fold to the COMMIT (see "Revision")
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
  - Kernel budget (`packages/spec/kernel-budget.json` budgets only `packages/workflow-runtime/src`): R11 puts the commit-time
    scan in `ExecutionJournal.ts` (about 30 code lines: one call in `commit`, one in `commitAtomic`, one in the shared
    `build`, plus the strip of caller-supplied keys). `WorkflowRuntime.ts`, `LogLifecycle.ts`, `WorkflowContext.ts`,
    `continuation.ts` and `TimerService.ts` still grow, and the new `seenOriginsSeed.ts` is a new kernel file that needs its own budget
    entry; all need `LOOM_KERNEL_BUDGET_ADR=0152`. The scan, the record and the fold code land in `packages/replay-vm`, which has
    NO budget guard today (stated so a reviewer sees it). Honest growth: about 250-350 code lines across the budgeted
    `workflow-runtime` files (the seeding helper with the rescan and error classification is the bulk, 150+), plus a
    `replay-vm` module of 250-300 lines.

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
  through?: number }                                      // state.sequence after the last fold step; absent = unproven (see below)
```

- **A present key with a `through` means "folded by a 1.27 kernel from sequence 0, up to `through`".** When the payload of `EXECUTION_STARTED` carries a valid
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
- **Off (default):** nothing is stamped (`seenOriginsLimits` is not written), so a run with no stamp and no carried set folds no key
  (the fold keys on the RECORDED stamp or carry, never on the runtime gate), `EffectContext.seenOrigins` is
  ABSENT, the helper of "Seeding sites" is a no-op. Behaviour is byte-identical to 1.26.0. Consumers treat absent as
  "untracked". **A gate-off `continueAsNew` writes no `carried.seenOrigins` either** (R15): the carry is written only while the gate is on, so
  the successor of a tracked predecessor on a gate-off node is untracked and reads as absent (fail closed), never as a key with default limits.
- **On:** `start` and the continuation start stamp the limits; the driver paths adopt untracked runs (see "Adoption");
  `seenOrigins` is present for a tracked run.
- **The operator turns the gate on only after every node runs a 1.27.0+ kernel**, the ADR 0109 D8 rule. The way to know it is
  safe: every node reports `EVENT_SCHEMA_VERSION >= "1.27.0"` (the version string a node exposes through the existing version
  surface) and `knownEventTypes()` is unchanged; the docs for the flag say so next to `continueAsNew`'s.
- **If the gate is enabled while a 1.26 node still folds these runs** the runtime cannot see that node, but the key detects the
  damage. Every 1.27 fold step sets `through = state.sequence`, and a 1.26 node leaves it stale while still advancing
  `state.sequence`. The test is `through !== snapshot.state.sequence` (NOT `snapshot.sequence`: `commitAtomic` folds a whole
  batch before `maybeSnapshot` saves `vm.getState()`, so a healthy snapshot's `sequence` can be below its state's, while
  `state.sequence` and `through` are advanced together by the same fold; `ExecutionJournal.commitAtomic` ~262-307,
  `WorkflowRuntime.ts:9015-9026`). The test lives INSIDE `normalizeSnapshotState` (below), so every reader inherits it. A 1.26
  node's own effects have no `seenOrigins` (the field does not exist there), so a consumer sees absent = untracked and fails closed.
  **`through` is not the whole safety net** (R13): it catches a stale 1.26 FOLD of the key, not a 1.26 WRITER that appends a tainted
  channel event with no record while a 1.27 fold advances `through` honestly. That case, and every commit path that bypasses the
  journal's scan (the reopen bootstrap batch until it is wired, any future path), is closed by the "no record is overflow" rule below.

#### Staleness is checked in `normalizeSnapshotState` (O(1), every caller inherits it)

`normalizeSnapshotState` (`replay-vm/src/foldEvents.ts`) gains one O(1) step: a `_seenOrigins` whose `through` is not
`state.sequence` becomes `{ v, limits, origins, overflow: true }` with `through` DROPPED. A dropped `through` is the "unproven" marker:
the key reads as overflow (fail closed) to every reader, and a driver site can tell it from a sticky overflow (which keeps its `through`) and rebuild it.
Because the check is in the one function every snapshot reader already calls, the callers that cannot import
`workflow-runtime` are covered without change: `packages/compliance/src/eraseSubject.ts:1731`,
`packages/replay-inspector/src/reconstruct.ts:173`, `foldFromCompleteLog` and `blankStream.ts`. The async helper below then only
does the DRIVER rescan and adoption. The fold step advancing `through` must not re-validate a key without `through`: a key
that lacks it stays overflow until a rescan replaces it.

#### What feeds it: scanned ONCE at commit, recorded on the event, unioned by the fold (R11)

**The fold does not scan.** A measurement of the first design (a fold-time scan) showed the fold is O(1) per event today because it
never looks inside an output: a taint-free log of 2000-node outputs folded about 290x slower with the scan (0.8 ms to 225 ms for
3000 events, about 37 ns per node, 75 us per event). Owner ruling R11 therefore moves the walk to the one place that sees a value
exactly once, live: the journal commit. It records what it found; the fold unions recorded lists and replay never rescans.

- **Where it runs.** `ExecutionJournal` (`packages/workflow-runtime/src/ExecutionJournal.ts`) is the single allocator and the
  only committer for a live run, so the scan lives in its shared envelope builder and is reached from all three entry points:
  `commit` (every kernel `commit` call and every `WorkflowContext` emit path, including a userspace emit of `DECISION_RECORDED`,
  which reaches the same `commit`), `commitAtomic` (the notify path's `[MESSAGE_CONSUMED..., EXECUTION_RESUMED]` batch; each
  envelope is scanned against the state AFTER the earlier ones in the batch were folded, exactly as `applyEvent` sees it), and the
  static `bootstrapEnvelope` (the sequence-0 start, which has no vm yet). `adopt` takes an envelope that is already durable and
  scans nothing. The scan function itself, `seenOriginsRecord(before, eventType, payload, metadata)`, is in `replay-vm`
  (`seenOrigins.ts`), so the upgrade rescan of S2c reuses it.
- **Where it is recorded: the envelope metadata, not the payload.** `metadata.origins?: string[]` (sorted in code unit order,
  each at most 256 characters or its `unknown:truncated:<digest>`, deduped, at most `limits.maxOrigins`) and
  `metadata.originsOverflow?: true`. The first form of R11 named payload fields; metadata is chosen because the positional
  `EXECUTION_RESUMED` payload is the caller's own value that the flow receives back, and adding a key to it would change the delivered
  value, a digest and a sealed payload. Metadata already carries the other kernel stamps (`kernel`, `fence`, `forkChain`, `flowEmit`)
  and changes neither the payload nor what a flow reads. **A tracked, non-overflowed run records on EVERY channel event, `origins: []` when the value is clean (R13).** Absent no longer
  means clean: a channel event of a tracked run that carries neither `origins` nor `originsOverflow` was not scanned by a 1.27 journal
  (a 1.26 writer, an unwired commit path), so the FOLD reads it as OVERFLOW (fail closed). The cost is about 14 bytes of metadata per
  channel event of a tracked run. The record is capped: more than `maxOrigins` distinct origins on one event records
  `originsOverflow: true`. Origins are PLAINTEXT metadata: they are not sealed and not crypto-shredded (an origin label is a
  tool name or peer id, never content; ADR 0130 sealing covers payloads only).
- **How "tracked" is known at commit.** The scan runs only when the vm's state has a valid `_seenOrigins` key that is not already
  overflowed: its `limits` bound the walk. For the start envelope (no state yet) the payload's `seenOriginsLimits` stamp or a carried
  set plays that part. **A value committed while the run is untracked records nothing**, and an overflowed key records nothing
  further (the set is sticky; scanning would only spend time).
- **The fold** (`replay-vm`, after each handler, for exactly the channels below) unions `metadata.origins` into the key
  and sets `overflow` for `metadata.originsOverflow`, or when a channel event carries neither. It never opens a payload. For a key that was not
  just seeded it also checks `through === state.sequence` (the prior sequence) and reads a mismatch as unproven overflow (defence for a path
  that did not go through `normalizeSnapshotState`). Its cost is O(k) for the recorded list, plus the
  copy-on-write advance of `through` on every event of a tracked run. Because the recorded list is the source, the live fold and
  the replay fold read the same bytes: key order and JSONB reordering of an output cannot change the result for a 1.27 event.
- **Trust model.** `origins` and `originsOverflow` are kernel-written. `ExecutionJournal.build` removes any caller-supplied
  `origins` / `originsOverflow` from `opts.metadata` BEFORE it writes its own (the same "applied last, the journal's alone" rule as the
  `kernel` stamp), so no emit path a caller influences can set them: `guardUserspaceEmit` and the payload of every kernel
  event cannot carry the field because the field is not in the payload at all, and a payload key named `origins` is ordinary
  data the fold never reads. The fold honours the metadata field only on the channel event types below. A log written by something other
  than the journal is outside the trust model, as for `kernel` and `fence`.
- **Pre-1.27 events** carry no record and the fold does not scan them. They are scanned only by the one-time upgrade rescan
  ("Rescan"), which walks the JSON view and keeps the determinism rules below, because it reads JSON from a store.

The channels (the event type, the field scanned, and the verdict). The rule for "which value" is evaluated at commit against the
state before the event, exactly as the fold evaluates the handler:

| Channel (event, field) | Verdict | Why |
|---|---|---|
| `STEP_COMPLETED.output` | **scan** | Tool, memory, LLM and child results. Human-step answers (`WorkflowContext.ts` ~932) and in-doubt adoptions (~904) commit the same event, so they are covered by this row. |
| `MESSAGE_CONSUMED` | **scan when `isKernelWritten(event)` and not a duplicate**: origin `inbox:<topic>` plus a scan of `payload` | The fold already ignores a consume that is not kernel-stamped or whose messageId is in the dedupe window; a delivery that never reached the flow did not show it anything. The `inbox:<topic>` origin is the kernel's attestation of the CHANNEL (it is the same origin `deliveredValue` stamps), recorded even when the payload is clean, so "this run read topic T" is visible; it is kept and is not a duplicate of the value scan. |
| `EXECUTION_RESUMED`, positional payload | **scan** `payload` (not when `isStatusOnlyResume`) | A gate resume payload is handed to the flow. |
| `EXECUTION_RESUMED`, wait-addressed `{ waitId, payload }` | **scan** the unwrapped inner payload, only when the answer is recorded (`addressed.answer`) | The same value enters `_waitAnswers`; an addressed inbox answer also has its `MESSAGE_CONSUMED`. |
| `DECISION_RECORDED.choice` | **scan** | A decider reads untrusted data through transient calls or memory recall, and `ctx.decide` hands the choice back to the flow. `alternatives`, `context` and `policy` are NOT scanned: they are the decider's inputs recorded for audit and are not returned to the flow. |
| `STEP_FAILED.payload` (DE-4 typed failure, only with `channel`) | **scan** | A typed failure's payload is delivered to the flow's `catch` as data. `STEP_FAILED.error` is not scanned: it is serialized error text, never a wrapper (the agent loop wraps tool errors itself, `tool-error:`, in an OUTPUT). |
| `PARALLEL_COMPLETED.errorPayload` | **scan** | The same typed-failure data on a parallel scope. |
| `EXECUTION_MIGRATED.migratedInput` | **scan** | The migrated input replaces `_input`. |
| `EXECUTION_STARTED.input` | **scan** | The flow input. |
| **the reopen bootstrap batch** (`WorkflowRuntime.landReopenBootstrap`, `ExecutionJournal.envelopeAt`) | **scan, against a scratch fold** | It writes channel events (an `EXECUTION_RESUMED`, an `EXECUTION_MIGRATED.migratedInput`) without the journal, so the vm only advances at `adopt`: each envelope is scanned against the vm state folded with the EARLIER batch entries, and the scratch fold is rebuilt from the refolded late `OUTCOME_RECORDED` on each retry. `claimRecovery`'s `EXECUTION_RECOVERED` is not a channel and carries nothing. |
| continueAsNew carry | **carry the set**: add `carried.seenOrigins` to `carriedOf` (`continuation.ts:194`, as `resources`) and seed the successor from it, validated like `seedResources`; the carry itself is also the successor's `input`, so it is scanned too | Without it, rotating through `continueAsNew` launders every origin seen so far. The **carried-set shape** is `{ origins: string[], overflow?: true }` (each origin re-capped and deduped on seeding, more than `maxOrigins` gives overflow); `carriedOf` carries the overflow marker too. The rule, applied wherever a key is seeded (the fold at `EXECUTION_STARTED` and adoption, not only the successor stamp): **a stamp is present AND `continuedFrom` is present AND no carried set was supplied gives `overflow`** (a successor of a keyless predecessor cannot prove a clean past). The carried set is bounded by `maxOrigins x 256` bytes (default 16 KB, at most 256 KB) and is NOT counted by `maxCarryBytes`. |
| fork | **follows `forkResources`** (`eventHandlers.ts` ~514-540): a fork of a chain member keeps `carried.seenOrigins`, and the same rule applies (stamp and `continuedFrom` and no carried set gives overflow); an ordinary fork copies its prefix, key included | A fork must not shed what its parent was shown. |
| child results | **not propagated by the kernel** | Reading another execution's fold from inside this one would couple two logs and add an unbounded cross-execution read. The 1P orchestration supervisor taints the `CHILD_DONE` body with the child's seen origins (task-authority slice 2, S5), so the ordinary `STEP_COMPLETED` or inbox scan recovers them; the kernel carries opaque strings and stays out. |
| the decide scope's `invokeTransient` and other transient calls | **absent** | They emit nothing and have no fold; `seenOrigins` is undefined there (M8), and a consumer fails closed. |

**No new syscall and no new event.** A flow-scope "add an origin" syscall is rejected (Rejected alternatives): a value not
from a recorded channel is outside the replay contract. With parallel branches the set at an effect is the fold at that
point, so it may include an output a sibling branch committed that the flow has not consumed yet: a superset of "consumed",
the safe direction for a security check.

#### The scan (determinism)

There are TWO walks over one rule, and they must not be confused:

- **The commit walk is over the LIVE structure** (R13), because `WorkflowContext` hands the flow the LIVE `output`, not its JSON image: a
  `Map` entry, a field a `toJSON` hides, a non-enumerable property are all reachable by the flow. It applies exactly classify's
  `isTainted` predicate (`__loomTainted` an object with a string `origin`, and a `value` key) to each own enumerable value BEFORE any
  `toJSON`, and walks `Map` and `Set` entries. It FAILS CLOSED (`originsOverflow`, no partial origins) on anything it cannot walk
  faithfully: any `toJSON` other than `Date`'s, an accessor (getter or setter) or a non-enumerable or symbol-keyed own property, a
  non-plain prototype (a class instance, a `Map`/`Set` subclass), a cycle, a depth over 64, or more than `limits.maxScanNodes` nodes.
  `ArrayBuffer` and its views are skipped (as `scanTaint` does), and so are the own properties of a function (both as `scanTaint` does); `Date` is a leaf only when it has no own key (a `Date` with any own property records overflow). **Residual (R14):** a `Proxy` whose `getOwnPropertyDescriptor` disagrees with its `get` can show the walk a clean structure and the flow a tainted one; exploiting it needs trusted in-process code, and detecting it needs `node:util`'s proxy check, a dependency `replay-vm` does not take. A recorded `origins` array with any non-string entry folds as overflow, and the journal strips a caller-supplied `origins` / `originsOverflow` only from the channel event types (application metadata elsewhere is left untouched). A caveat for readers of `ExecutionJournal`: the
  walk runs synchronously inside the commit (the accessor refusal checks descriptors rather than reading values, so a getter is not
  invoked), a re-entrant commit from user code is not supported, and a value mutated after the commit is not rescanned (what the log
  recorded is what the run was shown).
- **The rescan walk is over the JSON VALUE** (a store such as Postgres JSONB reorders object keys, and a stored event has no live
  structure): a pure function of the JSON, not of object identity or key order, so the one-time upgrade rescan of pre-1.27 events is
  deterministic.

The rules both walks share:

- **A vendored walk in `replay-vm`** (`replay-vm` has no `classify` dependency, and the kernel must not inherit later
  semantic changes to `scanTaint`): iterative, depth pinned at 64 (M6). The rescan walk normalises to the JSON view: own enumerable string
  keys of plain objects and arrays; `toJSON()` applied where present, and `Map`, `Set`, `undefined`, functions and symbols
  treated exactly as `JSON.stringify` treats them; non-finite numbers are leaves.
  **Cycle detection only** (an ancestor stack); there is NO shared-reference dedupe (a `WeakSet` would make the node count
  depend on object identity, which a JSON round trip changes). A cycle, a depth over 64, or more than `limits.maxScanNodes`
  visited nodes is `exceeded`. Node counting is independent of key order.
- **The wrapper shape** it recognises is classify's: an object whose `__loomTainted` is an object with a string `origin`
  and that has a `value` key. A test (in `replay-vm`, with classify as a dev dependency only) asserts every shape
  `tainted()` produces is recognised, so the two cannot drift silently.
- **Per-event origins are sorted** (code unit order) before they are recorded and unioned, so first-seen order within an
  event never depends on object key order. The `inbox:<topic>` origin goes through the same 256-character cap as every other origin.
- **An exceeded scan records `originsOverflow` ONLY and drops the partial origins it found**, because which origins a bounded walk
  reaches first depends on traversal order.
- **Truncation before dedupe and count:** an origin longer than 256 characters is replaced, BEFORE it is deduped or counted, by
  `unknown:truncated:<fnv1a-64 hex of the full origin>` (M4). The digest is FNV-1a 64-bit over the UTF-8 bytes of the full origin, as 16
  lowercase hex digits. A deterministic non-cryptographic digest is enough: a collision
  only merges two labels that were both over-long. The 256 cap therefore bounds both the stored size and a forged flood.
- **The `maxOrigins + 1`th distinct origin sets `overflow`** and is dropped; overflow is sticky.
- **The determinism test** (required for S2) asserts: (a) the fold reads the RECORDED list, so folding the same log live, by replay
  from JSON, and from a snapshot plus tail gives equal `_seenOrigins`; (b) the recorded record is identical when an event is committed from an
  in-memory value and when the same event is scanned from JSON whose key order is reversed (an in-memory event-store decorator that
  re-emits every payload with reversed key order, standing in for Postgres JSONB; against the real JSONB store in the Postgres-gated
  suite); and (c) an old log with no records is scanned only by the rescan, with the same result under reversal.

**Cost.** The live scan is O(nodes of the scanned field, up to `limits.maxScanNodes`), once per event, at commit, and only for a tracked
run: measured at about 37 ns per JSON node (a 2000-node output costs about 75 us once). Replay and the tail fold pay O(k) per event for the
recorded list (k at most `maxOrigins`) plus the copy-on-write advance of `through`; they never walk a payload. `maxScanNodes` bounds the
walk's NODE count, NOT the CPU below payload size: a payload of a few nodes with megabyte strings costs its serialization anyway, and `toJSON`
normalisation touches every property. Only the fields in the table are scanned; primitives and `null` return immediately; a snapshot
carries the set so a resume reads only the tail. The perf requirement stands, re-aimed (see "Implementation notes"): the FOLD with records on must stay
near the untracked baseline, and the live commit-scan cost is reported.

#### Seeding sites: staleness in `normalizeSnapshotState`, rescan in one async helper

Every site that turns a loaded snapshot into a `ReplayVM` seed calls the synchronous `normalizeSnapshotState`, alone or through
`WorkflowRuntime.seedOf`. Two layers cover them:

1. **Read-only safety, inherited by every caller** (S2a): `normalizeSnapshotState` marks a stale key as unproven overflow (above).
   An ABSENT key stays absent: a read-only site reports an untracked run as **absent** (`seenOrigins` undefined, the same answer the
   effect context gives), never as a tail-only set. This is consistent with D1 ("absent means untracked") and S2b.
2. **Driver rescan and adoption**, one async helper `rescanSeenOrigins(...)` (module `packages/workflow-runtime/src/seenOriginsSeed.ts`),
   used only by the driver sites. With the gate off it is a no-op. With the gate on it acts when the state's key is absent (adoption) or
   has no `through` (unproven), and does nothing for a trusted key or a sticky overflow.

**Ordering: the rescan runs AFTER the driver lease, never before.** The resume vm is built early (`WorkflowRuntime.ts:4083`), before
`takeDriverLease` (`:4243`) and before the refusals and stand-down, and a rescan there would read a whole history for a call that then stands
down. So at `:4083` the seed is read-only (layer 1). Immediately after `takeDriverLease` and before the fence, the driver calls the helper, which rescans
`[0 .. vm.state.sequence]` (the tip the vm already folded) and **replaces the key wholesale** on the vm state. Replacing, not merging, avoids
double counting; and because the origin union is idempotent, a rescan that overlaps tail events the vm already folded changes nothing. The key's `through` is set to
`state.sequence`. The same ordering applies to flow migration (`takeDriverLease` ~`:7490`) and `restoreFromState` (`:3550`), and a fork rescans before it writes. **Compaction rescans BEFORE
`archiveRemoved` and the truncate** (`LogLifecycle.ts` ~1146-1194): once the prefix is archived and truncated it is only reachable through the archive, and a
crash between the two must never leave a saved checkpoint with an unproven key.

Sites (line numbers at main 7409550f; `W` = `packages/workflow-runtime/src/WorkflowRuntime.ts`, `L` = `LogLifecycle.ts`):

| Site | Today | Treatment |
|---|---|---|
| `W:4016/4083` resume | `loadLatest` then `seedOf` | seed read-only; rescan after `takeDriverLease` (`:4243`) |
| `W:7357/7361` flow migration | `loadLatest` then `seedOf` | read-only seed; rescan after `takeDriverLease` (`:7490`) |
| `W:7692-7728` `foldState` and its ~25 callers (`:1978, :3068, :3406, :3439, :3556, :4493, :4795, :4961, :5029, :5115, :5350, :5432, :5543, :5570, :5929, :5991, :6069, :6406, :6975, :6991, :7605, :8454, :8463, :8482, :8628`) | `loadLatest` then `seedOf` | read-only; a caller that feeds a write (the continuation predecessor `:8628`, recovery re-drive `:4493`) rescans after its own lease |
| `W:3451-3520` `restoreFromState` | a caller-supplied state | the caller's `_seenOrigins` is UNTRUSTED (M10): dropped, then rebuilt by the post-lease rescan. **The drop lands in S2b**, so no PR trusts a forged key |
| `W:8059/8890-8903` fork (`materializeStateAt`) | `seedOf(base, …, retarget)` over a `loadAt` base | read-only seed; rescan before the fork writes |
| `L:685-690` | `ReplayVM(suffix, normalizeSnapshotState(...))` | read-only (layer 1) |
| `L:1163-1167` and `:1896-1897` (compact, fork-at) | `normalizeSnapshotState(base.state)` | compaction: rescan before `archiveRemoved`; fork-at: before it writes |
| `blankStream.ts:153, :228, :240, :527` | `normalizeSnapshotState` | read-only (layer 1); identity-free comparison, never drives |
| `compliance/src/eraseSubject.ts:1731` | `normalizeSnapshotState(snapshot.state)` | read-only (layer 1) |
| `replay-inspector/src/reconstruct.ts:173` | `normalizeSnapshotState(snapshot.state)` | read-only (layer 1); cannot import `workflow-runtime` |
| `foldFromCompleteLog` (`W`) | folds the log under the quarantine view | read-only (layer 1); folds from sequence 0, so a stamped run is complete |
| recovery (`recoverAbandoned.ts`, `redriveAbandoned.ts`) and public `loadState` | through `resume` / `foldState` | via those rows |

(The review named a `loadLatestBefore`; the code has no such method. Fork's base is `snapshotStore.loadAt` at
`LogLifecycle.ts:1772` and `plugins/content/src/gc.ts:932`, both covered above; `gc.ts` only reads.)

#### Adoption of an untracked run

With the gate on, a driver site that finds a run with no key (started before the gate or before 1.27) ADOPTS it: it seeds
`_seenOrigins { limits: <current configured limits>, origins: [] }` (no `through`: unproven) and folds the run from sequence 0, ending with `through = state.sequence`. For a run with no snapshot
this is just the ordinary full fold with a seeded key (no extra reads). For a run with a snapshot it is the rescan below.
The limits chosen at adoption are written into the key and persist with it; because a run adopted this way has no
`seenOriginsLimits` on its `EXECUTION_STARTED`, replay of that log WITHOUT a snapshot would fold untracked. That is
acceptable: tracking is a property of the persisted snapshot chain, and an untracked read reports absent or overflow, never a
wrong "clean".

#### Rescan (owner ruling 2: rescan, do not fail closed)

When a driver site must rebuild the key (after its lease, see "Ordering"), the helper folds the history `[0 .. state.sequence]` of the state the vm holds with the scan rules
and replaces the key with the result, `through = state.sequence`; events appended later fold on top as usual.

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
  `SealedStreamUnreadableError` and `SealedPayloadUnreadableError` (the sealed-refusal classes, `isSealedUnreadable`; `QuarantineHeldError` is a subclass), any error
  for which `isPayloadShredded(err)` holds (a shredded subject is a BRAND on the thrown error, `event-runtime/src/payloadShredded.ts`, not a class: there is no
  `PayloadShreddedError`), and "the log is compacted and no archive is configured". Everything else that a read throws and is not in this list is treated as transient. The write-side
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
- **Re-review fixes (R10, Sonnet @285eed05).** (I-1) `through` is compared to `snapshot.state.sequence`, not `snapshot.sequence`, which a batch commit can leave behind on a healthy fleet. (I-2) The O(1) staleness check moves into `normalizeSnapshotState`, so every existing caller (compliance, replay-inspector, `foldFromCompleteLog`, `blankStream`) inherits read-only safety; the helper only rescans and adopts. (I-3) The rescan runs after `takeDriverLease` (resume, flow migration, `restoreFromState`) and before the fence, and compaction rescans before `archiveRemoved` and the truncate; the early seed is read-only. The continueAsNew / fork rule (stamp and `continuedFrom` and no carried set gives overflow) is stated for every seeding point and `carriedOf` carries the marker. Minors: the `restoreFromState` key drop moves to S2b (M-a); the budget paragraph, file list and growth estimate now agree and include `seenOriginsSeed.ts` (M-b); "off" now says a run with no stamp and no carried set folds no key (M-c); the shred error is a brand (`isPayloadShredded`), not a class, and the sealed classes are named (M-d); the carry size is noted (M-e); a read-only site reports an absent key as absent (M-f); the perf requirement covers the copy-on-write cost of `through`.
- **R13 (review of S2a/S2a2, 2026-11-23):** two false negatives of R11 closed. (I-1) the commit walk is over the LIVE structure with classify's `isTainted` predicate and fails closed on what it cannot walk faithfully (the flow receives the live object, not its JSON image); the JSON-view walk is kept for the rescan only. (I-2) "absent means clean" failed open for a 1.26 writer and any unwired commit path: a tracked run now records `origins: []` on every channel event and the fold reads a channel event with no record as overflow; the reopen bootstrap batch is wired. Also: per-event record capped at `maxOrigins`, the `inbox:<topic>` origin capped, a fold-side `through` check, origins stated to be plaintext metadata, and the `restoreFromState` drop of a forged key (M10) must land in S2b BEFORE the gate.
- **R11 (owner, 2026-11-23): scan at commit, record it.** The S2a perf gate measured the fold-time scan at about 290x on a taint-free log of 2000-node outputs (0.8 ms to 225 ms for 3000 events; about 37 ns per node), because today's fold never opens an output. D1 is rewritten: `ExecutionJournal` scans a channel value once when it commits the event, for a tracked run only, and records `metadata.origins` / `metadata.originsOverflow` on the envelope; the fold unions recorded lists and never rescans. The live-vs-replay ordering and JSONB divergence (I6) is moot for 1.27 events; pre-1.27 events are scanned only by the upgrade rescan, which keeps the JSON-view rules. Still EVENT_SCHEMA 1.27.0. The record is in metadata rather than the payload (the positional resume payload is the caller's value), the journal strips caller-supplied keys, and the budget estimate now includes `ExecutionJournal.ts`. Clarified at the same time: the truncation digest is FNV-1a 64 over UTF-8 bytes (16 hex digits); the carried-set shape is `{ origins: string[], overflow?: true }`; the `MESSAGE_CONSUMED` `inbox:<topic>` origin is kept as the kernel's attestation of the channel.
- **Added by the first revision, for owner review:** `through` as a staleness detector (the review asked for the gate; `through` is what makes a gate mistake detectable rather than silent).

## Implementation notes for S2

S2 is probably THREE PRs, each under the 200-line target for its budgeted files, split so each is safe to merge alone (the gate is off until the end):

1. **S2a, the record, the fold and read-only safety.** `replay-vm`: `seenOrigins.ts` (vendored scan, channels, bounds, truncation, the record function, carry/fork seed and the overflow rule), the hook in the fold loop that unions recorded lists and the `EXECUTION_STARTED` seeding, the staleness check in `normalizeSnapshotState`, `EVENT_SCHEMA_VERSION` 1.27.0 and its history comment; `workflow-runtime`: the commit-time record in `ExecutionJournal.ts` (with the strip of caller-supplied keys) and `carriedOf` carrying the set and the marker. Inert: nothing stamps `seenOriginsLimits` yet, so no run is tracked and the commit scan never runs. The perf measurement (fold with records on versus off, and the live commit-scan cost) and the determinism test land here.
2. **S2b, the gate and the context.** `kernel.features.seenOrigins` (`defineConfig`, `WorkflowRuntimeDeps.seenOriginsEnabled`), the `seenOriginsLimits` option with range validation, the stamps at `WorkflowRuntime.ts:~3757` and `~8708`, `EffectContext.seenOrigins` in `WorkflowContext.ts` and `effect-runtime/src/types.ts`, **the `restoreFromState` caller-key drop (M10)**, kernel budget, docs. Untracked snapshots stay absent here (safe).
3. **S2c, adoption and rescan.** `seenOriginsSeed.ts` (with its kernel-budget entry), the post-lease call at each driver site, the compaction ordering, the `compactionArchive` dependency, the error classification, paging, memo, and the rescan tests.

Files: `packages/replay-vm/src/{eventHandlers.ts,foldEvents.ts,seenOrigins.ts}`; `packages/workflow-runtime/src/ExecutionJournal.ts` (the commit-time record, S2a); `packages/core` (state type, if exported); `packages/workflow-runtime/src/{WorkflowContext.ts,WorkflowRuntime.ts,LogLifecycle.ts,continuation.ts,blankStream.ts,seenOriginsSeed.ts,TimerService.ts (S3)}`; `packages/compliance/src/eraseSubject.ts` and `packages/replay-inspector/src/reconstruct.ts` (no change expected: they inherit the staleness check; tests only); `packages/effect-runtime/src/types.ts`; `packages/app/src/defineConfig.ts` plus its config docs and `configGroups` test; `packages/spec/kernel-budget.json`; the EVENT_SCHEMA tables and event docs the spec guards read.

Tests required:
- Determinism (above): the recorded list as the source (live, replay, snapshot plus tail), a commit-time record equal to a rescan of the same event, a key-reordering store for the rescan, and Postgres JSONB when the PG suite runs. A caller-supplied `origins` in metadata or payload never reaches the fold.
- Every channel row, including a non-kernel `MESSAGE_CONSUMED` and a duplicate (both ignored), both resume shapes, and carry / fork / continueAsNew rotation not laundering.
- Presence: a clean run has the key with `origins: []`; a run without `seenOriginsLimits` is untracked and `seenOrigins` is absent; with the gate off nothing is stamped and the folded state equals 1.26.0.
- Bounds: cap overflow, sticky flag, exceeded scan drops partial origins, truncation to `unknown:truncated:<digest>`, recorded limits survive a config change and a snapshot, invalid recorded limits ignored, construction refusals at each range edge; the vendored scan recognises every `tainted()` shape.
- Rolling deploy: a key left stale by a fold that does not advance `through` is detected by `normalizeSnapshotState` (driver rebuilds, read-only reports overflow); a healthy batch-committed snapshot whose `sequence` is below its `state.sequence` is NOT flagged stale.
- Seeding: every site in the table; a read-only site never returns a tail-only set and reports an absent key as absent; the rescan runs after the lease and a stand-down reads nothing; compaction rescans before `archiveRemoved`; `restoreFromState` ignores a forged `_seenOrigins` (S2b); continueAsNew and fork of a keyless predecessor read as overflow.
- Rescan: from retained events; from a compacted log plus archive; each permanent error gives sticky overflow; a simulated timeout gives a retryable failure that persists and memoizes nothing; paged (peak events held is O(page)); the lease is held; the LRU memo.
- **A `*.perf.test.ts` (REQUIREMENT):** (1) the FOLD with records on (a tracked run) against the untracked baseline on (a) a taint-free log with large outputs, (b) a log of many small tainted outputs, (c) cheap events (the copy-on-write `through` advance); it must stay near the baseline, and a material regression on (a) is a defect of the design, not a tuning matter; (2) the LIVE commit-scan cost per node and per event; (3) a rescan of a long history. Report numbers in the PR. Deterministic evidence (nodes visited, bytes recorded) goes in a normal `*.test.ts`, never a timing ratio. The first design's fold-time scan failed (1)(a) by about 290x, which is why R11 exists.
- D2 (task S3): hook absent is byte-identical; principal recorded; throw, reject and timeout each skip with `onError` and do not mis-classify as already-started or retry; `ticking` does not stick; two racing nodes; recovery resumes as the recorded principal; the hook is not called on a resume.
