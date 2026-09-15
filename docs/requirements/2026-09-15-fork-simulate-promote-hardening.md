# Fork / Simulate / Promote: Hardening Plan

**Status:** Draft — not scheduled
**Date:** 2026-09-15
**Kernel baseline:** EVENT_SCHEMA 1.18.0, KERNEL_ABI 1.1.0, BRANCH_REGISTRY_SPI 1.0.0, ADRs 0001–0095
**Motivating question:** can branches run in parallel, on different compute layers, and for a long
time — in particular, can each branch carry its own long-running human-in-the-loop task?

---

## 0. Placement verdict (read this first)

The branching seam is four store operations and a pointer move, and that is its strength. Nothing
below grows the syscall surface; the one genuine kernel-adjacent fix is a missing side effect in
`fork()`, not a new primitive.

| Layer | What lands there |
| --- | --- |
| **Kernel-adjacent bug fix** (§3, E1) | `fork()` must re-register the forked gate's durable timer |
| **First-party** (§3, E4–E5) | per-branch placement hint; `head(executionId)` on the EventStore SPI |
| **Application patterns** (§3, E2–E3, E6–E7) | promotion recorded as a decision; cohort close-out; branch TTL; branch-addressed approvals |
| **Rejected** | merge/rebase of divergent executions; a kernel-level "branch manager" subsystem |

`KERNEL_SYSCALLS` unchanged. `EVENT_SCHEMA` unchanged — promotion is recorded through the existing
`ctx.decide` / `DECISION_RECORDED` fact rather than a new governed event type (§3, E2).

---

## 1. What already works, verified

| Claim | Evidence |
| --- | --- |
| A fork of a **suspended** execution is independently resumable | `fork()` copies the prefix verbatim including `EXECUTION_SUSPENDED`, then seeds a snapshot at the fork point — `WorkflowRuntime.ts:1173-1277`; the docstring names the case |
| Branches run **in parallel** | each fork is a distinct `executionId` with its own log and snapshot; resume routes by executionId only. Both shipped examples fan out with `parallelLimit` |
| Branches run on **different compute layers** | the unit crossing the placement boundary is `ExecutionPackage {executionId, flowId, resumeEvent}` — identity + resume coordinates, never live code (`worker-runtime/src/types.ts:16-30`); `LocalWorkerRuntime.ts:91` maps `resumeEvent` → `runtime.resume`, and remote/Cloud Run take the same package. Requires shared stores and, for concurrent drivers, a fencing store (`WorkerLease.fence`, K9.4) |
| The loser stays intact | `BranchRegistry.promote` is a pointer move; the losing execution remains immutable and independently resumable — stated as the design in `BranchRegistry.ts` |

---

## 2. What is missing, verified

**M1 — `fork()` copies the gate but not the alarm.** `timerStore.schedule` is called in exactly one
place, the suspend path of the run loop (`WorkflowRuntime.ts:1552`). `fork()` never touches the
TimerStore. A branch forked at a gate created by `suspend({ timeout })` inherits a log that *records*
`wakeAt` and a deadline that will never fire. Nothing else covers it: `recoverAbandoned` skips
anything not `running`/`pending` (`recoverAbandoned.ts:130`), correctly, since suspension is normal.
The parent times out on schedule; every branch waits forever.

**M2 — promotion is not in the log.** `promote()` moves a ref in the registry. No event is appended
on either execution, so "why B won" lives outside the log that the architecture calls the audit
trail. The examples record it in their own surface state.

**M3 — promote does not close the cohort.** Losing branches stay suspended and resumable, so a late
answer on a loser resumes it and runs its effects for real. The cohort itself is already
derivable — `BranchRegistry.children(parentExecutionId)`.

**M4 — `promote()` is read-then-write.** `PostgresBranchRegistry.ts:106-122` reads the source ref and
writes the target with no compare-and-set. Two concurrent promotes onto `main` silently last-write-win.

**M5 — placement is per flow, not per branch.** `computeTarget` lives on `ExecutionPolicy`
(`core/src/types/execution.ts:134`); sibling branches are the same flow. `DispatchMetadata.target` is
per dispatch and is honoured (`placement.ts:21-25`), but nothing derives it from a branch.

**M6 — `fork()` reads the parent's entire log.** `eventStore.read(parentExecutionId)`
(`WorkflowRuntime.ts:1176`) runs even when the store implements `copyPrefix` and does the copy
natively. Only the tip and `workflowId` are needed; the SPI has no head query.

**M7 — an approval cannot name its branch.** `ResumeEvent` is `{ eventType, payload }`
(`workflow-runtime/src/types.ts:462`), so `ResumeAuthenticator.verify(event)` never sees which
execution it is approving. Evidence minted for one branch is byte-identical for its sibling.

**M8 — no branch lifecycle.** `listRefs()` has no pagination, lineage rows are permanent, and there
is no TTL or quota. A system that forks routinely grows both without bound.

**M9 — storage is a physical prefix copy.** N branches cost N x the prefix. Deliberate (it buys a
byte-identical fold) but it is the cost model to state, not a defect.

**M10 — the shipped examples cannot host a suspending branch.** `BranchOrchestrator.explore` awaits
`resumed.waitForCompletion()` inside `parallelLimit`
(`loom-examples/.../incident-war-room/src/branching/BranchOrchestrator.ts:125`). The suspend path
never resolves the completion promise — `WorkflowRuntime.ts:1491` is the only `resolveCompletion` —
so the first branch that parks on a human hangs the whole fan-out. Neither branching example has a
`suspend()` inside a branch.

---

## 3. Work items

