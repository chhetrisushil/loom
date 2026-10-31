import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryLeaseStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime, type WorkflowRuntimeDeps } from "./WorkflowRuntime";
import { until } from "./__tests__/r2Harness";
import type { FlowRunner, RegisteredFlow } from "./types";

// Issue #712 - a cancel that arrives once a terminal event is COMMITTED must behave like `cancel()`
// on an execution that is already terminal on disk: write nothing, return false. No sleeps: the
// cancel is injected from inside the event store's append, at the exact seam between the terminal's
// durable commit and the live handle's removal.

const io = { inputSchema: z.any(), outputSchema: z.any() };
function flow(id: string, runner: FlowRunner<unknown, unknown>): RegisteredFlow<unknown, unknown> {
  const definition = {
    _tag: "FlowDefinition",
    id,
    name: id,
    version: "1.0.0",
    ...io,
    steps: [],
  } as unknown as FlowDefinition<unknown, unknown>;
  return { definition, runner };
}

/** Runs `after` once, right after the first append of `eventType` is durable (before append returns). */
class HookedStore extends InMemoryAsyncEventStore {
  after: { eventType: string; run: (e: EventEnvelope) => Promise<void> } | undefined;
  private async fire(e: EventEnvelope): Promise<void> {
    const hook = this.after;
    if (hook === undefined || hook.eventType !== e.eventType) return;
    this.after = undefined;
    await hook.run(e);
  }
  override async append(e: EventEnvelope) {
    await super.append(e);
    await this.fire(e);
  }
  override async appendBatch(es: EventEnvelope[]) {
    await super.appendBatch(es);
    for (const e of es) await this.fire(e);
  }
}

const kinds = async (store: InMemoryAsyncEventStore, id: string): Promise<string[]> =>
  (await store.read(id)).map((e) => e.eventType).filter((k) => k.startsWith("EXECUTION_"));

function rig(deps: Partial<WorkflowRuntimeDeps> = {}) {
  const eventStore = new HookedStore();
  const rt = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
    ...deps,
  });
  return { rt, eventStore };
}

describe("#712 - a log already holding CANCELLED after COMPLETED (written by the old bug)", () => {
  it("folds without throwing and keeps the completed output", async () => {
    const { rt, eventStore } = rig();
    const f = flow("legacy", async () => ({ ok: true }));
    const handle = await rt.start(f, {}, { executionId: "l-1" });
    await handle.waitForCompletion();
    const log = await eventStore.read("l-1");
    const last = log[log.length - 1] as EventEnvelope;
    await eventStore.append({
      ...last,
      id: "l-1-legacy-cancel",
      eventType: "EXECUTION_CANCELLED",
      sequence: last.sequence + 1,
      payload: { reason: "late" },
    });
    const state = await rt.loadState("l-1");
    // The fold is last-terminal-wins by log order (unchanged: EVENT_SCHEMA is untouched): the status
    // follows the later event, but the completed output is never lost and nothing throws.
    expect(state?.status).toBe("cancelled");
    expect(state?.variables._output).toEqual({ ok: true });
  });
});

