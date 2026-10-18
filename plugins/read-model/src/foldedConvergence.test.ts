import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import type { FoldedModelEngine } from "./FoldedModelEngine";
import { InMemoryReadModelStore } from "./InMemoryReadModelStore";
import { ReadModelService, type ReadModelServiceOptions } from "./ReadModelService";
import { evt, ingestProjection, keyOf, scopeOf } from "./foldedFixtures";
import { FoldGapError, type ReadModelEventSource } from "./types";

// A log with interleaved executions, one with a `.2` generation, and unhandled events (the
// STARTED at 0 and the NOISE at 2 have no handler: they are the realistic case, not an edge).
const ids = ["u1:wf:ingest-d1", "u1:wf:ingest-d1.2", "u2:wf:ingest-d2"];
function corpus(): EventEnvelope[] {
  const out: EventEnvelope[] = [];
  for (let seq = 0; seq < 5; seq++) {
    for (const id of ids) {
      if (seq === 0) out.push(evt(id, 0, "EXECUTION_STARTED"));
      if (seq === 1) out.push(evt(id, 1, "STEP_COMPLETED", { step: "ocr" }));
      if (seq === 2) out.push(evt(id, 2, "NOISE"));
      if (seq === 3) out.push(evt(id, 3, "STEP_COMPLETED", { step: "embed" }));
      if (seq === 4)
        out.push(evt(id, 4, id.endsWith(".2") ? "EXECUTION_FAILED" : "EXECUTION_COMPLETED"));
    }
  }
  return out;
}
async function logOf(events: EventEnvelope[]) {
  const log = new InMemoryAsyncEventStore();
  for (const e of events) await log.append(e);
  return log;
}

/** The one way this file builds a service: its own error collector, and a liveSource unless told otherwise. */
async function service(
  store: InMemoryReadModelStore,
  opts: Pick<ReadModelServiceOptions, "liveSource" | "foldCache"> = {}
) {
  const errors: unknown[] = [];
  const s = new ReadModelService(store, { ...opts, onError: (e) => errors.push(e) });
  await s.registerFolded({ projection: ingestProjection(), keyOf, scopeOf });
  return { s, errors };
}
/** Literal final state of every corpus execution: the oracle no catch-up path is allowed to define. */
const oracle = {
  "u1:wf:ingest-d1": { sequence: 4, state: { status: "done", steps: 2, last: "embed" } },
  "u1:wf:ingest-d1.2": { sequence: 4, state: { status: "failed", steps: 2, last: "embed" } },
  "u2:wf:ingest-d2": { sequence: 4, state: { status: "done", steps: 2, last: "embed" } },
};
const expectOracle = async (s: ReadModelService) => {
  const got = await snapshot(s);
  expect(Object.keys(got).sort()).toEqual(Object.keys(oracle).sort());
  for (const [id, want] of Object.entries(oracle)) expect(got[id]).toMatchObject(want);
};
const snapshot = async (s: ReadModelService) =>
  Object.fromEntries(await s.getMany("ingest-status", ids).then((m) => [...m]));

/** What one node has been handed so far: a liveSource that can fill only what THIS node saw. */
function seenBy(seen: EventEnvelope[]): ReadModelEventSource {
  return {
    readFrom: async (id, from) =>
      seen
        .filter((e) => e.executionId === id && e.sequence >= from)
        .sort((a, b) => a.sequence - b.sequence),
  };
}

