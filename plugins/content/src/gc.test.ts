import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { ReplayVM } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { type ContentSweepOptions, pinByEventKinds, sweepUnpinnedContent } from "./gc";
import {
  ContentMissingError,
  ContentResolvingEventStore,
  InMemoryContentStore,
  contentAddress,
} from "./index";

/** The ADR 0054 claim-check envelope shape (structural — no middleware dep). */
interface ClaimCheckEnvelope {
  __loomClaimCheck: true;
  ref: { __loomContent: string };
  size: number;
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * These fixtures cite blobs at fabricated times (days since the epoch). SPI 1.3.0 stores
 * stamp a touch time on `put`, and the sweep only erases a blob untouched since its cutoff,
 * so the blobs must be put BEFORE their citations: at the epoch, not at today's wall clock.
 */
const storedAtEpoch = (): InMemoryContentStore => new InMemoryContentStore({ now: () => 1 });

/**
 * These fixtures run the log and the store on ONE fabricated clock, so the guard cutoff on
 * the store's clock is the TTL cutoff on the log's (ADR 0055 D5 keeps the two apart).
 */
const sweepOneClock = (options: ContentSweepOptions) =>
  sweepUnpinnedContent({ touchedBefore: options.now - options.olderThanMs, ...options });

function envelopeFor(address: string): ClaimCheckEnvelope {
  return { __loomClaimCheck: true, ref: { __loomContent: address }, size: 1 };
}

function evt(
  executionId: string,
  sequence: number,
  eventType: string,
  payload: unknown,
  timestamp: number
): EventEnvelope {
  return {
    id: `${executionId}-${sequence}`,
    workflowId: "wf",
    executionId,
    eventType,
    sequence,
    timestamp,
    payload,
  };
}

async function fixture() {
  const content = storedAtEpoch();
  const evidence = await content.put(bytes("EXPLAIN plan — the finding's evidence"));
  const staleTelemetry = await content.put(bytes("pg_stat sample, month 1"));
  const freshTelemetry = await content.put(bytes("pg_stat sample, today"));

  // Live store: a telemetry wake citing old + fresh samples (nested payloads).
  const live = new InMemoryAsyncEventStore();
  await live.append(
    evt(
      "wake-2",
      0,
      "STEP_COMPLETED",
      { stepId: "read", output: envelopeFor(staleTelemetry.__loomContent) },
      NOW - 40 * DAY
    )
  );
  await live.append(
    evt(
      "wake-2",
      1,
      "STEP_COMPLETED",
      { stepId: "read2", output: { samples: [envelopeFor(freshTelemetry.__loomContent)] } },
      NOW - 1 * DAY
    )
  );

  // Archive store: the month-1 run, already archived (K10.1), carrying the finding.
  const archive = new InMemoryAsyncEventStore();
  await archive.append(
    evt(
      "wake-1",
      0,
      "FINDING_RECORDED",
      { severity: "high", evidence: [envelopeFor(evidence.__loomContent)] },
      NOW - 90 * DAY
    )
  );

  return { content, live, archive, evidence, staleTelemetry, freshTelemetry };
}

describe("sweepUnpinnedContent (K10.6, ADR 0055)", () => {
  it("reclaims stale unpinned telemetry; finding-cited evidence survives archival, hash-verifiable", async () => {
    const f = await fixture();
    const report = await sweepOneClock({
      eventStores: [f.live, f.archive],
      contentStore: f.content,
      pinnedEventTypes: ["FINDING_RECORDED"],
      olderThanMs: 30 * DAY,
      now: NOW,
    });

    // Stale telemetry gone; fresh telemetry (within TTL) and pinned evidence kept.
    expect(report.reclaimed).toEqual([f.staleTelemetry.__loomContent]);
    expect(report.refsSeen).toBe(3);
    expect(report.refsPinned).toBe(1);
    expect(await f.content.get(f.staleTelemetry)).toBeNull();
    expect(await f.content.get(f.freshTelemetry)).not.toBeNull();

    // The acceptance criterion: the archived month-1 finding's evidence resolves
    // byte-for-byte against its recorded content address.
    const got = await f.content.get(f.evidence);
    expect(got).not.toBeNull();
    expect(contentAddress(got as Uint8Array)).toBe(f.evidence.__loomContent);
  });

  it("pins survive repeated sweeps (mark-and-sweep re-derives from the log)", async () => {
    const f = await fixture();
    const opts = {
      eventStores: [f.live, f.archive],
      contentStore: f.content,
      pinnedEventTypes: ["FINDING_RECORDED"],
      olderThanMs: 30 * DAY,
    };
    await sweepOneClock({ ...opts, now: NOW });
    const second = await sweepOneClock({ ...opts, now: NOW + 300 * DAY });
    // Fresh telemetry aged out by the later sweep; evidence STILL pinned. (An
    // already-reclaimed ref may be re-reported — delete is idempotent.)
    expect(second.reclaimed).toContain(f.freshTelemetry.__loomContent);
    expect(second.reclaimed).not.toContain(f.evidence.__loomContent);
    expect(await f.content.get(f.freshTelemetry)).toBeNull();
    expect(await f.content.get(f.evidence)).not.toBeNull();
  });

  it("pins BARE ContentRefs cited by pinned events (a finding's evidence list)", async () => {
    const content = storedAtEpoch();
    const plan = await content.put(bytes("EXPLAIN output"));
    const store = new InMemoryAsyncEventStore();
    // Evidence cited as a bare ADR 0046 ref — no claim-check envelope wrapper.
    await store.append(
      evt("run-1", 0, "FINDING_RECORDED", { evidence: [{ __loomContent: plan.__loomContent }] }, 1)
    );
    const report = await sweepOneClock({
      eventStores: [store],
      contentStore: content,
      pinnedEventTypes: ["FINDING_RECORDED"],
      olderThanMs: 0,
      now: NOW,
    });
    expect(report.refsPinned).toBe(1);
    expect(report.reclaimed).toEqual([]);
    expect(await content.get(plan)).not.toBeNull();
  });

  it("refuses a store that cannot be enumerated (under-pinning is destructive)", async () => {
    const f = await fixture();
    const blind = { read: f.live.read.bind(f.live), listExecutions: undefined };
    await expect(
      sweepOneClock({
        eventStores: [blind],
        contentStore: f.content,
        pinnedEventTypes: [],
        olderThanMs: 0,
        now: NOW,
      })
    ).rejects.toThrow(/listExecutions/);
  });
});

describe("pinByEventKinds (K10.6 execution-level predicate)", () => {
  it("pins executions whose log carries a designated event kind", async () => {
    const f = await fixture();
    const pinned = pinByEventKinds(f.archive, ["FINDING_RECORDED"]);
    expect(await pinned("wake-1")).toBe(true);
    expect(await pinned("wake-2")).toBe(false); // not in this store → no events → unpinned
    const livePinned = pinByEventKinds(f.live, ["FINDING_RECORDED"]);
    expect(await livePinned("wake-2")).toBe(false); // telemetry only, no findings
  });
});

describe("refs inside arrays (#260)", () => {
  it("marks refs held in array elements — pinning and reclaiming both depend on it", async () => {
    // Externalizing a `docs[].body` path puts refs INSIDE an array for the first time
    // (ADR 0076). The mark phase must see through the array or it would orphan live blobs.
    // Both citations are older than the TTL, so retention here rests ENTIRELY on the walk
    // finding them — a sweep that never looked inside the array would reclaim `a`/`b` too.
    const content = storedAtEpoch();
    const a = await content.put(bytes("body A"));
    const b = await content.put(bytes("body B"));
    const stale = await content.put(bytes("an old telemetry sample"));

    const OLD = NOW - 300 * DAY;
    const events = new InMemoryAsyncEventStore();
    await events.append(
      evt("e1", 0, "STEP_COMPLETED", { output: { docs: [{ body: a }, { body: b }] } }, OLD)
    );
    // The control is claim-checked: since ADR 0055 D4 only an envelope-held ref is
    // TTL-reclaimable (a bare one is load-bearing), so an enveloped ref inside an array
    // is the thing that must be found AND reclaimed.
    await events.append(
      evt("e1", 1, "TELEMETRY", { samples: [{ blob: envelopeFor(stale.__loomContent) }] }, OLD)
    );

    const report = await sweepOneClock({
      eventStores: [events],
      contentStore: content,
      pinnedEventTypes: ["STEP_COMPLETED"],
      olderThanMs: 30 * DAY,
      now: NOW,
    });

    // Pinned through the array crossing.
    expect(await content.get(a)).not.toBeNull();
    expect(await content.get(b)).not.toBeNull();
    // And the control: an unpinned ref inside an array IS found, and is reclaimed.
    expect(report.reclaimed).toContain(stale.__loomContent);
    expect(await content.get(stale)).toBeNull();
  });
});

describe("load-bearing (bare) refs are never TTL-reclaimed (ADR 0055 D4)", () => {
  const TTL = 30 * DAY;
  const OLD = NOW - 60 * DAY;

  it("the probe: an ADR 0046 externalized output of a live execution survives, and the execution still reads", async () => {
    const content = storedAtEpoch();
    const raw = new InMemoryAsyncEventStore();
    const store = new ContentResolvingEventStore(raw, content, {
      externalize: { STEP_COMPLETED: ["output"] },
    });
    await store.append(evt("perpetual", 0, "EXECUTION_STARTED", { input: {} }, OLD));
    await store.append(
      evt("perpetual", 1, "STEP_COMPLETED", { stepId: "read", output: { rows: [1, 2, 3] } }, OLD)
    );
    // Still running: no terminal event. The raw log holds a BARE ref at `output`.

    const report = await sweepOneClock({
      eventStores: [raw],
      contentStore: content,
      pinnedEventTypes: ["FINDING_RECORDED"],
      olderThanMs: TTL,
      now: NOW,
    });

    expect(report.reclaimed).toEqual([]);
    expect(report.refsSeen).toBe(1);
    expect(report.refsLoadBearing).toBe(1);
    expect(report.refsPinned).toBe(0);
    const events = await store.read("perpetual");
    expect((events[1]?.payload as { output: unknown }).output).toEqual({ rows: [1, 2, 3] });
  });

  it("negative: the TTL rule is not turned off — an envelope-only ref of the same age IS reclaimed", async () => {
    const content = storedAtEpoch();
    const telemetry = await content.put(bytes("pg_stat sample"));
    const store = new InMemoryAsyncEventStore();
    await store.append(
      evt(
        "wake",
        0,
        "STEP_COMPLETED",
        { stepId: "read", output: envelopeFor(telemetry.__loomContent) },
        OLD
      )
    );

    const report = await sweepOneClock({
      eventStores: [store],
      contentStore: content,
      pinnedEventTypes: ["FINDING_RECORDED"],
      olderThanMs: TTL,
      now: NOW,
    });

    expect(report.reclaimed).toEqual([telemetry.__loomContent]);
    expect(report.refsLoadBearing).toBe(0);
    expect(await content.get(telemetry)).toBeNull();
  });

  it("a ref cited both bare and inside an envelope survives (the bare citation wins)", async () => {
    const content = storedAtEpoch();
    const both = await content.put(bytes("cited two ways"));
    const store = new InMemoryAsyncEventStore();
    await store.append(
      evt("e", 0, "STEP_COMPLETED", { output: envelopeFor(both.__loomContent) }, OLD)
    );
    await store.append(
      evt("e", 1, "STEP_COMPLETED", { other: { __loomContent: both.__loomContent } }, OLD)
    );

    const report = await sweepOneClock({
      eventStores: [store],
      contentStore: content,
      pinnedEventTypes: [],
      olderThanMs: TTL,
      now: NOW,
    });

    expect(report.reclaimed).toEqual([]);
    expect(report.refsLoadBearing).toBe(1);
    expect(await content.get(both)).not.toBeNull();
  });

  it("one ref OBJECT aliased inside an envelope and bare in one payload is still load-bearing", async () => {
    // An in-memory store keeps payloads by reference, so one object can sit at two sites.
    // The walk pops the envelope first (LIFO over `{ bare, wrapped }`); had the envelope's ref
    // gone through the cycle guard, the bare site would then be skipped and a load-bearing
    // blob reclaimed.
    const content = storedAtEpoch();
    const shared = await content.put(bytes("aliased"));
    const ref = { __loomContent: shared.__loomContent };
    const store = new InMemoryAsyncEventStore();
    await store.append(
      evt(
        "e",
        0,
        "STEP_COMPLETED",
        { bare: ref, wrapped: { __loomClaimCheck: true, ref, size: 1 } },
        OLD
      )
    );

    const report = await sweepOneClock({
      eventStores: [store],
      contentStore: content,
      pinnedEventTypes: [],
      olderThanMs: TTL,
      now: NOW,
    });

    expect(report.reclaimed).toEqual([]);
    expect(report.refsLoadBearing).toBe(1);
    expect(await content.get(shared)).not.toBeNull();
  });

  it("terminates on a cycle that runs through an envelope's digest, and on a very deep payload (audit W8)", async () => {
    const content = storedAtEpoch();
    const blob = await content.put(bytes("in a cycle"));
    const offloaded = await content.put(bytes("offloaded"));
    // root → envelope.digest → root: the cycle crosses the envelope, which is walked
    // in the parent's context everywhere but its `ref`.
    const root: Record<string, unknown> = { ref: { __loomContent: blob.__loomContent } };
    root.wrapped = {
      __loomClaimCheck: true,
      ref: { __loomContent: offloaded.__loomContent },
      size: 1,
      digest: { back: root },
    };
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 100_000; i++) deep = { next: deep };
    const store = new InMemoryAsyncEventStore();
    await store.append(evt("c", 0, "STEP_COMPLETED", { root, deep }, OLD));

    const report = await sweepOneClock({
      eventStores: [store],
      contentStore: content,
      pinnedEventTypes: [],
      olderThanMs: TTL,
      now: NOW,
    });
    expect(report.refsLoadBearing).toBe(1);
    expect(report.reclaimed).toEqual([offloaded.__loomContent]);
  });

  it("a ref inside an envelope's DIGEST stays load-bearing — the digest is replay-visible", async () => {
    // Only `envelope.ref` is the offloaded value; the digest is recorded, branched on by
    // orchestration and resolved on read, so a ref inside it is as load-bearing as any bare one.
    const content = storedAtEpoch();
    const offloaded = await content.put(bytes("the big result"));
    const inDigest = await content.put(bytes("cited from the digest"));
    const store = new InMemoryAsyncEventStore();
    await store.append(
      evt(
        "d",
        0,
        "STEP_COMPLETED",
        {
          output: {
            __loomClaimCheck: true,
            ref: { __loomContent: offloaded.__loomContent },
            size: 1,
            digest: { top: [{ __loomContent: inDigest.__loomContent }] },
          },
        },
        OLD
      )
    );

    const report = await sweepOneClock({
      eventStores: [store],
      contentStore: content,
      pinnedEventTypes: [],
      olderThanMs: TTL,
      now: NOW,
    });
    expect(report.reclaimed).toEqual([offloaded.__loomContent]);
    expect(report.refsLoadBearing).toBe(1);
    expect(await content.get(inDigest)).not.toBeNull();
  });

  it("an object merely carrying the flag is not an envelope — its bare refs stay load-bearing", async () => {
    // The envelope check is structural, exactly `isClaimCheck`: the flag AND a string
    // `ref.__loomContent`. Anything less is app data, and its refs are bare.
    const content = storedAtEpoch();
    const a = await content.put(bytes("flag, no ref"));
    const b = await content.put(bytes("flag, ref not a ContentRef"));
    const store = new InMemoryAsyncEventStore();
    await store.append(
      evt(
        "f",
        0,
        "STEP_COMPLETED",
        {
          one: { __loomClaimCheck: true, items: [{ __loomContent: a.__loomContent }] },
          two: { __loomClaimCheck: true, ref: { nested: { __loomContent: b.__loomContent } } },
        },
        OLD
      )
    );

    const report = await sweepOneClock({
      eventStores: [store],
      contentStore: content,
      pinnedEventTypes: [],
      olderThanMs: TTL,
      now: NOW,
    });
    expect(report.reclaimed).toEqual([]);
    expect(report.refsLoadBearing).toBe(2);
  });

  it("a bare ref an app emits itself is retained too — the sweep cannot tell it from an externalized one", async () => {
    // Composed under a ContentResolvingEventStore, EVERY bare ref in a read is resolved (not only
    // the configured paths), so reclaiming it throws ContentMissingError on the next read.
    const content = storedAtEpoch();
    const raw = new InMemoryAsyncEventStore();
    const store = new ContentResolvingEventStore(raw, content, { externalize: {} });
    const draft = await content.put(bytes(JSON.stringify({ widgets: [] })));
    await store.append(evt("v", 0, "VIEW_DRAFTED", { ref: draft }, OLD));

    const report = await sweepOneClock({
      eventStores: [raw],
      contentStore: content,
      pinnedEventTypes: [],
      olderThanMs: TTL,
      now: NOW,
    });
    expect(report.reclaimed).toEqual([]);
    await expect(store.read("v")).resolves.toHaveLength(1);

    // The hazard the retention prevents, shown directly: erase it and the read fails loudly.
    await content.delete(draft);
    await expect(store.read("v")).rejects.toBeInstanceOf(ContentMissingError);
  });
});

