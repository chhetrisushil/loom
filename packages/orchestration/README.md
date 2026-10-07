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

## Continue-as-new ([ADR 0109](../../docs/adr/0109-bounded-history-and-continue-as-new.md))

A supervised CHILD may call `ctx.continueAsNew` any number of times: its successor (`<child id>~<n>`) stands
in for it. The supervisor follows `_continuedTo` (live, from the successor's terminal event, and from the
log in `adopt` / `recover`), so the parent resumes with the HEAD's output and a `continued` child is never
mistaken for a result. A PARENT that continues cancels its non-`detached` children when the rotation commits
(reason `{ kind: "cascade", parent }`, the same sweep as a cancel); a `detached` child survives, and its id
may travel in the carry.

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
  under a fence the supervisor takes itself, **only if the park is still unanswered** (R8k,
  [ADR 0118](../../docs/adr/0118-acquire-if-parked-fence.md): `fenceIfParkedAt`, an atomic
  `EventStore.acquireFenceIf`; `TimerService` fences up front, the supervisor only on
  `StaleFenceError`). That closes the two windows an unconditional `acquireFence` left: a rival
  fencing between this supervisor's acquire and append (a clean `stale`, retried on the token the
  store returns), and a rival fencing between its durable `EXECUTION_RESUMED` and the read-back,
  which used to supersede the holder of the already-running parent body (now refused: an answering
  event past the park makes the acquire stale). A resume that keeps losing is a retryable
  `ResumeContendedError`: pass `redrive: app.redrive` (`kernel.features.redrive`) and it becomes a
  backed-off `TimerStore` row that the app's `TimerService` fires, so the parent completes without
  `recover()` (8 attempts, then `onError` once and `recover()`); without it the error goes to
  `onError` and `recover()` retries. A store without `acquireFenceIf` keeps the previous behaviour
  (an unconditional acquire, at most two per resume) and its residual. A live resume refused `not-suspended` is quiet when the
  durable log shows that park already answered. `resumed` counts a resume only once its append is
  durable; a failed append goes to `onError`.
- **Group members on different nodes.** The in-memory `remaining` count is never trusted: when a
  member settles with siblings outstanding, the unsettled siblings are re-read from the log (after
  this member's terminal is durable), so a group whose members settle on different nodes resumes
  its parent from whichever node settles durably last (O(n^2) state reads over a group of n,
  bounded by `limits.maxFanOut`).
- **Retention.** A member whose execution retention already reclaimed (an `EXECUTION_DELETED`
  fact in the lifecycle stream) settles as a typed failure (`reclaimed by retention before its
  result was collected`); it is never re-run. Retention does not CREATE that failure any more: pass
  `durability: { retention: { pinned: pinParkedChildren(() => supervisor) } }` (or `app.supervise(supervisor)`) and
  `LogLifecycle` leaves a finished child its parent is still parked on exactly where it is
  (ADR 0118 D3; the edge is the child's own recorded `parent`). When a terminal event was
  compacted away the fold still gives the outcome, but a failed child's error text and a
  cancelled child's reason are lost.
- **Cancelling a parent cancels its children (ADR 0112 D5).** On a parent's `EXECUTION_CANCELLED` (or
  `EXECUTION_CONTINUED`) the supervisor cancels every child the parent spawned that is still running,
  with reason `{"kind":"cascade","parent":"<id>"}`, transitively; a child never cancels its parent.
  Spawn with `detached: true` (`awaitChild`, or per member of `awaitChildren`) for work that must
  outlive the parent. The live path reads the parent's recorded spawn decisions; `recover()` also
  sweeps orphans (a parent cancelled where no supervisor listened) by each child's RECORDED parent
  and reports them as `RecoverSummary.cascaded`. The sweep scans the child side, so the guarantee is
  that a scheduled `recover()` bounds an orphan's lifetime; it is not a live property.
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

**Clock assumption.** Telling a retention-reclaimed child from a reused id compares the
deletion fact's envelope timestamp with the spawn decision's. Both are wall-clock stamps set by
the appending node, so cross-node clock skew larger than the gap between a deletion and a
re-spawn under the same id can misclassify that child (failed as reclaimed, or re-run). It
matters only when the child's log is absent AND its id was deleted before; keep node clocks
synchronised (NTP) where parent ids are reused.

## Scope

One child (or one group) per suspend/resume cycle (`_resumePayload` is a single slot).
