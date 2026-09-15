import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import {
  InMemoryAsyncEventStore,
  InMemoryLeaseStore,
  InMemoryTimerStore,
} from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TimerService } from "./TimerService";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { recoverAbandoned } from "./recoverAbandoned";
import type { FlowRunner, RegisteredFlow } from "./types";

// ── #380 — two nodes, one due timer ──────────────────────────────────────────
//
// `TimerStore.due()` has no claim: both nodes receive the same due timer, both resume, and
// both pay for every effect until one loses at the fence. Fencing makes that SAFE, not cheap
// — and after #392 the duplicate is expensive on purpose, since a wake now goes to the lane a
// branch was placed on and branches are placed when the work is heavy.

const inputSchema = z.object({ n: z.number() });
const outputSchema = z.object({ done: z.boolean() });
type In = { n: number };
type Out = { done: boolean };

const expensive = step$({
  id: "expensive",
  name: "Expensive",
  toolId: "expensive-tool",
  inputSchema,
  outputSchema,
});

function makeFlow(runner: FlowRunner<In, Out>): RegisteredFlow<In, Out> {
  const definition: FlowDefinition<In, Out> = {
    _tag: "FlowDefinition",
    id: "leased",
    name: "leased",
    version: "1.0.0",
    inputSchema,
    outputSchema,
    steps: [expensive],
  };
  return { definition, runner };
}

/** Two runtimes over ONE set of stores — the shape of two nodes sharing a database. */
function twoNodes() {
  const eventStore = new InMemoryAsyncEventStore();
  const snapshotStore = new InMemoryAsyncSnapshotStore();
  const timerStore = new InMemoryTimerStore();
  const leaseStore = new InMemoryLeaseStore();
  const work = vi.fn(async () => ({ done: true }));

  const flow = makeFlow(async (ctx, input) => {
    await ctx.suspend({ on: "Approval", timeout: 60_000 });
    return await ctx.run(expensive, input);
  });

  const node = (): WorkflowRuntime => {
    const effects = new EffectRuntime();
    effects.register("expensive-tool", new ToolEffect(work));
    const runtime = new WorkflowRuntime({
      eventStore,
      snapshotStore,
      effectRuntime: effects,
      timerStore,
      onWarn: () => {},
    });
    runtime.registerFlow(flow.definition, flow.runner);
    return runtime;
  };
  return { a: node(), b: node(), eventStore, timerStore, leaseStore, work, flow };
}

describe("#380 — only one node pays for a duplicated wake", () => {
  it("without leases, BOTH nodes fire the same timer and both do the work", async () => {
    // The cost this exists to remove, asserted so the fix has something to improve on.
    const n = twoNodes();
    const handle = await n.a.start(n.flow, { n: 1 }, { executionId: "dup" });
    const parked = await handle.waitForSuspend();
    const at = (parked.suspendedOn?.wakeAt ?? 0) + 1;

    await Promise.all([
      new TimerService(n.a, n.timerStore).tick(at),
      new TimerService(n.b, n.timerStore).tick(at),
    ]);
    expect(n.work.mock.calls.length).toBeGreaterThan(1);
  });

  it("with leases, the second node finds it owned and does nothing", async () => {
    const n = twoNodes();
    const handle = await n.a.start(n.flow, { n: 1 }, { executionId: "leased-1" });
    const parked = await handle.waitForSuspend();
    const at = (parked.suspendedOn?.wakeAt ?? 0) + 1;

    const leases = (owner: string) => ({ store: n.leaseStore, owner, ttlMs: 60_000 });
    await Promise.all([
      new TimerService(n.a, n.timerStore, { leases: leases("node-a") }).tick(at),
      new TimerService(n.b, n.timerStore, { leases: leases("node-b") }).tick(at),
    ]);

    expect(n.work).toHaveBeenCalledTimes(1);
    expect((await n.a.loadState("leased-1"))?.status).toBe("completed");
  });

  it("releases ownership afterwards, so the next legitimate wake is not blocked", async () => {
    const n = twoNodes();
    const handle = await n.a.start(n.flow, { n: 1 }, { executionId: "leased-2" });
    const parked = await handle.waitForSuspend();

    await new TimerService(n.a, n.timerStore, {
      leases: { store: n.leaseStore, owner: "node-a" },
    }).tick((parked.suspendedOn?.wakeAt ?? 0) + 1);

    // Ownership covers the fire, not the execution's whole life.
    expect(await n.leaseStore.acquire("leased-2", "node-b", 1000)).not.toBeNull();
  });

  it("leaves the timer alone when it cannot claim, so a wake is never lost", async () => {
    // If the holder dies between claiming and resuming, completing the timer here would
    // discard the wake entirely. Skipping leaves it for the next poll.
    const n = twoNodes();
    const handle = await n.a.start(n.flow, { n: 1 }, { executionId: "leased-3" });
    const parked = await handle.waitForSuspend();
    const at = (parked.suspendedOn?.wakeAt ?? 0) + 1;
    await n.leaseStore.acquire("leased-3", "someone-else", 60_000);

    await new TimerService(n.b, n.timerStore, {
      leases: { store: n.leaseStore, owner: "node-b" },
    }).tick(at);

    expect(n.work).not.toHaveBeenCalled();
    expect(await n.timerStore.due(at)).toHaveLength(1); // still pending
  });
});

