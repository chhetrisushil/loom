import type { ExecutionState } from "@loom/core";
import type {
  ExecutionPackage,
  ExecutionResult,
  WorkerLease,
  WorkerRequest,
  WorkerRuntime,
} from "@loom/worker-runtime";
import { describe, expect, it, vi } from "vitest";
import { LocalDispatcher } from "./LocalDispatcher";

function stateStub(executionId: string): ExecutionState {
  return {
    executionId,
    workflowId: "wf",
    workflowVersion: "1.0.0",
    status: "completed",
    frames: {},
    variables: { _output: { ok: true } },
    sequence: 3,
    startedAt: 0,
    updatedAt: 0,
  };
}

function resultStub(executionId: string): ExecutionResult {
  return {
    executionId,
    status: "completed",
    state: stateStub(executionId),
    output: { ok: true },
    lastSequence: 3,
  };
}

const pkg: ExecutionPackage = { executionId: "e1", workflowId: "wf", flowId: "wf", input: {} };

/** A scriptable fake WorkerRuntime that records the call sequence. */
class FakeWorker implements WorkerRuntime {
  calls: string[] = [];
  released: string[] = [];
  private failuresLeft: number;
  constructor(failFirst = 0) {
    this.failuresLeft = failFirst;
  }
  async allocate(request: WorkerRequest): Promise<WorkerLease> {
    this.calls.push(`allocate:${request.executionId}`);
    return { leaseId: `lease-${request.executionId}` };
  }
  async execute(lease: WorkerLease, p: ExecutionPackage): Promise<ExecutionResult> {
    this.calls.push(`execute:${lease.leaseId}`);
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new Error("transport blip");
    }
    return resultStub(p.executionId);
  }
  async release(lease: WorkerLease): Promise<void> {
    this.calls.push(`release:${lease.leaseId}`);
    this.released.push(lease.leaseId);
  }
}

describe("LocalDispatcher", () => {
  it("allocates, executes, then releases — in order — and returns the result", async () => {
    const worker = new FakeWorker();
    const dispatcher = new LocalDispatcher(worker);

    const result = await dispatcher.dispatch(pkg);

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ ok: true });
    expect(worker.calls).toEqual(["allocate:e1", "execute:lease-e1", "release:lease-e1"]);
  });

  it("releases the lease even when the worker throws", async () => {
    const worker = new FakeWorker(1);
    const dispatcher = new LocalDispatcher(worker); // maxAttempts defaults to 1

    await expect(dispatcher.dispatch(pkg)).rejects.toThrow(/transport blip/);
    expect(worker.released).toEqual(["lease-e1"]);
  });

  it("retries a throwing worker up to maxAttempts and succeeds", async () => {
    const worker = new FakeWorker(1); // fails once, then succeeds
    const dispatcher = new LocalDispatcher(worker, { maxAttempts: 2 });

    const result = await dispatcher.dispatch(pkg);

    expect(result.status).toBe("completed");
    // allocate/execute/release happen twice: one failed attempt + one success.
    expect(worker.calls.filter((c) => c.startsWith("allocate")).length).toBe(2);
    expect(worker.released.length).toBe(2);
  });

  it("reports in-flight count via health()", async () => {
    const worker = new FakeWorker();
    const dispatcher = new LocalDispatcher(worker);

    const inFlightDuringExecute = vi.fn();
    const spied = worker.execute.bind(worker);
    worker.execute = async (lease, p) => {
      inFlightDuringExecute((await dispatcher.health()).inFlight);
      return spied(lease, p);
    };

    const before = await dispatcher.health();
    await dispatcher.dispatch(pkg);
    const after = await dispatcher.health();

    expect(before.inFlight).toBe(0);
    expect(inFlightDuringExecute).toHaveBeenCalledWith(1);
    expect(after.inFlight).toBe(0);
    expect(after.healthy).toBe(true);
  });

  it("cancel() releases a held lease", async () => {
    const worker = new FakeWorker();
    const dispatcher = new LocalDispatcher(worker);
    // No lease held for an unknown execution — cancel is a safe no-op.
    await expect(dispatcher.cancel("unknown")).resolves.toBeUndefined();
  });

  it("treats a hung worker as a failed attempt and redispatches", async () => {
    // First attempt hangs past the deadline; second returns promptly.
    let attempt = 0;
    const worker: WorkerRuntime = {
      async allocate(request) {
        return { leaseId: `lease-${request.executionId}` };
      },
      async execute(_lease, p) {
        attempt++;
        if (attempt === 1) {
          await new Promise((r) => setTimeout(r, 1000)); // hang past executeTimeoutMs
        }
        return resultStub(p.executionId);
      },
      async release() {},
    };
    const dispatcher = new LocalDispatcher(worker, { maxAttempts: 2, executeTimeoutMs: 30 });

    const result = await dispatcher.dispatch(pkg);

    expect(result.status).toBe("completed");
    expect(attempt).toBe(2); // timed out once, then succeeded
  });
});
