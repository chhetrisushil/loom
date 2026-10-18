import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it, vi } from "vitest";
import type { FoldedModelEngine } from "./FoldedModelEngine";
import { InMemoryReadModelStore } from "./InMemoryReadModelStore";
import { ReadModelService } from "./ReadModelService";
import {
  CountingStore,
  X,
  boot,
  evt,
  ingestProjection,
  keyOf,
  scopeOf,
  step,
  stepsOf,
} from "./foldedFixtures";
import { SensitiveStateError } from "./sensitiveState";
import { FoldGapError, FoldedUnsupportedError } from "./types";
import type {
  FoldedApply,
  FoldedApplyResult,
  ReadModelDefinition,
  ReadModelEventSource,
  ReadModelStore,
} from "./types";

describe("ReadModelService folded models — live wiring (D13)", () => {
  it("live events fold, unhandled ones included in the sequence, with no liveSource and no error", async () => {
    const errs: unknown[] = [];
    const { service } = await boot({ onError: (e) => errs.push(e) });
    service.handleEvent(evt(X, 0, "EXECUTION_STARTED")); // no handler: not a gap
    service.handleEvent(evt(X, 1, "STEP_COMPLETED", { step: "a" }));
    service.handleEvent(evt(X, 2, "NOISE"));
    service.handleEvent(evt(X, 3, "EXECUTION_COMPLETED"));
    await service.drain();
    expect(errs).toEqual([]);
    expect((await service.getMany("ingest-status", [X])).get(X)).toMatchObject({
      sequence: 3,
      state: { status: "done", steps: 1, last: "a" },
    });
  });

  it("a row model and a folded model are fed by the same handleEvent", async () => {
    const { service } = await boot();
    service.register({
      id: "rows",
      kinds: ["STEP_COMPLETED"],
      indexes: ["step"],
      extract: (e) => [{ fields: { step: (e.payload as { step: string }).step } }],
    });
    service.handleEvent(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    await service.drain();
    expect((await service.getMany("ingest-status", [X])).size).toBe(1);
  });

  it("reserved __loom_* streams are never folded", async () => {
    const { service } = await boot();
    service.handleEvent(evt("__loom_lifecycle__", 0, "STEP_COMPLETED", { step: "x" }));
    await service.drain();
    expect((await service.getMany("ingest-status", ["__loom_lifecycle__"])).size).toBe(0);
  });

  it("a hole in the live tail is filled from liveSource", async () => {
    const log = new InMemoryAsyncEventStore();
    const { service } = await boot({ liveSource: log });
    for (let i = 0; i < 3; i++) await log.append(evt(X, i, "STEP_COMPLETED", { step: `s${i}` }));
    service.handleEvent(evt(X, 2, "STEP_COMPLETED", { step: "s2" })); // cold node, missed 0..1
    await service.drain();
    expect((await service.getMany("ingest-status", [X])).get(X)?.state).toMatchObject({ steps: 3 });
  });

  it("registerFolded on a backend without the methods refuses with a typed error", async () => {
    const bare: ReadModelStore = {
      apply: async () => {},
      watermark: async () => null,
      watermarkedExecutions: async () => [],
      query: async () => ({ rows: [] }),
      clear: async () => {},
    };
    await expect(
      new ReadModelService(bare).registerFolded({ projection: ingestProjection() })
    ).rejects.toBeInstanceOf(FoldedUnsupportedError);
  });

  it("model ids are one namespace across row and folded kinds, in both orders", async () => {
    const { service } = await boot();
    expect(() =>
      service.register({ id: "ingest-status", kinds: ["A"], indexes: [], extract: () => [] })
    ).toThrow(/already registered/);
    service.register({ id: "rows", kinds: ["A"], indexes: [], extract: () => [] });
    const rowFirst = ingestProjection();
    await expect(
      service.registerFolded({ projection: { ...rowFirst, id: "rows" } as typeof rowFirst })
    ).rejects.toThrow(/already registered/);
  });

  it("reading a model that is not a registered folded model rejects (async, not a sync throw)", async () => {
    const { service } = await boot();
    await expect(service.getMany("nope", [X])).rejects.toThrow(/not a registered folded model/);
    await expect(service.getManyByKey("nope", ["d1"])).rejects.toThrow(
      /not a registered folded model/
    );
    await expect(service.refresh("nope", [X], [])).rejects.toThrow(/not a registered folded model/);
    await expect(service.purgeFolded("nope", { executionId: X })).rejects.toThrow(
      /not a registered folded model/
    );
  });

  it("refresh and purgeFolded delegate to the engine", async () => {
    const log = new InMemoryAsyncEventStore();
    const { service } = await boot();
    await log.append(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    expect(await service.refresh("ingest-status", [X], [log])).toBe(1);
    expect((await service.getManyByKey("ingest-status", ["d1"])).get("d1")).toHaveLength(1);
    expect(await service.purgeFolded("ingest-status", { executionId: X })).toBe(1);
    expect((await service.getMany("ingest-status", [X])).size).toBe(0);
  });

  it("foldCache {maxEntries: 0} and false do not throw, and fold correctly", async () => {
    for (const foldCache of [{ maxEntries: 0 }, false] as const) {
      const { service } = await boot({ foldCache });
      service.handleEvent(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
      service.handleEvent(evt(X, 1, "STEP_COMPLETED", { step: "b" }));
      await service.drain();
      expect((await service.getMany("ingest-status", [X])).get(X)?.state).toMatchObject({
        steps: 2,
      });
    }
  });

  it("the service-wide sensitive map reaches the engine: handlers see a masked copy", async () => {
    const errs: unknown[] = [];
    const { service } = await boot({
      sensitive: { STEP_COMPLETED: ["step"] },
      onError: (e) => errs.push(e),
    });
    service.handleEvent(evt(X, 0, "STEP_COMPLETED", { step: "hunter2-secret" }));
    await service.drain();
    const state = (await service.getMany("ingest-status", [X])).get(X);
    expect(JSON.stringify([state, errs])).not.toContain("hunter2-secret");
    expect(state?.sequence).toBe(0);
  });
});

/** Probe: how many applyFolded calls are in flight at once (per store, so per test). */
class ApplyProbeStore extends InMemoryReadModelStore {
  inFlight = 0;
  peak = 0;
  /** When set, the first applyFolded parks here until the test releases it. */
  hold: Promise<void> | undefined;
  override async applyFolded(a: FoldedApply): Promise<FoldedApplyResult> {
    this.inFlight++;
    this.peak = Math.max(this.peak, this.inFlight);
    try {
      const gate = this.hold;
      this.hold = undefined;
      await (gate ?? Promise.resolve()); // a yield point: an unserialized second writer would overlap here
      return await super.applyFolded(a);
    } finally {
      this.inFlight--;
    }
  }
}

/** Parks `clear` until the test releases it, so a reset can be held open. */
class ClearGateStore extends InMemoryReadModelStore {
  hold: Promise<void> | undefined;
  clearing = false;
  override async clear(modelId: string): Promise<void> {
    this.clearing = true;
    await this.hold;
    return super.clear(modelId);
  }
}

describe("ReadModelService folded models — catch-up (D4, D13)", () => {
  it("live handleEvent and catch-up converge on one state", async () => {
    const { service } = await boot();
    const log = new InMemoryAsyncEventStore();
    const events = [evt(X, 0, "STEP_COMPLETED", { step: "a" }), evt(X, 1, "EXECUTION_COMPLETED")];
    for (const e of events) await log.append(e);
    service.handleEvent(events[0]!);
    await service.drain();
    await service.catchUp([log]); // reads from watermark + 1: folds event 1 only
    await service.catchUp([log]); // the watermark makes this a no-op scan
    const got = await service.getMany("ingest-status", [X]);
    expect(got.get(X)?.state).toEqual({ status: "done", steps: 1, last: "a" });
  });

  it("catch-up persists the final watermark even when the log tail is unhandled", async () => {
    const { service, store } = await boot();
    const log = new InMemoryAsyncEventStore();
    await log.append(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    await log.append(evt(X, 1, "NOISE"));
    await service.catchUp([log]);
    expect((await store.getFolded("ingest-status", [X]))[0]).toMatchObject({
      sequence: 1,
      state: { steps: 1 },
    });
    expect((await service.catchUp([log])).eventsScanned).toBe(0); // nothing re-read
  });

  it("one shared read serves row models and folded models in the same scan", async () => {
    const { service } = await boot();
    service.register({
      id: "rows",
      kinds: ["STEP_COMPLETED"],
      indexes: ["step"],
      extract: (e) => [{ fields: { step: (e.payload as { step: string }).step } }],
    });
    const log = new InMemoryAsyncEventStore();
    await log.append(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    const report = await service.catchUp([log]);
    expect(report.eventsScanned).toBe(1);
    expect((await service.query("rows")).rows).toHaveLength(1);
    expect((await service.getMany("ingest-status", [X])).size).toBe(1);
  });

  it("a catch-up fold waits behind an in-flight live apply: applies never overlap (F17)", async () => {
    const store = new ApplyProbeStore();
    let release!: () => void;
    store.hold = new Promise<void>((r) => {
      release = r;
    });
    const service = new ReadModelService(store);
    await service.registerFolded({ projection: ingestProjection(), keyOf, scopeOf });
    const log = new InMemoryAsyncEventStore();
    const events = [
      evt(X, 0, "STEP_COMPLETED", { step: "a" }),
      evt(X, 1, "STEP_COMPLETED", { step: "b" }),
    ];
    for (const e of events) await log.append(e);
    service.handleEvent(events[0]!);
    await vi.waitFor(() => expect(store.inFlight).toBe(1)); // the live apply is parked in the store
    let scanRead = false;
    const spy: ReadModelEventSource = {
      listExecutionsPage: (o) => log.listExecutionsPage!(o),
      readFrom: async (id, from) => {
        scanRead = true;
        return log.readFrom(id, from);
      },
    };
    const scan = service.catchUp([spy]);
    await vi.waitFor(() => expect(scanRead).toBe(true));
    await new Promise((r) => setImmediate(r)); // let every pending microtask run: the scan is queued
    expect(store.inFlight).toBe(1); // a bypassing catch-up would be a second writer by now
    release();
    await scan;
    await service.drain();
    expect(store.peak).toBe(1);
    expect((await service.getMany("ingest-status", [X])).get(X)?.state).toMatchObject({ steps: 2 });
  });

  it("catch-up then a live event with the cache on: the stale cached base is not reused", async () => {
    const store = new CountingStore();
    const service = new ReadModelService(store);
    await service.registerFolded({ projection: ingestProjection(), keyOf, scopeOf });
    const log = new InMemoryAsyncEventStore();
    for (let i = 0; i <= 3; i++) await log.append(step(X, i));
    service.handleEvent(step(X, 0)); // caches X@0
    await service.drain();
    await service.catchUp([log]); // folds 1..3 behind the cached base
    store.reads = 0;
    service.handleEvent(step(X, 4));
    await service.drain();
    expect(store.reads).toBe(1); // the base was re-read, not taken from the cache
    expect(await stepsOf(store)).toBe(5);
  });

  it("catch-up racing a reset drops its stale tail without throwing; the next scan converges", async () => {
    const store = new ClearGateStore();
    const errs: unknown[] = [];
    const service = new ReadModelService(store, { onError: (e) => errs.push(e) });
    await service.registerFolded({ projection: ingestProjection(), keyOf, scopeOf });
    const log = new InMemoryAsyncEventStore();
    for (let i = 0; i <= 3; i++) await log.append(step(X, i));
    await service.catchUp([log]);
    expect(await stepsOf(store)).toBe(4);
    await log.append(step(X, 4));
    let release!: () => void;
    store.hold = new Promise<void>((r) => {
      release = r;
    });
    const engine = (service as unknown as { folded: FoldedModelEngine }).folded;
    const reset = engine.reset("ingest-status"); // parked inside store.clear
    await vi.waitFor(() => expect(store.clearing).toBe(true));
    const scan = service.catchUp([log]); // reads watermark 3, queues behind the reset
    await new Promise((r) => setImmediate(r));
    release();
    await reset;
    await expect(scan).resolves.toBeDefined();
    expect(await store.getFolded("ingest-status", [X])).toEqual([]); // nothing written over the reset
    await service.catchUp([log]);
    expect(await stepsOf(store)).toBe(5);
    expect(errs).toEqual([]);
  });

  it("a catch-up gap throws FoldGapError, writes nothing, and the live tail still reports the gap", async () => {
    const errs: unknown[] = [];
    const { service, store } = await boot({ onError: (e) => errs.push(e) });
    const log = new InMemoryAsyncEventStore();
    await log.append(step(X, 0));
    await log.append(step(X, 2)); // hole at 1
    await expect(service.catchUp([log])).rejects.toBeInstanceOf(FoldGapError);
    expect(await store.getFolded("ingest-status", [X])).toEqual([]);
    service.handleEvent(step(X, 3)); // the frontier was not adopted: still a gap
    await service.drain();
    expect(errs[0]).toBeInstanceOf(FoldGapError);
  });

  it("a catch-up SensitiveStateError throws to the caller and the watermark does not advance", async () => {
    const email = "alice@example.com";
    const p = ingestProjection();
    (p.handlers as Record<string, unknown>).STEP_COMPLETED = (
      s: object,
      e: { payload: { mirror?: string } }
    ) => ({
      ...s,
      last: e.payload.mirror,
    });
    const store = new InMemoryReadModelStore();
    const service = new ReadModelService(store);
    await service.registerFolded({ projection: p, sensitive: { STEP_COMPLETED: ["email"] } });
    const log = new InMemoryAsyncEventStore();
    await log.append(evt(X, 0, "STEP_COMPLETED", { email, mirror: email }));
    await expect(service.catchUp([log])).rejects.toBeInstanceOf(SensitiveStateError);
    expect(await store.getFolded("ingest-status", [X])).toEqual([]);
  });

  it("models at different watermarks each apply exactly their own tail from one shared read", async () => {
    for (const rowsAhead of [true, false]) {
      const { service, store } = await boot();
      const log = new InMemoryAsyncEventStore();
      const rows: ReadModelDefinition = {
        id: "rows",
        kinds: ["STEP_COMPLETED"],
        indexes: ["step"],
        extract: (e) => [{ fields: { step: (e.payload as { step: string }).step } }],
      };
      if (rowsAhead) {
        for (let i = 0; i <= 5; i++) await log.append(step(X, i));
        service.register(rows);
        await store.apply("rows", X, 3, []); // rows at 3, folded at -1
      } else {
        for (let i = 0; i <= 3; i++) await log.append(step(X, i));
        await service.catchUp([log]); // folded at 3
        for (let i = 4; i <= 5; i++) await log.append(step(X, i));
        service.register(rows); // rows at -1
      }
      const report = await service.catchUp([log]);
      expect(report.eventsScanned).toBe(6);
      expect(await stepsOf(store)).toBe(6);
      expect((await service.query("rows")).rows).toHaveLength(rowsAhead ? 2 : 6);
    }
  });

  it("a source that cannot be enumerated makes catch-up refuse", async () => {
    const { service } = await boot();
    await expect(service.catchUp([{ readFrom: async () => [] }])).rejects.toThrow(/enumerated/);
  });
});

describe("ReadModelService folded models — refresh, erasure, rebuild, pins", () => {
  it("getMany({ refreshFrom }) is read-your-writes without any live feed", async () => {
    const { service } = await boot();
    const log = new InMemoryAsyncEventStore();
    await log.append(evt(X, 0, "EXECUTION_COMPLETED"));
    const got = await service.getMany("ingest-status", [X], { refreshFrom: [log] });
    expect(got.get(X)?.state).toMatchObject({ status: "done" });
  });

  it("purgeFolded tombstones; a later catch-up and later events do not resurrect it", async () => {
    const { service } = await boot();
    const log = new InMemoryAsyncEventStore();
    await log.append(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    await service.catchUp([log]);
    expect(await service.purgeFolded("ingest-status", { scope: "u1" })).toBe(1);
    await log.append(evt(X, 1, "EXECUTION_COMPLETED"));
    await service.catchUp([log]);
    service.handleEvent(evt(X, 2, "STEP_COMPLETED", { step: "late" }));
    await service.drain();
    expect((await service.getMany("ingest-status", [X])).size).toBe(0);
  });

  it("a changed fold version rebuilds on registration and the next catch-up re-folds from the log", async () => {
    const store = new InMemoryReadModelStore();
    const log = new InMemoryAsyncEventStore();
    await log.append(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    const v1 = new ReadModelService(store);
    expect(await v1.registerFolded({ projection: ingestProjection("1") })).toEqual({
      rebuilt: false,
    });
    await v1.catchUp([log]);

    const v2 = new ReadModelService(store);
    expect(await v2.registerFolded({ projection: ingestProjection("2") })).toEqual({
      rebuilt: true,
    });
    expect((await v2.getMany("ingest-status", [X])).size).toBe(0);
    const report = await v2.catchUp([log]);
    expect(report.eventsScanned).toBe(1);
    expect((await v2.getMany("ingest-status", [X])).size).toBe(1);
  });

  it("an old-version node is refused after a rebuild instead of corrupting the new fold", async () => {
    const store = new InMemoryReadModelStore();
    const errs: unknown[] = [];
    const old = new ReadModelService(store, { onError: (e) => errs.push(e) });
    await old.registerFolded({ projection: ingestProjection("1") });
    await new ReadModelService(store).registerFolded({ projection: ingestProjection("2") });
    old.handleEvent(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    await old.drain();
    expect(String(errs[0])).toMatch(/version "1"/);
    expect(await store.getFolded("ingest-status", [X])).toEqual([]);
  });

  it("rebuild(modelId) clears and re-folds a folded model; pins() reports its version", async () => {
    const { service } = await boot();
    const log = new InMemoryAsyncEventStore();
    await log.append(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    await service.catchUp([log]);
    expect(service.pins()).toEqual({ "ingest-status": "1" });
    const report = await service.rebuild("ingest-status", [log]);
    expect(report.eventsScanned).toBe(1);
    expect((await service.getMany("ingest-status", [X])).get(X)?.sequence).toBe(0);
  });

  it("rebuild un-tombstones and does not touch other models; pins carry the sensitive digest", async () => {
    const { service } = await boot();
    const log = new InMemoryAsyncEventStore();
    await log.append(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    await service.catchUp([log]);
    await service.purgeFolded("ingest-status", { executionId: X });
    await service.rebuild("ingest-status", [log]);
    expect((await service.getMany("ingest-status", [X])).size).toBe(1);

    const sens = new ReadModelService(new InMemoryReadModelStore(), {
      sensitive: { STEP_COMPLETED: ["step"] },
    });
    await sens.registerFolded({ projection: ingestProjection() });
    expect(sens.pins()["ingest-status"]).toMatch(/^1\+sens\./);
  });
});