describe("#712 - cancel after a committed terminal", () => {
  it("completed: a cancel landing in the completion drain writes nothing and returns false", async () => {
    const { rt, eventStore } = rig();
    const f = flow("done", async () => ({ ok: true }));
    let verdict: boolean | undefined;
    eventStore.after = {
      eventType: "EXECUTION_COMPLETED",
      run: async (e) => {
        verdict = await rt.cancel(e.executionId, "late");
      },
    };
    const handle = await rt.start(f, {}, { executionId: "c-1" });
    const state = await handle.waitForCompletion(); // resolves, never rejects
    expect(state.status).toBe("completed");
    expect(verdict).toBe(false);
    expect(await kinds(eventStore, "c-1")).toEqual(["EXECUTION_STARTED", "EXECUTION_COMPLETED"]);
    // the live path agrees with the durable one
    expect(await rt.cancel("c-1")).toBe(false);
    expect((await rt.loadState("c-1"))?.status).toBe("completed");
  });

  it("completed: handle.cancel() itself is a no-op once the terminal is committed", async () => {
    const { rt, eventStore } = rig();
    const f = flow("done2", async () => 1);
    const holder: { handle?: Awaited<ReturnType<typeof rt.start>> } = {};
    eventStore.after = {
      eventType: "EXECUTION_COMPLETED",
      run: async () => {
        holder.handle?.cancel("late");
      },
    };
    const handle = await rt.start(f, {}, { executionId: "c-2" });
    holder.handle = handle;
    expect((await handle.waitForCompletion()).status).toBe("completed");
    expect(await kinds(eventStore, "c-2")).toEqual(["EXECUTION_STARTED", "EXECUTION_COMPLETED"]);
  });

  it("failed: a cancel landing in the failure drain writes nothing and the run stays failed", async () => {
    const { rt, eventStore } = rig();
    const f = flow("boom", async () => {
      throw new Error("boom");
    });
    let verdict: boolean | undefined;
    eventStore.after = {
      eventType: "EXECUTION_FAILED",
      run: async (e) => {
        verdict = await rt.cancel(e.executionId);
      },
    };
    const handle = await rt.start(f, {}, { executionId: "f-1" });
    await expect(handle.waitForCompletion()).rejects.toThrow("boom");
    expect(verdict).toBe(false);
    expect(await kinds(eventStore, "f-1")).toEqual(["EXECUTION_STARTED", "EXECUTION_FAILED"]);
  });

  it("continue-as-new: a cancel after EXECUTION_CONTINUED does not append to the predecessor", async () => {
    const { rt, eventStore } = rig({ continueAsNewEnabled: true });
    const f = flow("rot", async (ctx, input) => {
      if ((input as { n: number }).n === 0) return ctx.continueAsNew({ n: 1 });
      return { done: true };
    });
    eventStore.after = {
      eventType: "EXECUTION_CONTINUED",
      run: async (e) => {
        await rt.cancel(e.executionId).catch(() => {});
      },
    };
    const handle = await rt.start(f, { n: 0 }, { executionId: "r-1" });
    await handle.waitForCompletion();
    expect(await kinds(eventStore, "r-1")).toEqual(["EXECUTION_STARTED", "EXECUTION_CONTINUED"]);
  });

  it("leased park: a cancel between the durable park and the deferred resolveSuspend is a real cancel the handle reports", async () => {
    const wall = 1_700_000_000_000;
    const leases = new InMemoryLeaseStore({ now: () => wall });
    let openRelease!: () => void;
    const gate = new Promise<void>((r) => {
      openRelease = r;
    });
    const releaseOne = leases.release.bind(leases);
    leases.release = async (...a: Parameters<typeof releaseOne>) => {
      await gate;
      return releaseOne(...a);
    };
    const releaseMany = leases.releaseMany?.bind(leases);
    if (releaseMany !== undefined) {
      leases.releaseMany = async (...a: Parameters<typeof releaseMany>) => {
        await gate;
        return releaseMany(...a);
      };
    }
    const { rt, eventStore } = rig({
      heartbeat: {
        leaseStore: leases,
        acquire: "eager",
        nodeId: "n1",
        incarnation: "i1",
        ttlMs: 30_000,
        monotonicNow: () => 1_000,
        wallNow: () => wall,
        every: () => () => {},
      },
    } as Partial<WorkflowRuntimeDeps>);
    const f = flow("parkme", async (ctx) => {
      await ctx.suspend({ on: "Go" });
      return 1;
    });
    let verdict: boolean | undefined;
    eventStore.after = {
      eventType: "EXECUTION_SUSPENDED",
      run: async (e) => {
        // the park is durable; the handle's resolveSuspend waits on the (gated) lease release
        verdict = await rt.cancel(e.executionId, "mid-release");
      },
    };
    const handle = await rt.start(f, {}, { executionId: "p-1" });
    const suspended = handle.waitForSuspend();
    suspended.catch(() => {});
    const completion = handle.waitForCompletion();
    completion.catch(() => {});
    await until(() => verdict !== undefined);
    openRelease();
    // The cancel committed after the park: the run IS cancelled, and the handle says so.
    await expect(completion).rejects.toThrow(/cancel/i);
    await expect(suspended).rejects.toThrow();
    expect(verdict).toBe(true);
    await until(async () => (await kinds(eventStore, "p-1")).includes("EXECUTION_CANCELLED"));
    expect(await kinds(eventStore, "p-1")).toEqual([
      "EXECUTION_STARTED",
      "EXECUTION_SUSPENDED",
      "EXECUTION_CANCELLED",
    ]);
    expect((await rt.loadState("p-1"))?.status).toBe("cancelled");
  });
});
