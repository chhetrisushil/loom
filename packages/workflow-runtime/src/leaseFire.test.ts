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
  return { a: node(), b: node(), timerStore, leaseStore, work, flow };
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
