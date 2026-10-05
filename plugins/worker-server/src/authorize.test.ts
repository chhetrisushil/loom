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

// R3 round 1 (P1-1) — a worker that runs as the system, and the package principal on the wire.
describe("worker server and the system identity", () => {
  let server: WorkerServer | undefined;
  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it("refuses to be built around a worker that runs as the system without an authorize gate", () => {
    const sys: WorkerRuntime = { ...fakeWorker, runsAsSystem: true };
    expect(() => createWorkerServer(sys)).toThrow(/SYSTEM identity/);
    expect(() => createWorkerServer(sys, { authorize: () => true })).not.toThrow();
  });

  const seen: Array<{ allocate?: unknown; execute?: unknown }> = [];
  const spy: WorkerRuntime = {
    async allocate(r) {
      seen.push({ allocate: r.principal });
      return { leaseId: "l" };
    },
    async execute(_l, p) {
      seen.push({ execute: p.principal });
      return {
        executionId: p.executionId,
        status: "completed",
        state: {} as never,
        lastSequence: 0,
      };
    },
    async release() {},
  };
  const post = (url: string, principal: unknown) =>
    fetch(`${url}/execute`, {
      method: "POST",
      body: JSON.stringify({ executionPackage: { ...pkg, principal } }),
    });

  it("drops the package principal when the server cannot authenticate the dispatcher", async () => {
    seen.length = 0;
    server = createWorkerServer(spy);
    await server.start();
    expect((await post(server.url, { actor: "alice" })).status).toBe(200);
    expect(seen).toEqual([{ allocate: undefined }, { execute: undefined }]);
  });

  it("forwards the package principal to allocate and execute once authorize passes, and rejects a non-object one", async () => {
    seen.length = 0;
    server = createWorkerServer(spy, { authorize: () => true });
    await server.start();
    expect((await post(server.url, { actor: "alice", tenant: "t1" })).status).toBe(200);
    expect(seen).toEqual([
      { allocate: { actor: "alice", tenant: "t1" } },
      { execute: { actor: "alice", tenant: "t1" } },
    ]);
    expect((await post(server.url, "alice")).status).toBe(400);
  });
});
