import type { ExecutionResult } from "@loom/worker-runtime";
import { describe, expect, it, vi } from "vitest";
import { RemoteWorkerRuntime } from "./RemoteWorkerRuntime";

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

const result: ExecutionResult = {
  executionId: "e1",
  status: "completed",
  lastSequence: 2,
  output: { ok: true },
  state: {
    executionId: "e1",
    workflowId: "wf",
    workflowVersion: "1.0.0",
    status: "completed",
    frames: {},
    variables: { _output: { ok: true } },
    sequence: 2,
    startedAt: 0,
    updatedAt: 0,
  },
};

describe("RemoteWorkerRuntime", () => {
  it("POSTs the package to {baseUrl}/execute and returns the parsed result", async () => {
    const fetchImpl = vi.fn(async () => okResponse(result));
    const worker = new RemoteWorkerRuntime("http://worker.local/", { fetchImpl });

    const lease = await worker.allocate({ executionId: "e1" });
    const got = await worker.execute(lease, {
      executionId: "e1",
      workflowId: "wf",
      flowId: "wf",
      input: { a: 1 },
    });

    expect(got.status).toBe("completed");
    expect(got.output).toEqual({ ok: true });
    // trailing slash normalized; body wraps the package.
    expect(fetchImpl).toHaveBeenCalledWith("http://worker.local/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        executionPackage: { executionId: "e1", workflowId: "wf", flowId: "wf", input: { a: 1 } },
      }),
    });
  });

  it("throws with status + body when the worker responds non-2xx", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "boom",
      json: async () => ({}),
    }));
    const worker = new RemoteWorkerRuntime("http://worker.local", { fetchImpl });
    const lease = await worker.allocate({ executionId: "e1" });

    await expect(
      worker.execute(lease, { executionId: "e1", workflowId: "wf", flowId: "wf", input: {} })
    ).rejects.toThrow(/500 boom/);
  });

  // K8.5 — cross-seam cancel delivery is best-effort by contract: it reports
  // whether the remote performed a cancellation, and NEVER throws (the caller's
  // durable settlement doesn't depend on delivery).
  describe("cancel (K8.5)", () => {
    it("POSTs to {baseUrl}/cancel and returns the worker's verdict", async () => {
      const fetchImpl = vi.fn(async () => okResponse({ cancelled: true }));
      const worker = new RemoteWorkerRuntime("http://worker.local", { fetchImpl });

      await expect(worker.cancel("e1", "operator kill")).resolves.toBe(true);
      expect(fetchImpl).toHaveBeenCalledWith("http://worker.local/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ executionId: "e1", reason: "operator kill" }),
      });
    });

    it("returns false on a worker without cancel support (501)", async () => {
      const fetchImpl = vi.fn(async () => ({
        ok: false,
        status: 501,
        text: async () => "worker does not support cancel",
        json: async () => ({}),
      }));
      const worker = new RemoteWorkerRuntime("http://worker.local", { fetchImpl });
      await expect(worker.cancel("e1")).resolves.toBe(false);
    });

    it("returns false when the worker is unreachable — never throws", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      });
      const worker = new RemoteWorkerRuntime("http://worker.local", { fetchImpl });
      await expect(worker.cancel("e1")).resolves.toBe(false);
    });
  });
});
