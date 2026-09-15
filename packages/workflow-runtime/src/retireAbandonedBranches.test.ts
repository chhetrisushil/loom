import { step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryBranchRegistry } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LogLifecycle } from "./LogLifecycle";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { pruneBranchRefs } from "./pruneBranchRefs";
import { retireAbandonedBranches } from "./retireAbandonedBranches";
import type { FlowRunner, RegisteredFlow } from "./types";

// ── A forked parent that retention can never reach ────────────────────────────
//
// `applyRetention` refuses anything non-terminal, and refuses a parent whose child still
// has events. A branch nobody answered is suspended forever — so it is never reclaimed, so
// the parent is never reclaimed either. The chain below is the whole finding.

const inputSchema = z.object({ n: z.number() });
const outputSchema = z.object({ done: z.boolean() });
type In = { n: number };
type Out = { done: boolean };

const afterStep = step$({
  id: "after",
  name: "After",
  toolId: "after-tool",
  inputSchema,
  outputSchema,
});

function makeFlow(flowId: string, runner: FlowRunner<In, Out>): RegisteredFlow<In, Out> {
  const definition: FlowDefinition<In, Out> = {
    _tag: "FlowDefinition",
    id: flowId,
    name: flowId,
    version: "1.0.0",
    inputSchema,
    outputSchema,
    steps: [afterStep],
  };
  return { definition, runner };
}

const gatedFlow = makeFlow("gated", async (ctx, input) => {
  await ctx.suspend({ on: "Approval" });
  return await ctx.run(afterStep, input);
});

function boot() {
  const effects = new EffectRuntime();
  effects.register("after-tool", new ToolEffect(async () => ({ done: true })));
  const eventStore = new InMemoryAsyncEventStore();
  const snapshotStore = new InMemoryAsyncSnapshotStore();
  const branchRegistry = new InMemoryBranchRegistry();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore,
    effectRuntime: effects,
    branchRegistry,
    onWarn: () => {},
  });
  runtime.registerFlow(gatedFlow.definition, gatedFlow.runner);
  const lifecycle = new LogLifecycle(eventStore, snapshotStore, { branchRegistry });
  return { runtime, eventStore, snapshotStore, branchRegistry, lifecycle };
}

/** A terminal parent with one branch forked at its gate, both older than any TTL. */
async function parentWithBranch(app: ReturnType<typeof boot>, ids: [string, string]) {
  const handle = await app.runtime.start(gatedFlow, { n: 1 }, { executionId: ids[0] });
  const parked = await handle.waitForSuspend();
  const fork = await app.runtime.fork(ids[0], parked.sequence, { executionId: ids[1] });
  // Finish the parent so only the branch stands between it and retention.
  await (
    await app.runtime.resume(ids[0], { eventType: "Approval", payload: {} })
  ).waitForCompletion();
  return fork.executionId;
}

const FOREVER = { terminalTtlMs: 0 };

