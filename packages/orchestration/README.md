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
- **Concurrently.** Several supervisors may recover the same parent: the resume is a single append
  (a lost race is a `DuplicateSequenceError` / `not-suspended` refusal, swallowed, not reported), a
  child start whose id already exists is not an error, and a resume is dropped unless the parent is
  parked on exactly that child/group key (so a late duplicate cannot answer the parent's NEXT
  `awaitChild`). Residual: the sub-millisecond gap between that check and the resume's own fold;
  closing it needs an expected-park argument on `resume` (a kernel change).

Child ids, `maxDepth`/`limits`, and the system grant for starts and resumes behave exactly as live.
Restart policies (retry a failed child) are NOT part of the supervisor: it starts and resumes only.

## Scope

One child (or one group) per suspend/resume cycle (`_resumePayload` is a single slot).