// ── ADR 0055 D5–D7 — the re-cite race, orphans, external root sets ─────────────
describe("race-safe sweep, orphan reclamation, external root sets (ADR 0055 D5–D7)", () => {
  const TTL = 30 * DAY;
  const OLD = NOW - 60 * DAY;

  /** A store whose clock the test moves: touch times are the STORE's, as in production. */
  /** A snapshot store holding nothing — for scans over logs nothing compacted. */
  const NO_SNAPSHOTS = { loadLatest: async () => null, loadLatestBefore: async () => null };

  function clockedStore(start: number) {
    const clock = { now: start };
    const content = new InMemoryContentStore({ now: () => clock.now });
    return { clock, content };
  }

  /**
   * An event store whose `read` runs `during` right after the scan reads `executionId` —
   * the concurrent work a real sweep's mark window overlaps with.
   */
  function racing(
    inner: InMemoryAsyncEventStore,
    executionId: string,
    during: () => Promise<void>
  ): InMemoryAsyncEventStore {
    const read = inner.read.bind(inner);
    return Object.assign(Object.create(inner) as InMemoryAsyncEventStore, {
      read: async (id: string) => {
        const events = await read(id);
        if (id === executionId) await during();
        return events;
      },
    });
  }

  it("the re-cite race: a put of a 60-day-old blob's bytes during the mark window keeps the blob", async () => {
    const { clock, content } = clockedStore(OLD);
    const report = bytes("EXPLAIN — unchanged since month 1");
    const ref = await content.put(report);
    const live = new InMemoryAsyncEventStore();
    await live.append(
      evt("old-run", 0, "STEP_COMPLETED", { output: envelopeFor(ref.__loomContent) }, OLD)
    );

    // A new execution re-fetches the unchanged report: its `put` dedups to the same ref, and
    // the sweep's scan has already passed the only (60-day-old) citation. Its STEP_COMPLETED
    // append lands after the sweep.
    clock.now = NOW; // the store's clock when the sweep starts
    const store = racing(live, "old-run", async () => {
      clock.now = NOW + 1;
      const again = await content.put(report);
      expect(again.__loomContent).toBe(ref.__loomContent);
    });
    const result = await sweepUnpinnedContent({
      eventStores: [store],
      contentStore: content,
      pinnedEventTypes: [],
      olderThanMs: TTL,
      now: NOW,
    });
    await live.append(
      evt("new-run", 0, "STEP_COMPLETED", { output: envelopeFor(ref.__loomContent) }, NOW)
    );

    expect(await content.get(ref)).not.toBeNull(); // the new run's result still resolves
    expect(result.reclaimed).toEqual([]);
    expect(result.raceSafe).toBe(true);
  });

  it("the fallback is honest: over a store without the conditional delete the race still loses the blob, and the report says raceSafe: false", async () => {
    const { clock, content } = clockedStore(OLD);
    const report = bytes("EXPLAIN — unchanged since month 1");
    const ref = await content.put(report);
    const live = new InMemoryAsyncEventStore();
    await live.append(
      evt("old-run", 0, "STEP_COMPLETED", { output: envelopeFor(ref.__loomContent) }, OLD)
    );
    clock.now = NOW;
    const store = racing(live, "old-run", async () => {
      clock.now = NOW + 1;
      await content.put(report);
    });
    const result = await sweepUnpinnedContent({
      eventStores: [store],
      contentStore: { delete: (r) => content.delete(r) }, // SPI 1.2.0 surface only
      pinnedEventTypes: [],
      olderThanMs: TTL,
      now: NOW,
    });
    expect(result.raceSafe).toBe(false);
    expect(result.reclaimed).toEqual([ref.__loomContent]);
    expect(await content.get(ref)).toBeNull();
  });

  it("negative: the guard is not a no-op — a genuinely stale envelope blob IS still deleted", async () => {
    const { clock, content } = clockedStore(OLD);
    const stale = await content.put(bytes("pg_stat sample, month 1"));
    clock.now = NOW;
    const live = new InMemoryAsyncEventStore();
    await live.append(
      evt("run", 0, "STEP_COMPLETED", { output: envelopeFor(stale.__loomContent) }, OLD)
    );
    const result = await sweepUnpinnedContent({
      eventStores: [live],
      contentStore: content,
      pinnedEventTypes: [],
      olderThanMs: TTL,
      now: NOW,
    });
    expect(result.raceSafe).toBe(true);
    expect(result.reclaimed).toEqual([stale.__loomContent]);
    expect(await content.get(stale)).toBeNull();
  });

  it("orphans: a deleted execution's blob (no archive) and a put-then-crash blob are reclaimed after the TTL, and only with reclaimOrphans", async () => {
    const { clock, content } = clockedStore(OLD);
    const ofDeleted = await content.put(bytes("output of a run retention deleted"));
    const crashed = await content.put(bytes("put, then the process died before the append"));
    const citedBare = await content.put(bytes("externalized output, still cited"));
    clock.now = NOW - 1 * DAY;
    const inFlight = await content.put(bytes("put a moment ago, append not landed yet"));
    clock.now = NOW;

    const live = new InMemoryAsyncEventStore();
    await live.append(
      evt("gone", 0, "STEP_COMPLETED", { output: envelopeFor(ofDeleted.__loomContent) }, OLD)
    );
    await live.append(evt("kept", 0, "EXECUTION_STARTED", { input: {} }, OLD));
    await live.append(evt("kept", 1, "STEP_COMPLETED", { output: citedBare }, OLD));
    await live.deleteExecution("gone"); // applyRetention with no archive configured

    const base = {
      eventStores: [live],
      snapshotStores: [NO_SNAPSHOTS],
      contentStore: content,
      pinnedEventTypes: [],
      olderThanMs: TTL,
      now: NOW,
    };
    const without = await sweepUnpinnedContent(base);
    expect(without.orphansReclaimed).toEqual([]);
    expect(await content.get(ofDeleted)).not.toBeNull(); // the pre-D6 leak: never reclaimed

    const dry = await sweepUnpinnedContent({ ...base, reclaimOrphans: true, dryRun: true });
    expect(new Set(dry.orphansReclaimed)).toEqual(
      new Set([ofDeleted.__loomContent, crashed.__loomContent])
    );
    expect(await content.get(ofDeleted)).not.toBeNull(); // dry run deletes nothing

    const swept = await sweepUnpinnedContent({ ...base, reclaimOrphans: true });
    expect(new Set(swept.orphansReclaimed)).toEqual(
      new Set([ofDeleted.__loomContent, crashed.__loomContent])
    );
    expect(swept.reclaimed).toEqual([]);
    expect(await content.get(ofDeleted)).toBeNull();
    expect(await content.get(crashed)).toBeNull();
    expect(await content.get(citedBare)).not.toBeNull(); // cited (load-bearing) — not an orphan
    expect(await content.get(inFlight)).not.toBeNull(); // younger than the TTL — may be in flight
  });

  it("an external root set pins a blob through BOTH passes — an app table the log never sees", async () => {
    const { clock, content } = clockedStore(OLD);
    const onlyInAppTable = await content.put(bytes("a saved dashboard's frozen snapshot"));
    const alsoEnveloped = await content.put(bytes("a claim-checked result an app table kept"));
    clock.now = NOW;
    const live = new InMemoryAsyncEventStore();
    await live.append(evt("run", 0, "EXECUTION_STARTED", { input: {} }, OLD));
    await live.append(
      evt("run", 1, "STEP_COMPLETED", { output: envelopeFor(alsoEnveloped.__loomContent) }, OLD)
    );
    let rootReads = 0;
    // What a Postgres app would yield from e.g. `SELECT hash FROM experience_refs`.
    async function* roots(): AsyncGenerator<string> {
      rootReads++;
      yield onlyInAppTable.__loomContent;
      yield alsoEnveloped.__loomContent;
    }
    const result = await sweepUnpinnedContent({
      eventStores: [live],
      contentStore: content,
      pinnedEventTypes: [],
      olderThanMs: TTL,
      now: NOW,
      roots,
      reclaimOrphans: true,
      snapshotStores: [NO_SNAPSHOTS],
    });
    expect(rootReads).toBe(1);
    expect(result.reclaimed).toEqual([]);
    expect(result.orphansReclaimed).toEqual([]);
    expect(await content.get(onlyInAppTable)).not.toBeNull();
    expect(await content.get(alsoEnveloped)).not.toBeNull();
  });

  it("the orphan pass pages through a store larger than one page, deleting as it goes", async () => {
    const { clock, content } = clockedStore(OLD);
    for (let i = 0; i < 1_250; i++) await content.put(bytes(`orphan-${i}`));
    clock.now = NOW;
    const result = await sweepUnpinnedContent({
      eventStores: [new InMemoryAsyncEventStore()],
      snapshotStores: [NO_SNAPSHOTS],
      contentStore: content,
      pinnedEventTypes: [],
      olderThanMs: TTL,
      now: NOW,
      reclaimOrphans: true,
    });
    expect(result.orphansReclaimed).toHaveLength(1_250);
    expect(new Set(result.orphansReclaimed).size).toBe(1_250);
    expect(content.size).toBe(0);
  });

  it("reclaimOrphans refuses a store that cannot enumerate (listPage) or conditionally delete", async () => {
    const { content } = clockedStore(OLD);
    const blob = await content.put(bytes("never touched by a refused sweep"));
    const base = {
      eventStores: [new InMemoryAsyncEventStore()],
      snapshotStores: [NO_SNAPSHOTS],
      pinnedEventTypes: [],
      olderThanMs: TTL,
      now: NOW,
      reclaimOrphans: true,
    };
    await expect(
      sweepUnpinnedContent({
        ...base,
        contentStore: {
          delete: (r) => content.delete(r),
          deleteIfUntouchedSince: (r, c) => content.deleteIfUntouchedSince(r, c),
        },
      })
    ).rejects.toThrow(/listPage/);
    await expect(
      sweepUnpinnedContent({
        ...base,
        contentStore: {
          delete: (r) => content.delete(r),
          listPage: (o) => content.listPage(o),
        },
      })
    ).rejects.toThrow(/deleteIfUntouchedSince/);
    expect(await content.get(blob)).not.toBeNull();
  });

  it("two clocks: a caller `now` far ahead of the store's clock does not disarm the guard", async () => {
    // Log time (a simulated year, a replayed archive) and the store's clock differ. The TTL is
    // measured on the log; the race guard on the store's own clock.
    const { clock, content } = clockedStore(OLD);
    const report = bytes("EXPLAIN — unchanged");
    const ref = await content.put(report);
    const live = new InMemoryAsyncEventStore();
    await live.append(
      evt("old-run", 0, "STEP_COMPLETED", { output: envelopeFor(ref.__loomContent) }, OLD)
    );
    clock.now = NOW;
    const store = racing(live, "old-run", async () => {
      clock.now = NOW + 1;
      await content.put(report); // re-cited by a run whose append has not landed
    });
    const result = await sweepUnpinnedContent({
      eventStores: [store],
      contentStore: content,
      pinnedEventTypes: [],
      olderThanMs: TTL,
      now: NOW + 1_000 * DAY, // the caller's log-time instant, far ahead of the store
    });
    expect(await content.get(ref)).not.toBeNull();
    expect(result.reclaimed).toEqual([]);
  });

  it("an explicit touchedBefore is the guard cutoff; a 1.3.0 store with neither it nor touchClock is refused", async () => {
    const { clock, content } = clockedStore(OLD);
    const stale = await content.put(bytes("old telemetry"));
    clock.now = NOW;
    const live = new InMemoryAsyncEventStore();
    await live.append(
      evt("run", 0, "STEP_COMPLETED", { output: envelopeFor(stale.__loomContent) }, OLD)
    );
    const base = { eventStores: [live], pinnedEventTypes: [], olderThanMs: TTL, now: NOW };
    const noClock = {
      delete: (r: { __loomContent: string }) => content.delete(r),
      deleteIfUntouchedSince: (r: { __loomContent: string }, c: number) =>
        content.deleteIfUntouchedSince(r, c),
    };
    await expect(sweepUnpinnedContent({ ...base, contentStore: noClock })).rejects.toThrow(
      /touchedBefore|touchClock/
    );
    expect(await content.get(stale)).not.toBeNull();
    // An explicit cutoff BEFORE the blob's touch time keeps it; one after it erases it.
    const kept = await sweepUnpinnedContent({
      ...base,
      contentStore: noClock,
      touchedBefore: OLD,
    });
    expect(kept.reclaimed).toEqual([]);
    const erased = await sweepUnpinnedContent({
      ...base,
      contentStore: noClock,
      touchedBefore: OLD + 1,
    });
    expect(erased.reclaimed).toEqual([stale.__loomContent]);
  });

  it("a touch time of 0 is UNKNOWN (a pre-1.3.0 writer's default) — never orphan-eligible", async () => {
    const { clock, content } = clockedStore(0);
    const unknown = await content.put(bytes("written by an old-version process"));
    clock.now = NOW;
    const result = await sweepUnpinnedContent({
      eventStores: [new InMemoryAsyncEventStore()],
      snapshotStores: [NO_SNAPSHOTS],
      contentStore: content,
      pinnedEventTypes: [],
      olderThanMs: TTL,
      now: NOW,
      reclaimOrphans: true,
    });
    expect(result.orphansReclaimed).toEqual([]);
    expect(await content.get(unknown)).not.toBeNull();
  });

  describe("compaction (LogLifecycle.compact folds the prefix into a snapshot)", () => {
    /** A real compaction: fold, checkpoint at the tip, truncate the prefix (seq 0 stays). */
    async function compacted(content: InMemoryContentStore) {
      const evidence = await content.put(bytes("EXPLAIN — the finding's evidence"));
      const live = new InMemoryAsyncEventStore();
      const events = [
        evt("perpetual", 0, "EXECUTION_STARTED", { input: {} }, OLD),
        evt("perpetual", 1, "STEP_STARTED", { stepId: "explain" }, OLD),
        evt(
          "perpetual",
          2,
          "STEP_COMPLETED",
          { stepId: "explain", output: envelopeFor(evidence.__loomContent) },
          OLD
        ),
        evt("perpetual", 3, "FINDING_RECORDED", { evidence: [evidence] }, OLD),
      ];
      for (const e of events) await live.append(e);
      const snapshots = new Map<string, { sequence: number; state: unknown }>();
      snapshots.set("perpetual", { sequence: 3, state: new ReplayVM(events).getState() });
      await live.truncatePrefix("perpetual", 3);
      expect((await live.read("perpetual")).map((e) => e.sequence)).toEqual([0]);
      const snapshotStore = {
        loadLatest: async (id: string) => snapshots.get(id) ?? null,
        loadLatestBefore: async (id: string, at: number) => {
          const found = snapshots.get(id);
          return found !== undefined && found.sequence <= at ? found : null;
        },
      };
      return { evidence, live, snapshotStore };
    }

    it("the orphan pass keeps a blob only the compaction snapshot still cites", async () => {
      const { clock, content } = clockedStore(OLD);
      const { evidence, live, snapshotStore } = await compacted(content);
      clock.now = NOW;
      const result = await sweepUnpinnedContent({
        eventStores: [live],
        snapshotStores: [snapshotStore],
        contentStore: content,
        pinnedEventTypes: ["FINDING_RECORDED"],
        olderThanMs: TTL,
        now: NOW,
        reclaimOrphans: true,
      });
      expect(await content.get(evidence)).not.toBeNull();
      expect(result.orphansReclaimed).toEqual([]);
      expect(result.reclaimed).toEqual([]);
    });

    it("without snapshotStores, the orphan pass over a store that can truncate is REFUSED (fail closed)", async () => {
      const { clock, content } = clockedStore(OLD);
      const { evidence, live } = await compacted(content);
      clock.now = NOW;
      await expect(
        sweepUnpinnedContent({
          eventStores: [live],
          contentStore: content,
          pinnedEventTypes: ["FINDING_RECORDED"],
          olderThanMs: TTL,
          now: NOW,
          reclaimOrphans: true,
        })
      ).rejects.toThrow(/snapshotStores/);
      expect(await content.get(evidence)).not.toBeNull();
    });

    it("a log with a compaction gap but no snapshot anywhere is refused too, before any erase", async () => {
      const { clock, content } = clockedStore(OLD);
      const stale = await content.put(bytes("stale telemetry"));
      const gapped = {
        read: async () => [
          evt("x", 0, "EXECUTION_STARTED", { input: {} }, OLD),
          evt(
            "x",
            7,
            "STEP_COMPLETED",
            { stepId: "s", output: envelopeFor(stale.__loomContent) },
            OLD
          ),
        ],
        listExecutions: async () => ["x"],
      };
      clock.now = NOW;
      await expect(
        sweepUnpinnedContent({
          eventStores: [gapped],
          snapshotStores: [NO_SNAPSHOTS],
          contentStore: content,
          pinnedEventTypes: [],
          olderThanMs: TTL,
          now: NOW,
          reclaimOrphans: true,
        })
      ).rejects.toThrow(/compact/);
      expect(await content.get(stale)).not.toBeNull(); // the TTL pass did not run either
    });

    /** Fold → checkpoint at the tip → truncate, exactly as LogLifecycle.compact does. */
    async function compact(
      live: InMemoryAsyncEventStore,
      snapshots: InMemoryAsyncSnapshotStore,
      id: string,
      folded: EventEnvelope[]
    ): Promise<void> {
      const tip = (folded[folded.length - 1] as EventEnvelope).sequence;
      await snapshots.save({
        id: `cp-${id}-${tip}`,
        executionId: id,
        workflowId: "wf",
        sequence: tip,
        state: new ReplayVM(folded).getState(),
        createdAt: 0,
      });
      await live.truncatePrefix(id, tip);
    }

    it("pins the COMPACTION checkpoint, not just the latest snapshot — fork() between them still resolves", async () => {
      const { clock, content } = clockedStore(OLD);
      const prefixOutput = await content.put(bytes("step output from the compacted prefix"));
      const live = new InMemoryAsyncEventStore();
      const snapshots = new InMemoryAsyncSnapshotStore();
      const prefix = [
        evt("loop", 0, "EXECUTION_STARTED", { input: {} }, OLD),
        evt("loop", 1, "STEP_STARTED", { stepId: "poll" }, OLD),
        evt(
          "loop",
          2,
          "STEP_COMPLETED",
          { stepId: "poll", output: envelopeFor(prefixOutput.__loomContent) },
          OLD
        ),
      ];
      for (const e of prefix) await live.append(e);
      await compact(live, snapshots, "loop", prefix); // checkpoint at 2; log is [0]
      // The loop runs again: the same step id's output is OVERWRITTEN in state, and a later
      // snapshot (a suspend) no longer holds the prefix ref.
      const suffix = [
        evt("loop", 3, "STEP_STARTED", { stepId: "poll" }, NOW - 2 * DAY),
        evt("loop", 4, "STEP_COMPLETED", { stepId: "poll", output: { rows: 0 } }, NOW - 2 * DAY),
      ];
      for (const e of suffix) await live.append(e);
      await snapshots.save({
        id: "later",
        executionId: "loop",
        workflowId: "wf",
        sequence: 4,
        state: new ReplayVM([...prefix, ...suffix]).getState(),
        createdAt: 0,
      });
      expect(JSON.stringify((await snapshots.loadLatest("loop"))?.state)).not.toContain(
        prefixOutput.__loomContent
      );

      clock.now = NOW;
      await sweepUnpinnedContent({
        eventStores: [live],
        snapshotStores: [snapshots],
        contentStore: content,
        pinnedEventTypes: [],
        olderThanMs: TTL,
        now: NOW,
        reclaimOrphans: true,
      });
      expect(await content.get(prefixOutput)).not.toBeNull();
      // fork() at 3 loads the checkpoint (loadLatestBefore) and folds on: the ref must resolve.
      const base = await snapshots.loadLatestBefore("loop", 3);
      expect(base?.sequence).toBe(2);
      const output = (base?.state as { frames: Record<string, { output: ClaimCheckEnvelope }> })
        .frames.poll?.output;
      expect(await content.get(output?.ref as { __loomContent: string })).not.toBeNull();
    });

    it("a run compacted at its tip (only sequence 0 left) with no snapshot found is uncovered — refused", async () => {
      const { clock, content } = clockedStore(OLD);
      const output = await content.put(bytes("a finished run's step output"));
      const live = new InMemoryAsyncEventStore();
      const done = [
        evt("done", 0, "EXECUTION_STARTED", { input: {} }, OLD),
        evt("done", 1, "STEP_STARTED", { stepId: "s" }, OLD),
        evt(
          "done",
          2,
          "STEP_COMPLETED",
          { stepId: "s", output: envelopeFor(output.__loomContent) },
          OLD
        ),
      ];
      for (const e of done) await live.append(e);
      // Its checkpoint went to a snapshot store this sweep was NOT given.
      await compact(live, new InMemoryAsyncSnapshotStore(), "done", done);
      expect((await live.read("done")).map((e) => e.sequence)).toEqual([0]);
      clock.now = NOW;
      await expect(
        sweepUnpinnedContent({
          eventStores: [live],
          snapshotStores: [new InMemoryAsyncSnapshotStore()],
          contentStore: content,
          pinnedEventTypes: [],
          olderThanMs: TTL,
          now: NOW,
          reclaimOrphans: true,
        })
      ).rejects.toThrow(/done/);
      expect(await content.get(output)).not.toBeNull();
    });

    // ADR 0106 — compaction keeps the app's pinned-kind events in place, BELOW the checkpoint,
    // and (the tip rule) never removes the tip when it does. The checkpoint is the log's
    // highest missing sequence; `events[1]` may be a kept finding.
    /** Fold → checkpoint at `at` (below the tip) → truncate keeping `kinds`, as compact does. */
    async function compactKeeping(
      live: InMemoryAsyncEventStore,
      snapshots: InMemoryAsyncSnapshotStore,
      id: string,
      log: EventEnvelope[],
      at: number,
      kinds: string[] = ["FINDING_RECORDED"]
    ): Promise<void> {
      await snapshots.save({
        id: `cp-${id}-${at}`,
        executionId: id,
        workflowId: "wf",
        sequence: at,
        state: new ReplayVM(log.filter((e) => e.sequence <= at)).getState(),
        createdAt: 0,
      });
      await live.truncatePrefixKeeping(id, at, kinds);
    }

    it("a finding kept at sequence 1 does not hide the compaction — the checkpoint's refs stay pinned", async () => {
      const { clock, content } = clockedStore(OLD);
      const prefixOutput = await content.put(bytes("step output only the checkpoint holds"));
      const live = new InMemoryAsyncEventStore();
      const snapshots = new InMemoryAsyncSnapshotStore();
      const log = [
        evt("kept", 0, "EXECUTION_STARTED", { input: {} }, OLD),
        evt("kept", 1, "FINDING_RECORDED", { summary: "lag spike" }, OLD),
        evt("kept", 2, "STEP_STARTED", { stepId: "poll" }, OLD),
        evt(
          "kept",
          3,
          "STEP_COMPLETED",
          { stepId: "poll", output: envelopeFor(prefixOutput.__loomContent) },
          OLD
        ),
        evt("kept", 4, "STEP_STARTED", { stepId: "poll" }, NOW - 2 * DAY),
        evt("kept", 5, "STEP_COMPLETED", { stepId: "poll", output: { rows: 0 } }, NOW - 2 * DAY),
      ];
      for (const e of log.slice(0, 5)) await live.append(e);
      await compactKeeping(live, snapshots, "kept", log, 3); // then-tip 4 survives
      await live.append(log[5]!);
      // A later snapshot (a suspend) no longer holds the prefix ref: only the checkpoint does.
      await snapshots.save({
        id: "later",
        executionId: "kept",
        workflowId: "wf",
        sequence: 5,
        state: new ReplayVM(log).getState(),
        createdAt: 0,
      });
      // [0, 1, 4, 5]: sequence 1 exists, so the pre-0106 sweep read this log as uncompacted.
      expect((await live.read("kept")).map((e) => e.sequence)).toEqual([0, 1, 4, 5]);

      clock.now = NOW;
      const result = await sweepUnpinnedContent({
        eventStores: [live],
        snapshotStores: [snapshots],
        contentStore: content,
        pinnedEventTypes: ["FINDING_RECORDED"],
        olderThanMs: TTL,
        now: NOW,
        reclaimOrphans: true,
      });
      expect(result.orphansReclaimed).toEqual([]);
      expect(await content.get(prefixOutput)).not.toBeNull();
    });

    it("a kept kind the SWEEP does not pin still leaves the checkpoint found (sweep kinds ⊂ compaction kinds)", async () => {
      const { clock, content } = clockedStore(OLD);
      const output = await content.put(bytes("held only by the checkpoint"));
      const live = new InMemoryAsyncEventStore();
      const snapshots = new InMemoryAsyncSnapshotStore();
      const log = [
        evt("sub", 0, "EXECUTION_STARTED", { input: {} }, OLD),
        evt("sub", 1, "NOTE_RECORDED", { note: "n" }, OLD),
        evt("sub", 2, "STEP_STARTED", { stepId: "s" }, OLD),
        evt(
          "sub",
          3,
          "STEP_COMPLETED",
          { stepId: "s", output: envelopeFor(output.__loomContent) },
          OLD
        ),
        evt("sub", 4, "STEP_STARTED", { stepId: "s" }, OLD),
        evt("sub", 5, "STEP_COMPLETED", { stepId: "s", output: { rows: 0 } }, OLD),
        evt("sub", 6, "NOTE_RECORDED", { note: "tip" }, OLD),
      ];
      for (const e of log) await live.append(e);
      await compactKeeping(live, snapshots, "sub", log, 3, ["FINDING_RECORDED", "NOTE_RECORDED"]);
      await snapshots.save({
        id: "later",
        executionId: "sub",
        workflowId: "wf",
        sequence: 6,
        state: new ReplayVM(log).getState(),
        createdAt: 0,
      });
      clock.now = NOW;
      const result = await sweepUnpinnedContent({
        eventStores: [live],
        snapshotStores: [snapshots],
        contentStore: content,
        pinnedEventTypes: ["FINDING_RECORDED"], // NOTE_RECORDED is kept by compaction only
        olderThanMs: TTL,
        now: NOW,
        reclaimOrphans: true,
      });
      expect(result.orphansReclaimed).toEqual([]);
      expect(await content.get(output)).not.toBeNull();
    });

    it("a child forked from a compacted parent is covered by its fork seed, above the copied gap", async () => {
      const { clock, content } = clockedStore(OLD);
      const seeded = await content.put(bytes("in the fork seed"));
      const live = new InMemoryAsyncEventStore();
      const snapshots = new InMemoryAsyncSnapshotStore();
      // The child's copied prefix carries the parent's compaction gap (1..2); its only
      // snapshot is the seed at the fork point, 4 — not at the gap.
      await live.append(evt("child", 0, "EXECUTION_STARTED", { input: {} }, OLD));
      await live.append(evt("child", 3, "STEP_STARTED", { stepId: "s" }, OLD));
      await live.append(
        evt("child", 4, "STEP_COMPLETED", { stepId: "s", output: { rows: 1 } }, OLD)
      );
      await snapshots.save({
        id: "seed",
        executionId: "child",
        workflowId: "wf",
        sequence: 4,
        state: { frames: { s: { output: envelopeFor(seeded.__loomContent) } } } as never,
        createdAt: 0,
      });
      await live.append(
        evt("child", 5, "STEP_COMPLETED", { stepId: "t", output: { rows: 2 } }, OLD)
      );
      await snapshots.save({
        id: "later",
        executionId: "child",
        workflowId: "wf",
        sequence: 5,
        state: { frames: {} } as never,
        createdAt: 0,
      });
      clock.now = NOW;
      // Pre-0106 this required a snapshot at exactly 2 and refused.
      const result = await sweepUnpinnedContent({
        eventStores: [live],
        snapshotStores: [snapshots],
        contentStore: content,
        pinnedEventTypes: [],
        olderThanMs: TTL,
        now: NOW,
        reclaimOrphans: true,
      });
      expect(result.orphansReclaimed).toEqual([]);
      expect(await content.get(seeded)).not.toBeNull();
    });

    it("a forked child's seed is read directly from metadata.forkSequence — no walk down the snapshots", async () => {
      const { clock, content } = clockedStore(OLD);
      const seeded = await content.put(bytes("in the fork seed, found by one exact read"));
      const live = new InMemoryAsyncEventStore();
      const inner = new InMemoryAsyncSnapshotStore();
      const forked = (e: EventEnvelope): EventEnvelope => ({
        ...e,
        metadata: { forkedFrom: "parent", forkSequence: 4 },
      });
      await live.append(forked(evt("kid", 0, "EXECUTION_STARTED", { input: {} }, OLD)));
      await live.append(forked(evt("kid", 3, "STEP_STARTED", { stepId: "s" }, OLD)));
      await live.append(forked(evt("kid", 4, "STEP_COMPLETED", { stepId: "s", output: 1 }, OLD)));
      await inner.save({
        id: "seed",
        executionId: "kid",
        workflowId: "wf",
        sequence: 4,
        state: { frames: { s: { output: envelopeFor(seeded.__loomContent) } } } as never,
        createdAt: 0,
      });
      for (let i = 5; i <= 9; i++) {
        await live.append(evt("kid", i, "STEP_COMPLETED", { stepId: `t${i}`, output: i }, OLD));
        await inner.save({
          id: `s${i}`,
          executionId: "kid",
          workflowId: "wf",
          sequence: i,
          state: { frames: {} } as never,
          createdAt: 0,
        });
      }
      const reads = { before: 0, at: 0 };
      const counting = {
        loadLatest: (id: string) => inner.loadLatest(id),
        loadAt: (id: string, at: number) => {
          reads.at++;
          return inner.loadAt(id, at);
        },
        loadLatestBefore: (id: string, at: number) => {
          reads.before++;
          return inner.loadLatestBefore(id, at);
        },
      };
      clock.now = NOW;
      const result = await sweepUnpinnedContent({
        eventStores: [live],
        snapshotStores: [counting],
        contentStore: content,
        pinnedEventTypes: [],
        olderThanMs: TTL,
        now: NOW,
        reclaimOrphans: true,
      });
      expect(result.orphansReclaimed).toEqual([]);
      expect(await content.get(seeded)).not.toBeNull();
      expect(reads).toEqual({ before: 1, at: 1 }); // the gap probe + the seed; no walk
    });
  });
});