describe("a branch nobody answered blocks its parent forever", () => {
  it("is the defect: the parent is terminal, past TTL, and still not reclaimable", async () => {
    const app = boot();
    await parentWithBranch(app, ["p1", "b1"]);

    expect(await app.lifecycle.applyRetention("p1", FOREVER, Date.now() + 1)).toBe(
      "blocked-by-branch"
    );
    // And the branch itself cannot be reclaimed either — it is suspended, not terminal.
    expect(await app.lifecycle.applyRetention("b1", FOREVER, Date.now() + 1)).toBe("not-terminal");
  });

  it("retiring the branch makes the whole chain collectable, in order", async () => {
    const app = boot();
    await parentWithBranch(app, ["p2", "b2"]);

    const summary = await retireAbandonedBranches(app.runtime, app.branchRegistry, "p2", {
      isAbandoned: (c) => c.suspendedOn === "Approval",
    });
    expect(summary).toMatchObject({ scanned: 1, candidates: 1, retired: 1, failed: 0 });
    expect(summary.remaining).toEqual([]);

    // Retiring does not delete: the branch is terminal, and the fact that it existed — and
    // was abandoned — is in its log.
    const events = await app.eventStore.read("b2");
    expect(events.some((e: EventEnvelope) => e.eventType === "EXECUTION_CANCELLED")).toBe(true);
    expect((await app.runtime.loadState("b2"))?.status).toBe("cancelled");

    // Now ordinary retention can have the branch…
    expect(await app.lifecycle.applyRetention("b2", FOREVER, Date.now() + 1)).toBe("reclaimed");
    // …and only once its events are gone does the parent stop being blocked.
    expect(await app.lifecycle.applyRetention("p2", FOREVER, Date.now() + 1)).toBe("reclaimed");
  });

  it("leaves a branch the predicate does not claim, and reports it as still open", async () => {
    const app = boot();
    await parentWithBranch(app, ["p3", "b3"]);

    const summary = await retireAbandonedBranches(app.runtime, app.branchRegistry, "p3", {
      isAbandoned: () => false,
    });
    expect(summary).toMatchObject({ scanned: 1, candidates: 1, retired: 0 });
    expect(summary.remaining).toHaveLength(1);
    expect(summary.remaining[0]).toMatchObject({ executionId: "b3", suspendedOn: "Approval" });

    expect((await app.runtime.loadState("b3"))?.status).toBe("suspended");
    expect(await app.lifecycle.applyRetention("p3", FOREVER, Date.now() + 1)).toBe(
      "blocked-by-branch"
    );
  });

  it("never offers a terminal branch to the predicate", async () => {
    const app = boot();
    const branchId = await parentWithBranch(app, ["p4", "b4"]);
    await app.runtime.cancel(branchId, "already done");

    const isAbandoned = vi.fn(() => true);
    const summary = await retireAbandonedBranches(app.runtime, app.branchRegistry, "p4", {
      isAbandoned,
    });
    expect(summary).toMatchObject({ scanned: 1, candidates: 0, retired: 0 });
    expect(isAbandoned).not.toHaveBeenCalled();
  });

  it("refuses to run without a predicate — no default is defensible", async () => {
    const app = boot();
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: asserting the runtime guard, not the type
      retireAbandonedBranches(app.runtime, app.branchRegistry, "p5", {} as any)
    ).rejects.toThrow(/isAbandoned` is required/);
  });
});

// ── The registry rows that outlive the executions they describe ───────────────

describe("branch registry rows do not outlive their executions", () => {
  it("forgets the fork edge when retention deletes the branch", async () => {
    const app = boot();
    const branchId = await parentWithBranch(app, ["p6", "b6"]);
    expect(await app.branchRegistry.getLineage(branchId)).not.toBeNull();
    expect(await app.branchRegistry.children("p6")).toHaveLength(1);

    await app.runtime.cancel(branchId, "abandoned");
    expect(await app.lifecycle.applyRetention(branchId, FOREVER, Date.now() + 1)).toBe("reclaimed");

    // The edge described data that no longer exists — and every future sweep would have
    // walked it, so retention would get slower with every fork ever taken.
    expect(await app.branchRegistry.getLineage(branchId)).toBeNull();
    expect(await app.branchRegistry.children("p6")).toEqual([]);
  });

  it("sweeps refs that point at nothing, and reports a dangling `main` rather than deleting it", async () => {
    const app = boot();
    const branchId = await parentWithBranch(app, ["p7", "b7"]);
    const now = Date.now();
    await app.branchRegistry.putRef({
      name: "spec/gone",
      executionId: branchId,
      tip: 1,
      createdAt: now,
      updatedAt: now,
    });
    await app.branchRegistry.putRef({
      name: "spec/live",
      executionId: "p7",
      tip: 1,
      createdAt: now,
      updatedAt: now,
    });
    await app.branchRegistry.putRef({
      name: "main",
      executionId: branchId,
      tip: 1,
      createdAt: now,
      updatedAt: now,
    });

    await app.runtime.cancel(branchId, "abandoned");
    await app.lifecycle.applyRetention(branchId, FOREVER, now + 1);

    const summary = await pruneBranchRefs(app.eventStore, app.branchRegistry);
    expect(summary).toMatchObject({ scanned: 3, dangling: 2, deleted: 1 });
    // `main` dangling is a loud problem; deleting it would turn "main names a ghost" into
    // "there is no main", which is harder to diagnose, not easier.
    expect(summary.protectedDangling).toEqual(["main"]);
    expect(await app.branchRegistry.getRef("spec/gone")).toBeNull();
    expect(await app.branchRegistry.getRef("main")).not.toBeNull();
    // A ref whose execution is alive is untouched.
    expect(await app.branchRegistry.getRef("spec/live")).not.toBeNull();
  });

  it("pages through a registry larger than one page", async () => {
    const app = boot();
    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      await app.branchRegistry.putRef({
        name: `spec/ghost-${String(i).padStart(2, "0")}`,
        executionId: `never-existed-${i}`,
        tip: 0,
        createdAt: now,
        updatedAt: now,
      });
    }
    const summary = await pruneBranchRefs(app.eventStore, app.branchRegistry, { pageSize: 5 });
    expect(summary).toMatchObject({ scanned: 12, dangling: 12, deleted: 12 });
    expect(await app.branchRegistry.listRefs()).toEqual([]);
  });

  it("stops at `limit`, leaving the rest for the next pass", async () => {
    const app = boot();
    const now = Date.now();
    for (let i = 0; i < 6; i++) {
      await app.branchRegistry.putRef({
        name: `spec/g${i}`,
        executionId: `gone-${i}`,
        tip: 0,
        createdAt: now,
        updatedAt: now,
      });
    }
    const summary = await pruneBranchRefs(app.eventStore, app.branchRegistry, { limit: 2 });
    expect(summary.deleted).toBe(2);
    expect(await app.branchRegistry.listRefs()).toHaveLength(4);
  });
});
