import type { ExecutionDispatcher } from "@loom/dispatcher";
import { createWorkerServer } from "@loom/plugin-worker-server";
import type { WorkerServer } from "@loom/plugin-worker-server";
import { LocalWorkerRuntime } from "@loom/worker-runtime-local";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CloudRunSink,
  cloudRunDispatcher,
  inProcessDispatcher,
  newCloudRunSink,
  remoteDispatcher,
} from "../src/backends";
import type { RebuildOutput } from "../src/flow";
import { buildWorkerRuntime } from "../src/worker";

let server: WorkerServer;
let backends: Array<[string, ExecutionDispatcher]>;
let remote: ExecutionDispatcher;
let cloudRun: ExecutionDispatcher;
let sink: CloudRunSink;

beforeAll(async () => {
  const runtime = buildWorkerRuntime();
  server = createWorkerServer(new LocalWorkerRuntime(runtime), { port: 0 });
  await server.start();
  sink = newCloudRunSink();
  remote = remoteDispatcher(server.url);
  cloudRun = cloudRunDispatcher(server.url, sink);
  backends = [
    ["in-process", inProcessDispatcher(runtime)],
    ["remote-http", remote],
    ["cloud-run", cloudRun],
  ];
});

afterAll(async () => {
  await server.stop();
});

describe("compute pluggability", () => {
  it("runs the same flow with equivalent results on in-process, remote HTTP, and Cloud Run", async () => {
    const outputs: RebuildOutput[] = [];
    for (const [name, dispatcher] of backends) {
      const result = await dispatcher.dispatch({
        executionId: `rebuild-${name}`,
        workflowId: "rebuild-index",
        flowId: "rebuild-index",
        input: { table: "orders" },
      });
      expect(result.status).toBe("completed");
      outputs.push(result.output as RebuildOutput);
    }
    // Same input ⇒ identical business output on every backend (executionId aside).
    const first = outputs[0];
    expect(first).toBeDefined();
    for (const out of outputs) {
      expect(out.bloatPct).toBe(first?.bloatPct);
      expect(out.reclaimedMb).toBe(first?.reclaimedMb);
      expect(out.rebuilt).toBe(true);
    }
  });

  it("resumes a suspended execution across backends (suspend on remote, resume on Cloud Run)", async () => {
    const executionId = "gated-cross-backend";
    const suspended = await remote.dispatch({
      executionId,
      workflowId: "rebuild-index-gated",
      flowId: "rebuild-index-gated",
      input: { table: "sessions" },
    });
    expect(suspended.status).toBe("suspended");

    const resumed = await cloudRun.dispatch({
      executionId,
      workflowId: "rebuild-index-gated",
      flowId: "rebuild-index-gated",
      resumeEvent: {
        eventType: "ApprovalGranted",
        payload: { approved: true, approvedBy: "alice" },
      },
    });
    expect(resumed.status).toBe("completed");
    expect((resumed.output as RebuildOutput).approvedBy).toBe("alice");
    expect((resumed.output as RebuildOutput).rebuilt).toBe(true);
  });

  it("resolves an endpoint and sizes the machine on the Cloud Run path", async () => {
    await cloudRun.dispatch(
      {
        executionId: "sized-1",
        workflowId: "rebuild-index",
        flowId: "rebuild-index",
        input: { table: "audit_log" },
      },
      { lane: "heavy" }
    );
    // The platform was asked to allocate (resolve an endpoint)…
    expect(sink.logs.length).toBeGreaterThan(0);
    // …and the "heavy" lane produced a larger machine than the default.
    const heavy = sink.sizings.at(-1);
    expect(heavy?.cpu).toBeGreaterThanOrEqual(4);
  });
});
