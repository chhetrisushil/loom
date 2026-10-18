import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { InMemoryReadModelStore } from "./InMemoryReadModelStore";
import { ReadModelService } from "./ReadModelService";
import { X, boot, evt, ingestProjection, keyOf, scopeOf } from "./foldedFixtures";
import { FoldedUnsupportedError } from "./types";
import type { FoldedApply, FoldedApplyResult, ReadModelStore } from "./types";

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
  override async applyFolded(a: FoldedApply): Promise<FoldedApplyResult> {
    this.inFlight++;
    this.peak = Math.max(this.peak, this.inFlight);
    try {
      await Promise.resolve(); // a yield point: an unserialized second writer would overlap here
      return await super.applyFolded(a);
    } finally {
      this.inFlight--;
    }
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

  it("a catch-up fold runs on the live path's queue: applies for one execution never overlap", async () => {
    const store = new ApplyProbeStore();
    const service = new ReadModelService(store);
    await service.registerFolded({ projection: ingestProjection(), keyOf, scopeOf });
    const log = new InMemoryAsyncEventStore();
    const events = [
      evt(X, 0, "STEP_COMPLETED", { step: "a" }),
      evt(X, 1, "STEP_COMPLETED", { step: "b" }),
    ];
    for (const e of events) await log.append(e);
    service.handleEvent(events[0]!); // in flight when the scan starts
    await service.catchUp([log]);
    await service.drain();
    expect(store.peak).toBe(1);
    expect((await service.getMany("ingest-status", [X])).get(X)?.state).toMatchObject({ steps: 2 });
  });

  it("a catch-up refusal throws to the caller and the watermark does not advance", async () => {
    const { service, store } = await boot();
    const log = new InMemoryAsyncEventStore();
    await log.append(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    await log.append(evt(X, 2, "STEP_COMPLETED", { step: "c" })); // hole at 1
    await expect(service.catchUp([log])).rejects.toThrow();
    expect(await store.getFolded("ingest-status", [X])).toEqual([]);
  });

  it("a source that cannot be enumerated makes catch-up refuse", async () => {
    const { service } = await boot();
    await expect(service.catchUp([{ readFrom: async () => [] }])).rejects.toThrow(/enumerated/);
  });
});
