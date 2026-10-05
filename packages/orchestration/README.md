# @loom/orchestration — spawn a child workflow and await its result

Cross-execution await without a new syscall. A parent flow spawns a child workflow and durably waits
for its result; a supervisor correlates the child's completion back to the parent. Built from
`decide` + `suspend` + `resume` — no ABI or event-schema change (P10). See
[ADR 0040](../../docs/adr/0040-live-query-and-orchestration.md).

```ts
import { awaitChild, superviseChildren } from "@loom/orchestration";

// Parent flow: spawn "child" and await its output.
const parentRunner = async (ctx, input) => {
  const result = await awaitChild(ctx, { key: "c1", flowId: "child", input: { n: input.n } });
  return { fromChild: result.v };
};

// Wire the supervisor into the runtime so it can start children + resume parents.
let supervisor;
const runtime = new WorkflowRuntime({ /* … */, onEvent: (e) => supervisor?.onEvent(e) });
supervisor = superviseChildren({ runtime, flows: { child: childFlow } });
```

## How it works

1. `awaitChild` fixes the child id (`<parentId>::<key>`) + spec with `ctx.decide` (replay-safe: a
   re-run never starts a second child), then `suspend({ on: "CHILD_DONE", correlationKey: childId })`.
2. The supervisor learns the spec from the parent's `DECISION_RECORDED`, starts the child when it
   sees the parent's `EXECUTION_SUSPENDED`, and on the child's `EXECUTION_COMPLETED` resumes the
   parent with the child's output — all correlated from observed events (no store read → no race).

## Attenuated authority (K12.4)

A spawned child does not inherit its parent's authority — it starts with no principal, so it is
authorized by its own flow's grants. To confer **less** than that, name the subset on the spawn and
give the supervisor a signing secret:

```ts
await awaitChild(ctx, { key: "worker", flowId: "child", input, grants: ["read-rows"] });

supervisor = superviseChildren({ runtime, flows, delegation: { secret: process.env.DELEGATION_SECRET } });
```

The supervisor mints a `DelegatedGrant` bound to the child's own execution id and starts it holding
that token; a `DelegationAuthorizer` at the callee allows only the **intersection** of the delegated
set and the child's own grants. Nothing narrows unless both halves are wired (G2).

The signed token is minted at start and **never written to the log** — the spawn decision records
only the subset (plain effect ids), because an append-only, archived log is the wrong place for a
bearer credential. `expiresAt`, if given, is absolute, so a re-mint after recovery is identical.

## Restart safety (R8)

The supervisor keeps no state that the log cannot rebuild. A fresh runtime + a fresh supervisor
over the SAME stores (a process restart, or a second node) picks up where the last one stopped:

- **Lazily.** A child terminal event the supervisor never saw spawned makes it re-derive the
  parent's park from the log: the parent's fold (parked on `CHILD_DONE`, on which key), the spawn
  `DECISION_RECORDED` for that key (spec / group members), and each awaited child's state and
  terminal event. A group's settled results come from the children's logs, not from memory, so a
  group with 2 of 3 settled before the crash still delivers all three.
- **At boot.** `await supervisor.recover()` scans the store for parents parked on `CHILD_DONE`
  and resumes the ones whose children all settled while nothing was supervising, starts children
  the log recorded but nobody started, and adopts the rest. Idempotent; run it again whenever you
  like as a sweeper (a child driven by ANOTHER node's runtime is only seen by that node's
  `onEvent`, so a periodic `recover()` is what covers a node that died with it).
  **Cost:** one `listExecutionsPage` scan plus one fold per execution (O(store) time, O(page)
  memory); there is no index of parked parents to ask instead. The lazy path costs one parent fold
  per unrecognised child terminal event. Both need nothing from the store beyond what `EventStore`
  already has (`listExecutions*` is optional; without it use the lazy path or pass `source`).