// ── #380 L3 — recovery from evidence instead of a predicate ──────────────────

describe("recoverAbandoned with leases", () => {
  /** A `running` execution with no owner: started, never settled. */
  async function orphan(runtime: WorkflowRuntime, id: string) {
    const stuck = makeFlow(async () => new Promise<Out>(() => ({ done: true })));
    runtime.registerFlow(stuck.definition, stuck.runner);
    void runtime.start(stuck, { n: 1 }, { executionId: id });
    await vi.waitFor(async () => expect((await runtime.loadState(id))?.status).toBe("running"));
  }

  it("recovers an expired lease with no predicate at all", async () => {
    const n = twoNodes();
    await orphan(n.a, "orphan-1");
    // node-a took ownership and then died without releasing it.
    await n.leaseStore.acquire("orphan-1", "node-a", 1, Date.now() - 60_000);

    const recovered: string[] = [];
    const summary = await recoverAbandoned(n.b, {
      leases: { store: n.leaseStore, owner: "node-b" },
      dispatcher: {
        async dispatch(pkg) {
          recovered.push(pkg.executionId);
          return undefined;
        },
      },
    });

    expect(summary).toMatchObject({ scanned: 1, candidates: 1, recovered: 1 });
    expect(recovered).toEqual(["orphan-1"]);
  });

  it("leaves an execution whose owner is still renewing", async () => {
    const n = twoNodes();
    await orphan(n.a, "healthy-1");
    await n.leaseStore.acquire("healthy-1", "node-a", 60_000); // alive

    const summary = await recoverAbandoned(n.b, {
      leases: { store: n.leaseStore, owner: "node-b" },
      dispatcher: {
        async dispatch() {
          return undefined;
        },
      },
    });
    // Not even scanned: a live lease is not in `expired()`, which is the point of scanning
    // leases rather than every execution.
    expect(summary).toMatchObject({ scanned: 0, recovered: 0 });
  });

  it("still asks a predicate when given one, so it never becomes a lie", async () => {
    const n = twoNodes();
    await orphan(n.a, "orphan-2");
    await n.leaseStore.acquire("orphan-2", "node-a", 1, Date.now() - 60_000);

    const summary = await recoverAbandoned(n.b, {
      leases: { store: n.leaseStore, owner: "node-b" },
      isAbandoned: () => false, // "I know better"
      dispatcher: {
        async dispatch() {
          return undefined;
        },
      },
    });
    expect(summary).toMatchObject({ candidates: 1, recovered: 0 });
  });

  it("claims before re-driving, so two passes racing an orphan do not both pay", async () => {
    const n = twoNodes();
    await orphan(n.a, "orphan-3");
    await n.leaseStore.acquire("orphan-3", "dead-node", 1, Date.now() - 60_000);

    const driven: string[] = [];
    const dispatcher = {
      async dispatch(pkg: { executionId: string }) {
        driven.push(pkg.executionId);
        return undefined;
      },
    };
    const [first, second] = await Promise.all([
      recoverAbandoned(n.b, { leases: { store: n.leaseStore, owner: "rescuer-1" }, dispatcher }),
      recoverAbandoned(n.b, { leases: { store: n.leaseStore, owner: "rescuer-2" }, dispatcher }),
    ]);

    expect(driven).toEqual(["orphan-3"]);
    expect((first?.recovered ?? 0) + (second?.recovered ?? 0)).toBe(1);
  });

  it("still requires a predicate when there is no evidence to use", async () => {
    const n = twoNodes();
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: asserting the runtime guard
      recoverAbandoned(n.a, { source: n.eventStore } as any)
    ).rejects.toThrow(/isAbandoned` is required/);
  });
});
