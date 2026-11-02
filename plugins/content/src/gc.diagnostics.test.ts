import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { wasReopened } from "./executionEnd";
import { sweepUnpinnedContent } from "./gc";
import { InMemoryContentStore } from "./index";

// Sweep diagnostics: keptByTouch / touchCutoff (the store clock vs the log clock) and
// refsOfReopened / reclaimedWhileReopened (ADR 0146's re-opened exception made visible).

const DAY = 24 * 60 * 60 * 1000;
const TTL = 30 * DAY;
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

const evt = (
  executionId: string,
  sequence: number,
  eventType: string,
  payload: unknown,
  timestamp: number
): EventEnvelope => ({
  id: `${executionId}-${sequence}`,
  workflowId: "wf",
  executionId,
  eventType,
  sequence,
  timestamp,
  payload,
});
const cite = (id: string, seq: number, address: string, at: number) =>
  evt(
    id,
    seq,
    "STEP_COMPLETED",
    {
      stepId: `s${seq}`,
      output: { __loomClaimCheck: true, ref: { __loomContent: address }, size: 1 },
    },
    at
  );

async function world(storeNow: number, logs: (refs: string[]) => EventEnvelope[][], blobs = 1) {
  const content = new InMemoryContentStore({ now: () => storeNow });
  const refs: string[] = [];
  for (let i = 0; i < blobs; i++) refs.push((await content.put(bytes(`blob ${i}`))).__loomContent);
  const store = new InMemoryAsyncEventStore();
  for (const log of logs(refs)) for (const e of log) await store.append(e);
  const sweep = (now: number, extra: object = {}) =>
    sweepUnpinnedContent({
      eventStores: [store],
      contentStore: content,
      pinnedEventTypes: ["FINDING_RECORDED"],
      snapshotStores: [{ loadLatest: async () => null, loadLatestBefore: async () => null }],
      olderThanMs: TTL,
      now,
      ...extra,
    });
  return { refs, sweep };
}

describe("keptByTouch / touchCutoff", () => {
  it("negative control: a store clock far ahead of the log clock refuses every erase, loudly", async () => {
    // Three blobs cited at log time 0; the content store stamps touches at 1000 days (wall clock under
    // a simulated log). Every ref is eligible by log time (now = 60d), none by store time.
    const w = await world(
      1000 * DAY,
      (refs) => [
        [evt("A", 0, "EXECUTION_STARTED", {}, 0), ...refs.map((r, i) => cite("A", i + 1, r, 0))],
      ],
      3
    );
    const dry = await w.sweep(60 * DAY, { dryRun: true });
    expect(dry.reclaimed).toHaveLength(3);
    expect(dry.keptByTouch).toBe(0);
    expect(dry.touchCutoff).toBe(970 * DAY);
    const real = await w.sweep(60 * DAY);
    expect(real.reclaimed).toEqual([]);
    expect(real.keptByTouch).toBe(3);
    expect(real.touchCutoff).toBe(970 * DAY);
  });

  it("the same world with a store on the log's clock erases everything and keeps nothing", async () => {
    const w = await world(
      0,
      (refs) => [
        [evt("A", 0, "EXECUTION_STARTED", {}, 0), ...refs.map((r, i) => cite("A", i + 1, r, 0))],
      ],
      3
    );
    const real = await w.sweep(60 * DAY, { touchedBefore: 30 * DAY });
    expect(real.reclaimed).toHaveLength(3);
    expect(real.keptByTouch).toBe(0);
    expect(real.touchCutoff).toBe(30 * DAY);
  });

  it("a store without deleteIfUntouchedSince: keptByTouch 0, touchCutoff absent", async () => {
    const inner = new InMemoryContentStore({ now: () => 0 });
    const ref = (await inner.put(bytes("x"))).__loomContent;
    const plain = {
      put: inner.put.bind(inner),
      get: inner.get.bind(inner),
      delete: inner.delete.bind(inner),
    };
    const es = new InMemoryAsyncEventStore();
    for (const e of [evt("A", 0, "EXECUTION_STARTED", {}, 0), cite("A", 1, ref, 0)]) {
      await es.append(e);
    }
    const r = await sweepUnpinnedContent({
      eventStores: [es],
      contentStore: plain as never,
      pinnedEventTypes: [],
      snapshotStores: [{ loadLatest: async () => null, loadLatestBefore: async () => null }],
      olderThanMs: TTL,
      now: 60 * DAY,
    });
    expect(r.raceSafe).toBe(false);
    expect(r.reclaimed).toEqual([ref]);
    expect(r.keptByTouch).toBe(0);
    expect("touchCutoff" in r).toBe(false);
  });
});

