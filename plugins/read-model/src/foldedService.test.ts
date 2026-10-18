import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { ReadModelService } from "./ReadModelService";
import { X, boot, evt, ingestProjection } from "./foldedFixtures";
import { FoldedUnsupportedError } from "./types";
import type { ReadModelStore } from "./types";

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
