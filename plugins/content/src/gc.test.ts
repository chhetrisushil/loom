import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { pinByEventKinds, sweepUnpinnedContent } from "./gc";
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
  const content = new InMemoryContentStore();
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
    const report = await sweepUnpinnedContent({
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
    await sweepUnpinnedContent({ ...opts, now: NOW });
    const second = await sweepUnpinnedContent({ ...opts, now: NOW + 300 * DAY });
    // Fresh telemetry aged out by the later sweep; evidence STILL pinned. (An
    // already-reclaimed ref may be re-reported — delete is idempotent.)
    expect(second.reclaimed).toContain(f.freshTelemetry.__loomContent);
    expect(second.reclaimed).not.toContain(f.evidence.__loomContent);
    expect(await f.content.get(f.freshTelemetry)).toBeNull();
    expect(await f.content.get(f.evidence)).not.toBeNull();
  });

  it("pins BARE ContentRefs cited by pinned events (a finding's evidence list)", async () => {
    const content = new InMemoryContentStore();
    const plan = await content.put(bytes("EXPLAIN output"));
    const store = new InMemoryAsyncEventStore();
    // Evidence cited as a bare ADR 0046 ref — no claim-check envelope wrapper.
    await store.append(
      evt("run-1", 0, "FINDING_RECORDED", { evidence: [{ __loomContent: plan.__loomContent }] }, 1)
    );
    const report = await sweepUnpinnedContent({
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
      sweepUnpinnedContent({
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
    const content = new InMemoryContentStore();
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

    const report = await sweepUnpinnedContent({
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
    const content = new InMemoryContentStore();
    const raw = new InMemoryAsyncEventStore();
    const store = new ContentResolvingEventStore(raw, content, {
      externalize: { STEP_COMPLETED: ["output"] },
    });
    await store.append(evt("perpetual", 0, "EXECUTION_STARTED", { input: {} }, OLD));
    await store.append(
      evt("perpetual", 1, "STEP_COMPLETED", { stepId: "read", output: { rows: [1, 2, 3] } }, OLD)
    );
    // Still running: no terminal event. The raw log holds a BARE ref at `output`.

    const report = await sweepUnpinnedContent({
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
    const content = new InMemoryContentStore();
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

    const report = await sweepUnpinnedContent({
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
    const content = new InMemoryContentStore();
    const both = await content.put(bytes("cited two ways"));
    const store = new InMemoryAsyncEventStore();
    await store.append(
      evt("e", 0, "STEP_COMPLETED", { output: envelopeFor(both.__loomContent) }, OLD)
    );
    await store.append(
      evt("e", 1, "STEP_COMPLETED", { other: { __loomContent: both.__loomContent } }, OLD)
    );

    const report = await sweepUnpinnedContent({
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
    const content = new InMemoryContentStore();
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

    const report = await sweepUnpinnedContent({
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
    const content = new InMemoryContentStore();
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

    const report = await sweepUnpinnedContent({
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
    const content = new InMemoryContentStore();
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

    const report = await sweepUnpinnedContent({
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
    const content = new InMemoryContentStore();
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

    const report = await sweepUnpinnedContent({
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
    const content = new InMemoryContentStore();
    const raw = new InMemoryAsyncEventStore();
    const store = new ContentResolvingEventStore(raw, content, { externalize: {} });
    const draft = await content.put(bytes(JSON.stringify({ widgets: [] })));
    await store.append(evt("v", 0, "VIEW_DRAFTED", { ref: draft }, OLD));

    const report = await sweepUnpinnedContent({
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
