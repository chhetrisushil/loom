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

## Scope

One child per suspend/resume cycle today (`_resumePayload` is a single slot); fan-out over many
children in one suspend is a follow-up. The supervisor correlates in-process; across a restart it
would rebuild its spec map by scanning suspended executions (a follow-up).