describe("refsOfReopened / reclaimedWhileReopened", () => {
  const reopenedLog = (ref: string): EventEnvelope[] => [
    evt("R", 0, "EXECUTION_STARTED", {}, 0),
    cite("R", 1, ref, 0),
    evt("R", 2, "EXECUTION_COMPLETED", {}, 20 * DAY),
    evt("R", 3, "EXECUTION_RESUMED", null, 21 * DAY),
    evt("R", 4, "EXECUTION_SUSPENDED", {}, 21 * DAY),
  ];
  const parkedLog = (ref: string): EventEnvelope[] => [
    evt("P", 0, "EXECUTION_STARTED", {}, 0),
    cite("P", 1, ref, 0),
    evt("P", 2, "EXECUTION_SUSPENDED", {}, 1 * DAY),
  ];
  const endedLog = (ref: string): EventEnvelope[] => [
    evt("E", 0, "EXECUTION_STARTED", {}, 0),
    cite("E", 1, ref, 0),
    evt("E", 2, "EXECUTION_COMPLETED", {}, 20 * DAY),
  ];

  it("a re-opened execution's reclaimable ref is counted and listed; parked and ended are not", async () => {
    const w = await world(
      0,
      (refs) => [
        reopenedLog(refs[0] as string),
        parkedLog(refs[1] as string),
        endedLog(refs[2] as string),
      ],
      3
    );
    const [reopenedRef, parkedRef, endedRef] = w.refs as [string, string, string];
    // now = 40d: reopened + parked reclaim on the citation clock (40d >= 30d); ended ages from d20 (20d < 30d).
    const dry = await w.sweep(40 * DAY, { dryRun: true, touchedBefore: 40 * DAY });
    expect(dry.refsOfReopened).toBe(1);
    expect(dry.reclaimedWhileReopened).toEqual([reopenedRef]);
    expect([...dry.reclaimed].sort()).toEqual([reopenedRef, parkedRef].sort());
    expect(dry.heldByEndClock).toEqual([endedRef]);
    // The erasing sweep makes the same decisions; only the dry-run list is absent.
    const real = await w.sweep(40 * DAY, { touchedBefore: 40 * DAY });
    expect(real.refsOfReopened).toBe(1);
    expect(real.reclaimedWhileReopened).toBeUndefined();
    expect(real.reclaimed).toEqual(dry.reclaimed);
  });

  it("counts a re-opened ref even when it is not yet reclaimable; the dry-run list stays empty", async () => {
    const w = await world(0, (refs) => [reopenedLog(refs[0] as string)]);
    const dry = await w.sweep(10 * DAY, { dryRun: true, touchedBefore: 10 * DAY });
    expect(dry.refsOfReopened).toBe(1);
    expect(dry.reclaimedWhileReopened).toEqual([]);
    expect(dry.reclaimed).toEqual([]);
  });

  it("a ref later cited by an ENDED execution leaves the re-opened set (newest effective citation wins)", async () => {
    const w = await world(0, (refs) => [
      reopenedLog(refs[0] as string),
      [
        evt("E", 0, "EXECUTION_STARTED", {}, 0),
        cite("E", 1, refs[0] as string, 25 * DAY),
        evt("E", 2, "EXECUTION_COMPLETED", {}, 26 * DAY),
      ],
    ]);
    const dry = await w.sweep(40 * DAY, { dryRun: true, touchedBefore: 40 * DAY });
    expect(dry.refsOfReopened).toBe(0);
    expect(dry.reclaimedWhileReopened).toEqual([]);
  });

  it("wasReopened: a table of tails (shares terminalEndOf's terminal set)", () => {
    const k = (types: string[], meta?: Record<string, unknown>) =>
      types.map((t, i) => ({ ...evt("X", i, t, {}, i), ...(meta && { metadata: meta }) }));
    expect(wasReopened(k(["EXECUTION_STARTED", "EXECUTION_COMPLETED"]))).toBe(false);
    expect(wasReopened(k(["EXECUTION_STARTED", "EXECUTION_SUSPENDED"]))).toBe(false);
    expect(wasReopened(k(["EXECUTION_STARTED", "EXECUTION_SUSPENDED", "EXECUTION_RESUMED"]))).toBe(
      false
    );
    expect(wasReopened(k(["EXECUTION_STARTED", "EXECUTION_FAILED", "EXECUTION_RESUMED"]))).toBe(
      true
    );
    expect(
      wasReopened(
        k(["EXECUTION_STARTED", "EXECUTION_CANCELLED", "EXECUTION_RESUMED", "EXECUTION_SUSPENDED"])
      )
    ).toBe(true);
    // unstamped CONTINUED is not terminal; a kernel-stamped one is
    expect(wasReopened(k(["EXECUTION_CONTINUED", "EXECUTION_RESUMED"]))).toBe(false);
    expect(wasReopened(k(["EXECUTION_CONTINUED", "EXECUTION_RESUMED"], { kernel: true }))).toBe(
      true
    );
  });
});
