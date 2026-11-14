# @loomwork/worker-runtime-local — the in-process worker

`LocalWorkerRuntime` is the zero-cloud `WorkerRuntime`: it runs an `ExecutionPackage` on a `WorkflowRuntime`
in this process, which is the same object that holds your registered flows and effects. It is the reference
implementation of the worker SPI. It sits behind a
dispatcher (`LocalDispatcher`, `PlacementDispatcher`) and `@loomwork/plugin-worker-server` can serve any
`WorkerRuntime`, this one included, over HTTP. Most apps do not construct one directly. You do when you are wiring
placement by hand or testing a dispatcher.

```ts
import { LocalDispatcher } from "@loomwork/dispatcher";
import { LocalWorkerRuntime } from "@loomwork/worker-runtime-local";
import { app } from "./config"; // your defineConfig({ storage, flows, ... }) result

const worker = new LocalWorkerRuntime(app.runtime);
const dispatcher = new LocalDispatcher(worker, { maxAttempts: 2, executeTimeoutMs: 30_000 });

const result = await dispatcher.dispatch({
  executionId: "hello-1",
  workflowId: "hello",
  flowId: "hello",
  input: { name: "Ada" },
});
console.log(result.status, result.output); // "completed" { message: "Hello, Ada!" }
```

## Surface

`LocalWorkerRuntime` implements `allocate`, `execute`, `release` and `cancel`, and exposes
`runsAsSystem`. Its one option is `LocalWorkerRuntimeOptions.system`. The contract it implements is in
[`@loomwork/worker-runtime`](../worker-runtime/README.md).

## Behaviour that surprises people

- **One package, three possible actions.** A package with `resumeEvent` resumes. A fresh id with no
  durable events starts. A redispatch of a crashed, still-`running` execution resumes from the latest
  snapshot, so completed steps are not re-run. Recovery of an execution that is already terminal or
  suspended returns the folded state without re-running anything.
- **It returns on suspend as well as completion.** A suspend is a normal result with
  `status: "suspended"`; resume with a new package. A cancelled execution settles as a result, not an
  error.
- **`allocate` takes a driver lease, then a fence.** If another live owner holds the execution,
  `allocate` throws a superseded refusal, not a failed attempt. Where the event store supports fencing,
  only one version of an execution's history can land even under recovery.
- **No system identity by default.** A package carries its `principal`; without one the worker acts as
  nobody. `system` (the runtime's `systemOptions().system`) is an opt-in for a worker that serves the
  kernel's own re-drives, such as a timer dispatcher or `recoverAbandoned`. Do not pass it to a worker
  reachable by user-originated dispatch: every caller it admits would run as the system. A worker built with it
  reports `runsAsSystem`.
- **A `continued` execution reports the chain head.** The result is the head's outcome under the id you
  dispatched, and a chain that cannot be followed is reported as failed rather than guessed at.

## Install

`npm install @loomwork/worker-runtime-local` (or pnpm / yarn). Pre-1.0: every `@loomwork/*` package shares one version, so keep them on the same release.
Inside this repo use `workspace:*`; a sibling checkout links it with a `link:` override (see [AGENTS.md](../../AGENTS.md)).

## See also

- API reference: section "`@loomwork/worker-runtime-local` — the in-process worker" in [docs/api-reference.org](../../docs/api-reference.org).
- Guide: [user guide, section 13: where executions run](../../docs/user-guide.md#13-where-executions-run-compute).
- ADRs: [0001 dispatcher and worker runtime](../../docs/adr/0001-execution-dispatcher-and-worker-runtime.md), [0004 failure recovery](../../docs/adr/0004-failure-recovery.md).
- Source: `packages/worker-runtime-local/src`. Placement in front of it: [`@loomwork/dispatcher`](../dispatcher/README.md).
