# @loomwork/worker-runtime — the worker SPI

The contract for running one execution on some compute placement: `WorkerRuntime` (`allocate`, `execute`,
`release`, optional `cancel`) and the JSON `ExecutionPackage` that crosses the boundary. A package carries
identity and resume coordinates (`executionId`, `workflowId`, `flowId`, `input` or a `resumeEvent`),
never code: the worker resolves the flow by id from the code it booted with and rebuilds state from the
shared event and snapshot stores. This is infrastructure. An app does not normally import it; you read it
when you write a worker backend or a dispatcher. A [`@loomwork/dispatcher`](../dispatcher/README.md) sits in
front of a worker and owns retries and placement.

Implementations: `LocalWorkerRuntime` ([`@loomwork/worker-runtime-local`](../worker-runtime-local/README.md),
in-process), `RemoteWorkerRuntime` (`@loomwork/plugin-worker-remote`, HTTP to a `@loomwork/plugin-worker-server`
endpoint) and `CloudRunWorkerRuntime` (`@loomwork/plugin-cloudrun`).

```ts
import {
  isSupersededRefusal,
  type ExecutionPackage,
  type ExecutionResult,
  type WorkerRuntime,
} from "@loomwork/worker-runtime";

// What a dispatcher does around any WorkerRuntime: lease, execute, always release.
export async function dispatchOnce(
  worker: WorkerRuntime,
  pkg: ExecutionPackage
): Promise<ExecutionResult | "superseded"> {
  const lease = await worker.allocate({ executionId: pkg.executionId });
  try {
    return await worker.execute(lease, pkg);
  } catch (err) {
    // Another holder owns this execution: settled, not failed. Do not retry it.
    if (isSupersededRefusal(err, pkg.executionId)) return "superseded";
    throw err;
  } finally {
    await worker.release(lease);
  }
}
```

## Surface

- **Interface.** `WorkerRuntime`, `WorkerRequest`, `WorkerLease` (`leaseId`, optional fencing token
  `fence`, `metadata`).
- **Payloads.** `ExecutionPackage` (a fresh start sets `input`; a resume sets `resumeEvent`; optional
  `snapshotId`, `fromSequence`, `metadata`, `principal`), `ExecutionResult` (`status`, folded `state`,
  `output`, `error`, `suspendedOn`, `lastSequence`) and `ExecutionOutcome`
  (`"completed" | "suspended" | "failed"`).
- **Superseded refusals.** `isSupersededRefusal(err, executionId)` and `ExecutionSupersededError`, its
  wire form.

## Behaviour that surprises people

- **A suspend is a normal result.** `execute` runs to suspend-or-complete and returns
  `status: "suspended"`; the caller resumes with a fresh package carrying `resumeEvent`.
- **Superseded is not failed.** `isSupersededRefusal` is true for a lost start race, a lost or held
  lease, a stale fence or `ExecutionSupersededError`, each only when it names this execution. A
  dispatcher must not retry it: every attempt takes a newer fence, so a retry would fence the winner out
  and the two would ping-pong. It transfers ownership without checking the new holder is alive, so run
  `recoverAbandoned`, and await the outcome by id.
- **`principal` crosses the wire as plain data.** A receiving worker should honour it only from a caller
  it has authenticated; `runsAsSystem` marks a worker that runs principal-less packages as the kernel's
  system identity, which a network transport refuses to expose without an authentication gate.
- **`cancel` is best effort.** Durable cancellation settles through the shared store and does not depend
  on this call reaching the worker.

## Install

`npm install @loomwork/worker-runtime` (or pnpm / yarn). Pre-1.0: every `@loomwork/*` package shares one version, so keep them on the same release.
Inside this repo use `workspace:*`; a sibling checkout links it with a `link:` override (see [AGENTS.md](../../AGENTS.md)).

## See also

- API reference: section "`@loomwork/worker-runtime` — the SPI" in [docs/api-reference.org](../../docs/api-reference.org).
- Guide: [user guide, section 13: where executions run](../../docs/user-guide.md#13-where-executions-run-compute); `runWorkerRuntimeConformance` in `@loomwork/conformance` proves an implementation.
- ADRs: [0001 dispatcher and worker runtime](../../docs/adr/0001-execution-dispatcher-and-worker-runtime.md), [0002 HTTP worker](../../docs/adr/0002-http-worker-and-remote-worker-runtime.md), [0003 Cloud Run](../../docs/adr/0003-cloud-run-worker-runtime.md), [0004 failure recovery](../../docs/adr/0004-failure-recovery.md).
- Source: `packages/worker-runtime/src`.
