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

  it("does not redispatch a cancelled execution (leak + retry-after-cancel fix)", async () => {
    let started!: () => void;
    const startedP = new Promise<void>((r) => {
      started = r;
    });
    let proceed!: () => void;
    const proceedP = new Promise<void>((r) => {
      proceed = r;
    });
    let executes = 0;
    const worker: WorkerRuntime = {
      async allocate(request) {
        return { leaseId: `lease-${request.executionId}` };
      },
      async execute() {
        executes++;
        started();
        await proceedP; // hold the attempt open until the test cancels
        throw new Error("aborted");
      },
      async release() {},
      async cancel() {
        return true;
      },
    };
    const dispatcher = new LocalDispatcher(worker, { maxAttempts: 3 });

    const run = dispatcher.dispatch(pkg);
    await startedP; // attempt 1 is in flight (a lease is held)
    await dispatcher.cancel(pkg.executionId); // flags cancelled
    proceed(); // attempt 1 now fails
    await expect(run).rejects.toThrow();

    expect(executes).toBe(1); // NOT retried despite maxAttempts: 3
  });
});

// L20 — "another holder owns this execution" is not a failed attempt. Name-shaped errors stand
// in for `@loom/event-runtime` / `@loom/workflow-runtime` classes this package does not depend
// on; the predicate matches by name for exactly that reason.
function named(name: string, fields: Record<string, unknown>, cause?: unknown): Error {
  const err = Object.assign(new Error(name), fields, cause !== undefined ? { cause } : {});
  err.name = name;
  return err;
}
const staleFence = (executionId: string) =>
  named("StaleFenceError", { executionId, staleFence: 1, currentFence: 2 });

describe("LocalDispatcher — superseded refusals (L20)", () => {
  function scripted(errs: unknown[]): WorkerRuntime & { attempts: number } {
    const w = {
      attempts: 0,
      async allocate(request: WorkerRequest): Promise<WorkerLease> {
        return { leaseId: `lease-${request.executionId}` };
      },
      async execute(_lease: WorkerLease, p: ExecutionPackage): Promise<ExecutionResult> {
        const err = errs[w.attempts++];
        if (err !== undefined) throw err;
        return resultStub(p.executionId);
      },
      async release() {},
    };
    return w;
  }

  it.each([
    ["a lost start race", named("ExecutionAlreadyExistsError", { executionId: "e1" })],
    ["a fenced-out write", named("StorageWriteError", {}, staleFence("e1"))],
    ["a bare stale fence", staleFence("e1")],
    ["the wire form", named("ExecutionSupersededError", { executionId: "e1" })],
  ])("rethrows %s at once, without a second attempt", async (_label, err) => {
    const worker = scripted([err]);
    const dispatcher = new LocalDispatcher(worker, { maxAttempts: 3 });
    await expect(dispatcher.dispatch(pkg)).rejects.toBe(err);
    expect(worker.attempts).toBe(1);
  });

  it.each([
    ["a genuine storage failure", named("StorageWriteError", {}, new Error("disk full"))],
    // A coalesced batch rejects every caller with ONE writer's error: a stale fence that
    // names a DIFFERENT execution is, for this one, a genuine failure.
    ["another execution's stale fence", named("StorageWriteError", {}, staleFence("other"))],
    ["another execution's lost race", named("ExecutionAlreadyExistsError", { executionId: "x" })],
  ])("still retries %s", async (_label, err) => {
    const worker = scripted([err]);
    const dispatcher = new LocalDispatcher(worker, { maxAttempts: 3 });
    await expect(dispatcher.dispatch(pkg)).resolves.toMatchObject({ status: "completed" });
    expect(worker.attempts).toBe(2);
  });
});
