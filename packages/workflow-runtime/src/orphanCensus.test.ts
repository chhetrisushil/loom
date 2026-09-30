import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryLeaseStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { orphanCensus } from "./orphanCensus";
import type { FlowRunner, RegisteredFlow } from "./types";

// ── #408 — making an unfalsifiable condition measurable ──────────────────────
//
// "Defer until a deployment reports orphans the staleness predicate misses" had no producer:
// a false negative sits `running` forever, silently, and nobody files an issue about work that
// quietly never finished. Every other maintenance pass reads state in order to ACT. This one
// only looks — and `none` is the number that decides #408.

const inputSchema = z.object({ n: z.number() });
const outputSchema = z.object({ done: z.boolean() });
type In = { n: number };
type Out = { done: boolean };

const after = step$({
  id: "after",
  name: "After",
  toolId: "after-tool",
  inputSchema,
  outputSchema,
});

function boot() {
  const effects = new EffectRuntime();
  effects.register("after-tool", new ToolEffect(async () => ({ done: true })));
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    onWarn: () => {},
  });
  const leaseStore = new InMemoryLeaseStore();
  return { runtime, eventStore, leaseStore };
}

function stuckFlow(flowId: string): RegisteredFlow<In, Out> {
  const definition: FlowDefinition<In, Out> = {
    _tag: "FlowDefinition",
    id: flowId,
    name: flowId,
    version: "1.0.0",
    inputSchema,
    outputSchema,
    steps: [after],
  };
  return { definition, runner: (async () => new Promise<Out>(() => {})) as FlowRunner<In, Out> };
}

async function startStuck(app: ReturnType<typeof boot>, id: string) {
  const flow = stuckFlow(`stuck-${id}`);
  app.runtime.registerFlow(flow.definition, flow.runner);
  void app.runtime.start(flow, { n: 1 }, { executionId: id });
  await vi.waitFor(async () => expect((await app.runtime.loadState(id))?.status).toBe("running"));
}

describe("orphanCensus — what is stuck, and is anything watching it", () => {
  it("bands in-flight executions by age, cumulatively, with a sample to point at", async () => {
    const app = boot();
    await startStuck(app, "a");
    await startStuck(app, "b");

    const now = Date.now() + 7 * 60 * 60_000; // pretend seven hours passed
    const census = await orphanCensus(app.runtime, { source: app.eventStore, now });

    expect(census.inFlight).toBe(2);
    const sixHours = census.bands.find((b) => b.olderThanMs === 6 * 60 * 60_000);
    const oneHour = census.bands.find((b) => b.olderThanMs === 60 * 60_000);
    expect(sixHours?.count).toBe(2);
    expect(oneHour?.count).toBe(2); // cumulative: older-than-6h is also older-than-1h
    expect(census.bands.find((b) => b.olderThanMs === 24 * 60 * 60_000)?.count).toBe(0);
    expect(sixHours?.sample).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("counts what has NO lease at all — the number #408 turns on", async () => {
    const app = boot();
    await startStuck(app, "watched");
    await startStuck(app, "lapsed");
    await startStuck(app, "unwatched");

    // A TTL beyond the observation point, because "held" means a holder is still RENEWING —
    // a fixture with a 60s lease read ten minutes later is modelling a dead node, not a live one.
    await app.leaseStore.acquire("watched", "node-a", 30 * 60_000);
    await app.leaseStore.acquire("lapsed", "node-b", 1, Date.now() - 60_000);
    // "unwatched" is the shape L5b would cover: started by a request, leased by nobody.

    const census = await orphanCensus(app.runtime, {
      source: app.eventStore,
      leases: app.leaseStore,
      now: Date.now() + 10 * 60_000,
    });

    expect(census.leases).toEqual({ held: 1, expired: 1, none: 1 });
    // The distinction is the point: `expired` will be recovered from evidence, `none` never
    // can be — nothing was ever watching it.
    const band = census.bands.find((b) => b.olderThanMs === 5 * 60_000);
    expect(band?.leases).toEqual({ held: 1, expired: 1, none: 1 });
  });

  it("judges leases on the store's own clock (storeNow), not the host's, unless `now` is given", async () => {
    const app = boot();
    await startStuck(app, "leased");
    await app.leaseStore.acquire("leased", "node-a", 30 * 60_000); // expires ~30m from host now

    const hostClock = await orphanCensus(app.runtime, {
      source: app.eventStore,
      leases: app.leaseStore,
    });
    expect(hostClock.leases).toEqual({ held: 1, expired: 0, none: 0 });

    // A store whose clock (think: Postgres DB time) is an hour ahead of this host's.
    const ahead = Object.assign(app.leaseStore, {
      storeNow: async () => Date.now() + 60 * 60_000,
    });
    const onStoreClock = await orphanCensus(app.runtime, { source: app.eventStore, leases: ahead });
    expect(onStoreClock.leases).toEqual({ held: 0, expired: 1, none: 0 });

    // An explicit `now` still wins.
    const explicit = await orphanCensus(app.runtime, {
      source: app.eventStore,
      leases: ahead,
      now: Date.now(),
    });
    expect(explicit.leases).toEqual({ held: 1, expired: 0, none: 0 });
  });

  it("ignores executions that are not in flight", async () => {
    const app = boot();
    await startStuck(app, "running-one");
    const done = makeCompleting();
    app.runtime.registerFlow(done.definition, done.runner);
    await (
      await app.runtime.start(done, { n: 1 }, { executionId: "finished" })
    ).waitForCompletion();

    const census = await orphanCensus(app.runtime, { source: app.eventStore, now: Date.now() });
    expect(census.scanned).toBe(2);
    expect(census.inFlight).toBe(1);
  });

  it("acts on nothing — a census that could recover is a census nobody trusts", async () => {
    const app = boot();
    await startStuck(app, "untouched");
    const before = await app.runtime.loadState("untouched");

    await orphanCensus(app.runtime, {
      source: app.eventStore,
      leases: app.leaseStore,
      now: Date.now() + 24 * 60 * 60_000,
    });

    const after = await app.runtime.loadState("untouched");
    expect(after?.sequence).toBe(before?.sequence);
    expect(after?.status).toBe("running");
    // And it took no lease while looking: reading must not become owning.
    expect(await app.leaseStore.get("untouched")).toBeNull();
  });

  it("omits lease counts entirely when no store is given, rather than reporting zeros", async () => {
    const app = boot();
    await startStuck(app, "x");
    const census = await orphanCensus(app.runtime, { source: app.eventStore, now: Date.now() });
    // Zeros would read as "nothing is unwatched", which is a different claim from "not asked".
    expect(census.leases).toBeUndefined();
    expect(census.bands.every((b) => b.leases === undefined)).toBe(true);
  });
});

function makeCompleting(): RegisteredFlow<In, Out> {
  const definition: FlowDefinition<In, Out> = {
    _tag: "FlowDefinition",
    id: "completing",
    name: "completing",
    version: "1.0.0",
    inputSchema,
    outputSchema,
    steps: [after],
  };
  return { definition, runner: async (ctx, input) => (await ctx.run(after, input)) as Out };
}
