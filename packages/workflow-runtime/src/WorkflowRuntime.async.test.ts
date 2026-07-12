import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageWriteError, step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { SqliteBranchRegistry } from "@loom/plugin-sqlite";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner, RegisteredFlow } from "./types";

// A genuinely async backend (real Promises + injectable latency/failure) exercises
// the write pipeline, ordering, drain barriers, and the durable-write failure path
// that a synchronous store never could.

const inputSchema = z.object({ id: z.string() });
const outputSchema = z.object({ done: z.boolean() });

const stepA = step$({
  id: "step-a",
  name: "A",
  toolId: "tool-a",
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ a: z.number() }),
});
const stepB = step$({
  id: "step-b",
  name: "B",
  toolId: "tool-b",
  inputSchema: z.object({ a: z.number() }),
  outputSchema: z.object({ b: z.number() }),
});

// Fetch A + B, suspend for approval, then finish — a suspend point to fork/resume at.
const runner: FlowRunner<{ id: string }, { done: boolean }> = async (ctx, input) => {
  const a = (await ctx.run(stepA, { id: input.id })) as { a: number };
  await ctx.run(stepB, { a: a.a });
  await ctx.suspend({ on: "Approved", correlationKey: input.id });
  return { done: true };
};

function makeFlow(): RegisteredFlow<{ id: string }, { done: boolean }> {
  return {
    definition: {
      _tag: "FlowDefinition",
      id: "async-flow",
      name: "Async Flow",
      version: "1.0.0",
      inputSchema,
      outputSchema,
      steps: [stepA, stepB],
    },
    runner,
  };
}

let dbDir: string;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "loom-async-test-"));
});
afterEach(() => {
  rmSync(dbDir, { recursive: true, force: true });
});

function makeRuntime(opts?: {
  failAppendWhen?: (e: import("@loom/core").EventEnvelope) => boolean;
  onStorageError?: (id: string, err: unknown) => void;
  latencyMs?: number;
}) {
  const eventStore = new InMemoryAsyncEventStore({
    latencyMs: opts?.latencyMs ?? 1,
    ...(opts?.failAppendWhen && { failAppendWhen: opts.failAppendWhen }),
  });
  const snapshotStore = new InMemoryAsyncSnapshotStore({ latencyMs: opts?.latencyMs ?? 1 });
  const branchRegistry = new SqliteBranchRegistry(join(dbDir, "branches.db"));
  const effectRuntime = new EffectRuntime();
  effectRuntime.register("tool-a", new ToolEffect(async () => ({ a: 1 })));
  effectRuntime.register("tool-b", new ToolEffect(async () => ({ b: 2 })));
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore,
    effectRuntime,
    branchRegistry,
    ...(opts?.onStorageError && { onStorageError: opts.onStorageError }),
  });
  runtime.registerFlow(makeFlow().definition, runner);
  return { runtime, eventStore, snapshotStore, branchRegistry };
}

describe("WorkflowRuntime on an async backend", () => {
  it("runs the full start → suspend → resume lifecycle", async () => {
    const { runtime } = makeRuntime();
    const handle = await runtime.start(makeFlow(), { id: "x1" });
    const suspended = await handle.waitForSuspend();
    expect(suspended.status).toBe("suspended");

    const final = await (
      await runtime.resume(handle.executionId, { eventType: "Approved", payload: { ok: true } })
    ).waitForCompletion();
    expect(final.status).toBe("completed");
  });

  it("drains durably before suspend: every event ≤ suspend + the snapshot are persisted", async () => {
    const { runtime, eventStore, snapshotStore } = makeRuntime();
    const handle = await runtime.start(makeFlow(), { id: "x2" });
    const suspended = await handle.waitForSuspend();

    // The async store already holds everything up to and including the suspend.
    const events = await eventStore.read(handle.executionId);
    expect(events.map((e) => e.sequence)).toEqual(
      Array.from({ length: suspended.sequence + 1 }, (_, i) => i)
    );
    expect(events.at(-1)?.eventType).toBe("EXECUTION_SUSPENDED");
    // ...and the snapshot references a sequence that is present in the log.
    const snap = await snapshotStore.loadLatest(handle.executionId);
    expect(snap?.sequence).toBe(suspended.sequence);
  });

  it("forks and resumes a branch on the async backend, parent intact", async () => {
    const { runtime, eventStore } = makeRuntime();
    const handle = await runtime.start(makeFlow(), { id: "x3" });
    const suspended = await handle.waitForSuspend();
    const before = await eventStore.read(handle.executionId);

    const branch = await runtime.fork(handle.executionId, suspended.sequence, {
      branchName: "spec/alt",
    });
    const final = await (
      await runtime.resume(branch.executionId, { eventType: "Approved", payload: {} })
    ).waitForCompletion();

    expect(final.status).toBe("completed");
    expect(await eventStore.read(handle.executionId)).toEqual(before); // parent untouched
  });

  it("surfaces a durable-write failure via StorageWriteError + onStorageError, without fabricating EXECUTION_FAILED", async () => {
    const onStorageError = vi.fn();
    // Fail when persisting the first step's completion, mid-run.
    const { runtime, eventStore } = makeRuntime({
      failAppendWhen: (e) => e.eventType === "STEP_COMPLETED",
      onStorageError,
    });

    const handle = await runtime.start(makeFlow(), { id: "x4" });
    await expect(handle.waitForCompletion()).rejects.toBeInstanceOf(StorageWriteError);
    expect(onStorageError).toHaveBeenCalledTimes(1);

    // No fabricated terminal event was written to the (partial) log.
    const events = await eventStore.read(handle.executionId);
    expect(events.map((e) => e.eventType)).not.toContain("EXECUTION_FAILED");
  });
});
