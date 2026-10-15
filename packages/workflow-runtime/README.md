# @loom/workflow-runtime

The durable execution engine. `WorkflowRuntime` (also exported as `ExecutionRuntime`) runs a flow's
runner function against an append-only event log: every step, effect and decision is recorded, so
an execution can suspend at a durable checkpoint, resume after a restart, replay deterministically,
fork into branches, and be re-driven when its driver dies. It also owns heartbeat leases, durable
timers, the per-execution inbox, continue-as-new chains, approvals and the sealed-payload guard.

## When to use it

You rarely construct it yourself: [`defineConfig`](../app/README.md) builds one and hands it back as
`app.runtime`. Import from this package for the runner types (`FlowRunner`, `RegisteredFlow`,
`WorkflowContext`), the typed errors (`FlowDivergenceError`, `ResumeContendedError`,
`ExecutionAlreadyExistsError`, ...), and the operational helpers (`recoverAbandoned`,
`orphanCensus`, `reconcileTimers`, `answerApproval`, `parseCron`). Build a `WorkflowRuntime`
directly (`new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime, ... })`) only for
infrastructure or tests that need a different composition.

## Install

Not published to npm yet: use `"@loom/workflow-runtime": "workspace:*"` inside this repo, or a
`link:` override from a sibling checkout (see [AGENTS.md](../../AGENTS.md)).

## Entry points

- `@loom/workflow-runtime` - the runtime, runner types, errors and operational helpers.
- `@loom/workflow-runtime/operator` - operator-only vocabulary (today `sealedDetailOf`,
  `SealedDetail`), deliberately not re-exported from the main index.

## Example

A flow that parks on a human decision and is resumed later (the process could restart in between):

```ts
import { z } from "zod";
import { flow$, handler$, step$ } from "@loom/core";
import { defineConfig } from "@loom/app";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";

const Decision = z.object({ approved: z.boolean(), approvedBy: z.string() });
type Decision = z.infer<typeof Decision>;

const applyStep = step$({
  id: "apply",
  name: "Apply",
  inputSchema: z.object({ target: z.string() }),
  outputSchema: z.object({ applied: z.boolean() }),
  handler: handler$(async (_input: { target: string }) => ({ applied: true })),
});

const runner: FlowRunner<{ target: string }, { applied: boolean }> = async (ctx, input) => {
  const decision = await ctx.suspend<Decision>({
    on: "ApprovalGranted",
    correlationKey: input.target,
    timeout: 24 * 60 * 60 * 1000,
  });
  if (!decision.approved) return { applied: false };
  return ctx.run(applyStep, { target: input.target });
};

const approveFlow: RegisteredFlow = {
  definition: flow$({
    id: "approve",
    name: "Approve",
    version: "1.0.0",
    inputSchema: z.object({ target: z.string() }),
    outputSchema: z.object({ applied: z.boolean() }),
    steps: [applyStep],
    resumeSchemas: { ApprovalGranted: Decision }, // parsed before it is appended (ADR 0077)
  }),
  runner: runner as FlowRunner<unknown, unknown>,
};

const app = defineConfig({ storage: { kind: "memory" }, flows: [approveFlow] });
const handle = await app.runtime.start(approveFlow, { target: "prod-db" });
await handle.waitForSuspend(); // status "suspended"; state lives in the log
const resumed = await app.runtime.resume(handle.executionId, {
  eventType: "ApprovalGranted",
  payload: { approved: true, approvedBy: "ada" },
});
console.log((await resumed.waitForCompletion()).status); // "completed"
await app.close();
```

## Key concepts

- **Replay, not checkpoint-by-hand.** On resume the runner re-runs from the top; recorded steps are
  served from the log. Code in a runner must therefore be deterministic: see
  [user guide section 14](../../docs/user-guide.md#14-determinism-rules--pitfalls).
- **Suspend and resume.** `ctx.suspend` parks; `runtime.resume` delivers a payload, validated against
  `resumeSchemas` ([ADR 0077](../../docs/adr/0077-typed-resume-payloads.md)).
- **Fork / simulate / promote** use a `BranchRegistry`:
  [user guide section 5](../../docs/user-guide.md#5-branching-fork--simulate--promote).
- **Driver liveness.** Heartbeat leases and `recoverAbandoned` re-drive executions whose process
  died: [operations.md sections 2 and 3](../../docs/operations.md#2-heartbeat-leases),
  [ADR 0130](../../docs/adr/0130-sealed-payload-delivery-guard.md).
- **Storage** is pluggable behind the `EventStore` and `SnapshotStore` SPIs
  ([`@loom/event-runtime`](../event-runtime/README.md)).

## See also

- [API reference: WorkflowRuntime](../../docs/api-reference.org) (`@loom/workflow-runtime`).
- [User guide, section 4: Suspend and resume](../../docs/user-guide.md#4-suspend--resume).
- [Architecture](../../docs/architecture.md), [getting started](../../docs/getting-started.md).
- [`@loom/core`](../core/README.md), [`@loom/app`](../app/README.md).