- **Concurrently.** Several supervisors may recover the same parent, and none can answer the
  wrong park: `awaitChild`/`awaitChildren` suspend with `viewDigest: <child/group key>` (R13) and the
  supervisor's resume echoes it, so the runtime refuses a stale resume BEFORE the append
  (`view-digest-mismatch`) and the journal's CAS on `(executionId, sequence)` rejects a duplicate;
  both are swallowed, not reported. A child start whose id already exists is not an error. A
  resume that loses the append race still runs the parent body in memory, so a child is started
  only once the parent is DURABLY parked on that exact key, and what is started comes from the
  durable spawn decision, never from the in-memory one. A parent that was ever fenced is resumed
  under a fresh fence the supervisor acquires itself (`TimerService` fences up front; the
  supervisor only on `StaleFenceError`). **Residual, kernel follow-up:** `acquireFence` is not
  conditional on the parent still being parked, so a rival supervisor fencing between this one's
  acquire and append makes the resume fail stale, and one fencing between its durable resume and
  its read-back supersedes the holder of the already-running parent body. Acquisitions are
  therefore bounded to two per resume, the park is re-read before each, and a resume still stale
  after that goes to `onError` (`recover()` retries it). The fix is an "acquire-if-parked" fence
  SPI, for the Wave 2 kernel design. A live resume refused `not-suspended` is quiet when the
  durable log shows that park already answered. `resumed` counts a resume only once its append is
  durable; a failed append goes to `onError`.
- **Group members on different nodes.** The in-memory `remaining` count is never trusted: when a
  member settles with siblings outstanding, the unsettled siblings are re-read from the log (after
  this member's terminal is durable), so a group whose members settle on different nodes resumes
  its parent from whichever node settles durably last (O(n^2) state reads over a group of n,
  bounded by `limits.maxFanOut`).
- **Retention.** A member whose execution retention already reclaimed (an `EXECUTION_DELETED`
  fact in the lifecycle stream) settles as a typed failure (`reclaimed by retention before its
  result was collected`); it is never re-run. Open follow-up (not in this package): `LogLifecycle`
  should refuse to delete a child whose parent is still parked on it. When a terminal event was
  compacted away the fold still gives the outcome, but a failed child's error text and a
  cancelled child's reason are lost.
- **A slow store is retried, never silently abandoned.** The live path waits ~1s for the parent's
  park to become durable. If it is still unreadable (a slow store), the supervisor backs off
  exponentially and `adopt`s the parent from the log, for as long as it is non-terminal; only
  after 10 minutes is the give-up reported through `onError` (a park that stays on a different key
  is a losing resume's phantom and stops quietly). A resume whose outcome cannot be observed
  (hung store) is "unknown": not counted as resumed, retried the same way. `recover()` is opt-in
  and is NOT needed for this: the live path heals a slow store by itself; `recover()` is for a
  node that restarted or died.
- **Leaving no state behind.** A park answered ELSEWHERE (another node resumed the parent) never
  delivers its terminal event here, so a periodic sweep (every 30s while anything is held) and
  every adoption / `recover()` re-check the log and drop what is held for answered or terminated
  parks. The retention-deletion facts are held in a bounded map (50 000; an eviction makes a miss
  rescan the lifecycle stream, so it costs time, never correctness), keyed by id and judged
  against when the spawn was decided, so a REUSED parent id is not failed by its previous
  incarnation's deletion. `size()` reports all of it.
- **Scope of `recover()`.** It scans whatever the store enumerates, ACROSS TENANTS unless the store
  is tenant-scoped; use a tenant-scoped store or `source` to confine a pass. The supervisor drops
  its per-park state (specs, started, groups, member index) when the park is answered here or
  elsewhere (see above).

Child ids, `maxDepth`/`limits`, and the system grant for starts and resumes behave exactly as live.
Restart policies (retry a failed child) are NOT part of the supervisor: it starts and resumes only.

## Scope

One child (or one group) per suspend/resume cycle (`_resumePayload` is a single slot).