describe("folded models: rebuild == incremental (D14)", () => {
  it("live-only, catch-up-only, partial-prefix-then-catch-up and rebuild all agree, with no live error", async () => {
    const events = corpus();
    const log = await logOf(events);

    const live = await service(new InMemoryReadModelStore(), { liveSource: log });
    for (const e of events) live.s.handleEvent(e);
    await live.s.drain();
    expect(live.errors).toEqual([]); // the live leg folded for real: nothing was a gap

    const scan = await service(new InMemoryReadModelStore(), { liveSource: log });
    await scan.s.catchUp([log]);

    const prefix = await service(new InMemoryReadModelStore(), { liveSource: log });
    for (const e of events.filter((e) => e.sequence < 2)) prefix.s.handleEvent(e);
    await prefix.s.drain();
    await prefix.s.catchUp([log]);
    expect(prefix.errors).toEqual([]);

    // corrupt first, in a way a scan cannot repair: a wrong state beyond the log's end for one
    // execution and a stray row for an execution the log has never heard of
    const rebuiltStore = new InMemoryReadModelStore();
    const rebuilt = await service(rebuiltStore, { liveSource: log });
    const stray = "u9:wf:ingest-zz";
    const wrong = (executionId: string, upToSequence: number) =>
      rebuiltStore.applyFolded({
        modelId: "ingest-status",
        executionId,
        upToSequence,
        state: { status: "failed", steps: 99 },
        key: keyOf(executionId) ?? null,
        scope: scopeOf(executionId) ?? null,
        foldVersion: "1",
      });
    expect(await wrong("u1:wf:ingest-d1", 9)).toBe("applied");
    expect(await wrong(stray, 3)).toBe("applied");
    await rebuilt.s.catchUp([log]); // cannot repair: d1's watermark is already past the log
    expect((await snapshot(rebuilt.s))["u1:wf:ingest-d1"]).toMatchObject({ sequence: 9 });
    await rebuilt.s.rebuild("ingest-status", [log]);
    expect(await rebuiltStore.getFolded("ingest-status", [stray])).toEqual([]);
    expect(rebuilt.errors).toEqual([]);

    const expected = await snapshot(live.s);
    await expectOracle(live.s);
    expect(await snapshot(scan.s)).toEqual(expected);
    expect(await snapshot(prefix.s)).toEqual(expected);
    expect(await snapshot(rebuilt.s)).toEqual(expected);
  });

  it("the live leg alone (no catch-up) reaches the final state of every execution", async () => {
    const events = corpus();
    const { s, errors } = await service(new InMemoryReadModelStore(), {
      liveSource: await logOf(events),
    });
    for (const e of events) s.handleEvent(e);
    await s.drain();
    expect(errors).toEqual([]);
    const got = await snapshot(s);
    expect(got["u1:wf:ingest-d1"]).toMatchObject({
      sequence: 4,
      state: { status: "done", steps: 2, last: "embed" },
    });
    expect(got["u1:wf:ingest-d1.2"]).toMatchObject({
      sequence: 4,
      state: { status: "failed", steps: 2 },
    });
  });

  it("two nodes ingesting the same events concurrently into one store converge", async () => {
    const events = corpus();
    const log = await logOf(events);
    const store = new InMemoryReadModelStore();
    const a = await service(store, { liveSource: log });
    const b = await service(store, { liveSource: log });
    for (const e of events) a.s.handleEvent(e);
    for (const e of events) b.s.handleEvent(e);
    await Promise.all([a.s.drain(), b.s.drain()]);
    await a.s.catchUp([log]); // heals whatever a lost race left out
    await expectOracle(a.s);
    expect([...a.errors, ...b.errors]).toEqual([]);
  });

  it("the state cache cannot change a result: cache default, off and tiny (constant eviction) agree", async () => {
    const events = corpus();
    const log = await logOf(events);
    const snaps = [];
    for (const foldCache of [undefined, false, { maxEntries: 1 }] as const) {
      const { s, errors } = await service(new InMemoryReadModelStore(), {
        liveSource: log,
        ...(foldCache !== undefined && { foldCache }),
      });
      for (const e of events) s.handleEvent(e);
      await s.drain();
      await s.catchUp([log]);
      expect(errors).toEqual([]);
      snaps.push(await snapshot(s));
    }
    expect(snaps[1]).toEqual(snaps[0]);
    expect(snaps[2]).toEqual(snaps[0]);
  });

  it.each([
    ["cache enabled (default)", undefined],
    ["cache disabled", false],
  ] as const)(
    "two nodes that each saw only alternate events converge through the log, %s (D15)",
    async (_label, foldCache) => {
      const events = corpus();
      const log = await logOf(events);
      const store = new InMemoryReadModelStore();
      const seenA: EventEnvelope[] = [];
      const seenB: EventEnvelope[] = [];
      // each node's liveSource can only fill what that node itself saw, so a hole it cannot fill is a
      // FoldGapError (reported, allowed here); convergence then comes from the log via catch-up
      const mk = async (seen: EventEnvelope[]) =>
        service(store, { liveSource: seenBy(seen), ...(foldCache !== undefined && { foldCache }) });
      const a = await mk(seenA);
      const b = await mk(seenB);
      events.forEach((e, i) => {
        (i % 2 === 0 ? seenA : seenB).push(e);
        (i % 2 === 0 ? a : b).s.handleEvent(e);
      });
      await Promise.all([a.s.drain(), b.s.drain()]);
      const all = [...a.errors, ...b.errors];
      expect(all.length).toBeGreaterThan(0); // the scenario really produced gaps
      for (const e of all) expect(e).toBeInstanceOf(FoldGapError);
      await a.s.catchUp([log]);
      await expectOracle(a.s);
    }
  );

  it.each([
    ["cache enabled (default)", undefined],
    ["cache disabled", false],
  ] as const)(
    "a node's cached base is stale after another node advanced the store; the next live event still converges, %s",
    async (_label, foldCache) => {
      const X0 = ids[0] as string;
      const events = corpus().filter((e) => e.executionId === X0);
      const log = await logOf(events);
      const store = new InMemoryReadModelStore();
      const a = await service(store, {
        liveSource: log,
        ...(foldCache !== undefined && { foldCache }),
      });
      const b = await service(store, { liveSource: seenBy(events.filter((e) => e.sequence <= 3)) });
      for (const e of events.filter((e) => e.sequence <= 2)) a.s.handleEvent(e); // A's cached base is seq 1 (0 and 2 are unhandled)
      await a.s.drain();
      for (const e of events.filter((e) => e.sequence === 3)) b.s.handleEvent(e); // B advances to 3
      await b.s.drain();
      // premise: A holds a base (cache on) strictly below the store's watermark
      const cacheOf = (n: typeof a) => (n.s as unknown as { folded: FoldedModelEngine }).folded;
      expect(cacheOf(a).cacheSize()).toBe(foldCache === false ? 0 : 1);
      expect((await store.getFolded("ingest-status", [X0]))[0]?.sequence).toBe(3);
      for (const e of events.filter((e) => e.sequence === 4)) a.s.handleEvent(e); // A's base is stale
      await a.s.drain();
      expect([...a.errors, ...b.errors]).toEqual([]);
      const got = await a.s.getMany("ingest-status", [X0]);
      expect(got.get(X0)).toMatchObject(oracle[X0 as keyof typeof oracle]);
    }
  );

  it("getManyByKey returns both generations of a document", async () => {
    const { s, errors } = await service(new InMemoryReadModelStore());
    await s.catchUp([await logOf(corpus())]);
    const got = await s.getManyByKey<{ status: string }>("ingest-status", ["d1"]);
    expect(got.get("d1")?.map((g) => [g.executionId, g.state.status])).toEqual([
      ["u1:wf:ingest-d1", "done"],
      ["u1:wf:ingest-d1.2", "failed"],
    ]);
    expect(errors).toEqual([]);
  });
});