### E1 — `fork()` re-registers the branch's timer *(1P, `workflow-runtime`)* — **SHIPPED**

Fixes M1. After the seed snapshot, `fork()` schedules the child's wake when the fork state is
suspended with a `wakeAt`.

**The proposed `{ deadline: "inherit" | "restart" }` option was dropped, and the reason is the
interesting part.** `TimerService.fire` wakes an execution only when
`state.suspendedOn.wakeAt === timer.wakeAt` (exact equality), and the copied prefix is
byte-identical by design — so a re-based deadline would be a timer that can never match its own
log, and rebasing it "properly" would mean rewriting a copied event and giving up prefix
identity. There is therefore no option: **a branch inherits the recorded deadline.** A branch
that wants its own resumes the gate and suspends again with a fresh `timeout`, which is a fact
it appends rather than one it inherits. This is a better outcome than the API this plan
proposed — one behaviour, no flag, and the semantics follow from an invariant already pinned.

*Shipped with six tests* (`packages/workflow-runtime/src/fork-timers.test.ts`), three of which
fail without the change: the branch gets its own row, the branch actually wakes on its deadline,
and the row carries the recorded `wakeAt` rather than a fresh one. The other three pin what must
NOT happen — no timer for an untimed gate, none for a fork before the gate, and byte-identical
behaviour with no `TimerStore` wired.

### E2 — promotion recorded as a decision *(app pattern first)*

Fixes M2. Do **not** add a `BRANCH_PROMOTED` event type. Promotion is a decision: record it with
`ctx.decide` on the promoting execution, carrying the candidate set and the reason. That puts it in
the log, replays deterministically, and — if the choice is ever policy-driven — carries propensity
for free (`@loom/learning`). Prove it in an example before considering any 1P surface.

### E3 — promote closes the cohort *(app helper)*

Fixes M3. A `promoteAndClose(winner)` helper: resolve the cohort via `children()`, `cancel()` each
loser, close its external task, return what was retracted. Per ADR 0083 this starts as app code; it
earns a 1P home only when a second unrelated consumer appears. Note the interaction with effects: in
the shipped demos branches are safe because they resume with `simulate: true`; a branch that ran real
effects before parking makes "losing" non-free, which is compensation territory (`@loom/saga`), not
pointer-move promote.

### E4 — per-branch placement *(1P)*

Fixes M5. Record an optional placement hint on the branch ref at `fork()` time and derive
`DispatchMetadata.target` from it, so "simulate the expensive branch on Cloud Run, the cheap one
in-process" is declarative rather than hand-wired at each dispatch.

### E5 — `head(executionId)` on the EventStore SPI *(1P, perf)*

Fixes M6. Turns `fork()` from O(parent log) into O(1) + `copyPrefix`. Additive optional method with a
`readFrom`-based fallback, a conformance case, and a bench line. Measurable on the existing harness.

### E6 — branch lifecycle *(app/1P)*

Fixes M8 and M4. A TTL sweep for abandoned branches, a cursor on `listRefs`, and a compare-and-set
`promote` (expected current executionId) so a concurrent promotion is a refusal rather than a silent
overwrite.

### E7 — branch-addressed approvals *(app, forced by the kernel shape)*

Fixes M7. The branch id goes in the resume payload and is **required** by the flow's `resumeSchemas`,
because the authenticator cannot see the address it is being applied to. Pair with a per-branch
external task created *after* the fork — a human task minted before the fork can only name the parent.

### E8 — an example that hosts a gate inside a branch *(loom-examples)* — **SHIPPED**

Fixes M10 (loom-examples #41). `incident-war-room`'s `explore()` now returns while every branch
is suspended, and reviews arrive independently. Building it settled three things the plan left
open:

- **E7 landed with it.** The branch id rides in the review payload, is required by
  `resumeSchemas`, and is checked by the runner — which **re-parks** on a mismatch rather than
  failing the execution. Ignoring a mis-addressed approval is the right behaviour: the branch
  still needs its own answer.
- **E3 landed with it, and changed shape.** Gating promotion on the *whole* cohort being
  answered makes the slowest reviewer the critical path for an incident fix. The first branch
  cleared can win, and promotion cancels the siblings still parked.
- **E2 landed with it, as an app pattern.** The committing execution records the promotion with
  `ctx.decide` — candidate set and reason. It needs no 1P surface, which is the outcome ADR 0083
  predicts: one consumer is a pattern, not a package.

The example also became **E1's first consumer** by wiring a `SqliteTimerStore`, so the forked
gate's deadline is live rather than hypothetical.

---

## 4. Suggested order

1. ~~**E1**~~ — **shipped**; the `restart` option it proposed turned out to be unimplementable.
2. ~~**E8**~~ — **shipped**; it decided E2/E3's shape and carried E7 in with it.
3. ~~**E7**, **E2**~~ — **shipped inside E8** as app patterns; neither needs a 1P surface yet.
4. **E6** (and the rest of **E3**: a compare-and-set `promote`) — lifecycle, now that a real cohort exists.
5. **E4**, **E5** — placement and cost, independent of the others.

## 5. Not doing

- **Merge / rebase of branches.** Two divergent `ExecutionState`s have no principled join; the
  registry says so and should keep saying so.
- **A kernel branch-manager subsystem.** Everything above is reachable with the existing syscalls; a
  branching subsystem in the kernel fails both the placement bias (P10) and the second-consumer rule.
- **Copy-on-write prefixes.** M9 is a stated cost, not a defect, and changing it would trade the
  byte-identical-fold guarantee for storage that is not currently a reported problem.
