import { describe, expect, it } from "vitest";
import type { ExecutionPackage, ExecutionResult, WorkerRuntime } from "./index";

// This package is the SPI — pure types. These tests lock the transport contract
// so accidental shape changes (which would break every WorkerRuntime impl and
// the /execute wire format) fail loudly.

describe("ExecutionPackage contract", () => {
  it("accepts a fresh-start shape (input, no resumeEvent)", () => {
    const pkg: ExecutionPackage = {
      executionId: "e1",
      workflowId: "wf",
      flowId: "wf",
      input: { incidentId: "i1" },
    };
    expect(pkg.resumeEvent).toBeUndefined();
    expect(pkg.flowId).toBe("wf");
  });

  it("accepts a resume shape (resumeEvent, no input)", () => {
    const pkg: ExecutionPackage = {
      executionId: "e1",
      workflowId: "wf",
      flowId: "wf",
      resumeEvent: { eventType: "ApprovalGranted", payload: { approved: true } },
    };
    expect(pkg.resumeEvent?.eventType).toBe("ApprovalGranted");
  });
});

describe("ExecutionResult contract", () => {
  it("carries outcome + folded state + last persisted sequence", () => {
    const result: ExecutionResult = {
      executionId: "e1",
      status: "suspended",
      lastSequence: 5,
      state: {
        executionId: "e1",
        workflowId: "wf",
        workflowVersion: "1.0.0",
        status: "suspended",
        frames: {},
        variables: {},
        sequence: 5,
        startedAt: 0,
        updatedAt: 0,
      },
    };
    expect(result.status).toBe("suspended");
    expect(result.lastSequence).toBe(5);
  });
});

describe("WorkerRuntime SPI surface", () => {
  it("a minimal in-memory impl satisfies the interface", async () => {
    const worker: WorkerRuntime = {
      async allocate(request) {
        return { leaseId: `lease-${request.executionId}` };
      },
      async execute(_lease, pkg) {
        return {
          executionId: pkg.executionId,
          status: "completed",
          lastSequence: 0,
          state: {
            executionId: pkg.executionId,
            workflowId: pkg.workflowId,
            workflowVersion: "1.0.0",
            status: "completed",
            frames: {},
            variables: {},
            sequence: 0,
            startedAt: 0,
            updatedAt: 0,
          },
        };
      },
      async release() {},
    };

    const lease = await worker.allocate({ executionId: "e1" });
    const result = await worker.execute(lease, {
      executionId: "e1",
      workflowId: "wf",
      flowId: "wf",
      input: {},
    });
    await worker.release(lease);
    expect(result.status).toBe("completed");
    expect(lease.leaseId).toBe("lease-e1");
  });
});
