# @loomwork/dispatcher — placement

The dispatcher decides where an execution runs and owns the allocate, execute, release cycle around a
[`WorkerRuntime`](../worker-runtime/README.md): worker allocation, retries, a per-attempt timeout, and
result collection. It sits between whatever starts executions (the A2A bus, `executeGraph`, timers) and a
worker, so moving an execution off-box is a change of worker, not of caller. It ships three composable
dispatchers. Most apps do not touch this package: the default is in-process. You use it to place work on
named targets (local, HTTP, Cloud Run), to add restart and circuit-breaking, or to write your own
dispatcher.

```ts
import {
  LocalDispatcher,
  PlacementDispatcher,
  SupervisingDispatcher,
  defaultPlacementPolicy,
} from "@loomwork/dispatcher";
import { LocalWorkerRuntime } from "@loomwork/worker-runtime-local";
import { app } from "./config"; // your defineConfig({ storage, flows, ... }) result

const local = new LocalDispatcher(new LocalWorkerRuntime(app.runtime), { maxAttempts: 2 });

// Named targets; `meta.target` picks one, anything else falls to `default`.
const placement = new PlacementDispatcher({
  targets: { local, sized: local /* e.g. a LocalDispatcher over a RemoteWorkerRuntime */ },
  default: "local",
  policy: defaultPlacementPolicy("local"),
  onWarn: (message) => console.warn(message),
});

// Restart a throwing dispatch twice with backoff, and open a circuit after 5 straight failures.
const dispatcher = new SupervisingDispatcher(placement, {
  policy: { maxRestarts: 2, backoffMs: 200, circuit: { threshold: 5, cooldownMs: 30_000 } },
});

const result = await dispatcher.dispatch(
  { executionId: "hello-2", workflowId: "hello", flowId: "hello", input: { name: "Grace" } },
  { target: "sized", priority: 1 }
);
console.log(result.status, await dispatcher.health());
```

## Surface

- **Contract.** `ExecutionDispatcher` (`dispatch`, `cancel`, `health`), `DispatchMetadata` (`lane`,
  `priority`, `estimatedCpu`, `estimatedMemory`, `estimatedDuration`, `target`), `DispatcherHealth`,
  `PlacementPolicy`, and `DISPATCHER_SPI_VERSION` (1.2.0). `ExecutionPackage`, `ExecutionResult` and
  `ExecutionOutcome` are re-exported from `@loomwork/worker-runtime`.
- **`LocalDispatcher(worker, { maxAttempts, executeTimeoutMs })`.** One worker: allocate, execute, release.
- **`PlacementDispatcher({ targets, default, policy?, onWarn? })`.** Routes each dispatch to a named
  target dispatcher. `defaultPlacementPolicy` honours `meta.target` when it is registered;
  `dispatchMetadataFromPolicy` maps a flow's `ExecutionPolicy` (compute target, priority, resources,
  affinity) onto `DispatchMetadata`.
- **`SupervisingDispatcher(child, { policy })`.** Restart with backoff (`maxRestarts`, `backoffMs`,
  `backoffFactor`) and a circuit breaker (`CircuitPolicy`), failing fast with `CircuitOpenError`.
- **Wiring.** `defineConfig({ execution: { dispatcher } })` supplies the placement dispatcher for the A2A
  bus; the default is in-process.

## Behaviour that surprises people

- **A failed flow is not a failed dispatch.** `maxAttempts` and `maxRestarts` apply when the worker or
  transport throws or an attempt times out, not when the flow returns `status: "failed"`. `maxAttempts`
  defaults to 1 and `maxRestarts` to 0.
- **A superseded refusal is never retried.** If another holder owns the execution, the dispatcher
  rethrows at once, `SupervisingDispatcher` neither restarts nor counts it against the circuit, and
  `executeGraph` rejects its join on it. Await that execution by id instead.
- **An unknown target falls back to `default`, with a warning.** It is warned once per name (the default
  sink is `console.warn`), because a placement hint can outlive the target it names.
- **The circuit key defaults to the flow id**, so the breaker is per flow unless you pass `key`.
- **`cancel` goes to the target the execution was routed to**, or to every target when that is no longer
  remembered; a stray cancel on a finished execution is ignored.
- **`executeTimeoutMs` abandons the wait, not necessarily the worker.** A hung instance may keep running,
  which is why redispatch relies on fencing in the store.

## Install

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override (see [AGENTS.md](../../AGENTS.md)).

## See also

- API reference: section "`@loomwork/dispatcher` — placement" in [docs/api-reference.org](../../docs/api-reference.org), which still quotes `DISPATCHER_SPI_VERSION` as 1.1.0.
- Guides: [user guide, section 13: where executions run](../../docs/user-guide.md#13-where-executions-run-compute), [scaling](../../docs/scaling.md).
- ADRs: [0001 dispatcher and worker runtime](../../docs/adr/0001-execution-dispatcher-and-worker-runtime.md), [0004 failure recovery](../../docs/adr/0004-failure-recovery.md), [0033 SPI conformance](../../docs/adr/0033-spi-conformance-contracts.md).
- Source: `packages/dispatcher/src`; `runExecutionDispatcherConformance` in `@loomwork/conformance` proves a dispatcher.
