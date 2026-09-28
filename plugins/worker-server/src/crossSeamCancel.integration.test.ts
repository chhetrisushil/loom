import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { step$ } from "@loom/core";
import type { EventEnvelope } from "@loom/core";
import { LocalDispatcher } from "@loom/dispatcher";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import { SqliteEventStore, SqliteSnapshotStore } from "@loom/plugin-sqlite";

import { RemoteWorkerRuntime } from "@loom/plugin-worker-remote";
import type { ExecutionResult, WorkerRuntime } from "@loom/worker-runtime";
import { LocalWorkerRuntime } from "@loom/worker-runtime-local";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createWorkerServer } from "./createWorkerServer";
import type { WorkerServer } from "./createWorkerServer";

// ── K8.5 — cross-seam cancellation ────────────────────────────────────────────
//
// The acceptance scenario: an execution runs an in-flight effect on a REMOTE
// HTTP worker; cancelling from the orchestrator side severs it promptly, the
// durable log records EXECUTION_CANCELLED, and the pending dispatch settles as
// a normal terminal result (never a retryable transport error — redispatching
// a cancelled execution would be wrong).

const inputSchema = z.object({ n: z.number() });
const outputSchema = z.object({ done: z.boolean() });

const hangStep = step$({
  id: "hang",
  name: "Hang",
  toolId: "hang-tool",
  inputSchema,
  outputSchema,
});

const FLOW = "remote-hang";
const runner: FlowRunner<{ n: number }, { done: boolean }> = async (ctx, input) =>
  ctx.run(hangStep, input);

const flow = {
  definition: {
    _tag: "FlowDefinition",
    id: FLOW,
    name: FLOW,
    version: "1.0.0",
    inputSchema,
    outputSchema,
    steps: [hangStep],
  },
  runner,
} as RegisteredFlow<{ n: number }, { done: boolean }>;

describe("cross-seam cancellation (orchestrator → HTTP worker, K8.5)", () => {
  let dbDir: string;
  let runtime: WorkflowRuntime;
  let eventStore: SqliteEventStore;
  let server: WorkerServer;
  let remote: RemoteWorkerRuntime;
  // Barriers on the effect itself (L18): `entered` resolves when the hang tool is running on the
  // worker — the moment the cancel must reach — and `severed` when the abort arrives inside it.
  // They replace a poll of the store that gave up silently after ~2 s and a wall-clock bound
  // that a saturated host exceeded with nothing wrong.
  let entered: Map<string, Promise<void>>;
  let severed: Set<string>;
  let markEntered: Map<string, () => void>;
  const enteredFor = (executionId: string): Promise<void> => {
    let p = entered.get(executionId);
    if (p === undefined) {
      p = new Promise<void>((resolve) => markEntered.set(executionId, resolve));
      entered.set(executionId, p);
    }
    return p;
  };

  beforeEach(async () => {
    dbDir = mkdtempSync(join(tmpdir(), "loom-xseam-"));
    entered = new Map();
    severed = new Set();
    markEntered = new Map();
    const effectRuntime = new EffectRuntime();
    effectRuntime.register(
      "hang-tool",
      new ToolEffect((_i: unknown, ctx: EffectContext) => {
        const running = new Promise((_, reject) => {
          ctx.signal?.addEventListener(
            "abort",
            () => {
              severed.add(ctx.executionId);
              reject(ctx.signal?.reason ?? new Error("aborted"));
            },
            { once: true }
          );
        });
        void enteredFor(ctx.executionId);
        markEntered.get(ctx.executionId)?.();
        return running;
      })
    );

    eventStore = new SqliteEventStore(join(dbDir, "events.db"));
    runtime = new WorkflowRuntime({
      eventStore,
      snapshotStore: new SqliteSnapshotStore(join(dbDir, "snapshots.db")),
      effectRuntime,
    });
    runtime.registerFlow(flow.definition, runner);

    server = createWorkerServer(new LocalWorkerRuntime(runtime));
    await server.start();
    remote = new RemoteWorkerRuntime(server.url);
  });

  afterEach(async () => {
    await server.stop();
    rmSync(dbDir, { recursive: true, force: true });
  });

  /**
   * Poll until `pred` holds. Unbounded on purpose: the test's timeout is the hang detector, so a
   * condition that never holds FAILS rather than falling through to the assertions after it (the
   * previous helper stopped after 400 tries and returned as if it had seen the condition).
   */
  async function until(pred: () => Promise<boolean>): Promise<void> {
    while (!(await pred())) await new Promise((r) => setTimeout(r, 5));
  }

  it("cancelling on the orchestrator severs the in-flight effect on the remote worker", async () => {
    const lease = await remote.allocate({ executionId: "xc-1" });
    const pending = remote.execute(lease, {
      executionId: "xc-1",
      workflowId: FLOW,
      flowId: FLOW,
      input: { n: 1 },
    });

    // The effect is in flight on the worker.
    await enteredFor("xc-1");
    expect(severed.has("xc-1")).toBe(false);

    await expect(remote.cancel("xc-1", "operator kill")).resolves.toBe(true);

    // The pending dispatch settles as a normal terminal result — a cancelled
    // execution is an outcome, not a transport failure to redispatch. The tool
    // never settles on its own, so this settling at all is the cancel severing it
    // (and the abort is observed INSIDE the effect, not merely on the durable log).
    const result: ExecutionResult = await pending;
    expect(severed.has("xc-1")).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.state.status).toBe("cancelled");

    // Durable-fact settlement on the shared store. A live cancel rejects the caller
    // at once and drains EXECUTION_CANCELLED behind it, so this is eventual.
    await until(async () => (await runtime.loadState("xc-1"))?.status === "cancelled");
    const events = await eventStore.read("xc-1");
    expect(events.some((e: EventEnvelope) => e.eventType === "EXECUTION_CANCELLED")).toBe(true);
    expect(events.some((e: EventEnvelope) => e.eventType === "STEP_CANCELLED")).toBe(true);
  });

  it("dispatcher.cancel() reaches the remote worker through the placement seam", async () => {
    const dispatcher = new LocalDispatcher(remote);
    const pending = dispatcher.dispatch({
      executionId: "xc-2",
      workflowId: FLOW,
      flowId: FLOW,
      input: { n: 2 },
    });

    await enteredFor("xc-2");

    await dispatcher.cancel("xc-2");

    const result = await pending;
    expect(severed.has("xc-2")).toBe(true);
    expect(result.state.status).toBe("cancelled");
    await until(async () => (await runtime.loadState("xc-2"))?.status === "cancelled");
  });

  it("cancel of an execution unknown to the worker returns false (best-effort contract)", async () => {
    await expect(remote.cancel("never-existed")).resolves.toBe(false);
  });

  it("a worker without cancel support answers 501 → client reports false, never throws", async () => {
    const bare: WorkerRuntime = {
      allocate: async (req) => ({ leaseId: `bare-${req.executionId}` }),
      execute: async () => {
        throw new Error("unused");
      },
      release: async () => {},
    };
    const bareServer = createWorkerServer(bare);
    await bareServer.start();
    try {
      const client = new RemoteWorkerRuntime(bareServer.url);
      await expect(client.cancel("anything")).resolves.toBe(false);
    } finally {
      await bareServer.stop();
    }
  });
});
