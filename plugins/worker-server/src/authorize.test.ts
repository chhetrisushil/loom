import type {
  ExecutionPackage,
  ExecutionResult,
  WorkerLease,
  WorkerRequest,
  WorkerRuntime,
} from "@loom/worker-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { type WorkerServer, createWorkerServer } from "./createWorkerServer";

// A trivial worker — the gate is what's under test, not execution.
const fakeWorker: WorkerRuntime = {
  async allocate(r: WorkerRequest): Promise<WorkerLease> {
    return { leaseId: `l-${r.executionId}` };
  },
  async execute(_l: WorkerLease, p: ExecutionPackage): Promise<ExecutionResult> {
    return {
      executionId: p.executionId,
      status: "completed",
      // biome-ignore lint/suspicious/noExplicitAny: minimal state stand-in for the gate test
      state: {} as any,
      lastSequence: 0,
    };
  },
  async release(): Promise<void> {},
};

const pkg = { executionId: "e", workflowId: "w", flowId: "w" };

describe("worker server authorize gate", () => {
  let server: WorkerServer;
  afterEach(async () => {
    await server.stop();
  });

  it("401s the mutating routes when authorize returns false; /health stays open", async () => {
    server = createWorkerServer(fakeWorker, { authorize: () => false });
    await server.start();
    const exec = await fetch(`${server.url}/execute`, {
      method: "POST",
      body: JSON.stringify({ executionPackage: pkg }),
    });
    expect(exec.status).toBe(401);
    const health = await fetch(`${server.url}/health`);
    expect(health.status).toBe(200);
  });

  it("passes through when authorize returns true", async () => {
    server = createWorkerServer(fakeWorker, { authorize: () => true });
    await server.start();
    const exec = await fetch(`${server.url}/execute`, {
      method: "POST",
      body: JSON.stringify({ executionPackage: pkg }),
    });
    expect(exec.status).toBe(200);
  });
});
