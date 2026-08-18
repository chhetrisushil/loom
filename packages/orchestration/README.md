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

## Scope

One child per suspend/resume cycle today (`_resumePayload` is a single slot); fan-out over many
children in one suspend is a follow-up. The supervisor correlates in-process; across a restart it
would rebuild its spec map by scanning suspended executions (a follow-up).
