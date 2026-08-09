import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { pinByEventKinds, sweepUnpinnedContent } from "./gc";
import { InMemoryContentStore, contentAddress } from "./index";

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
    await events.append(evt("e1", 1, "TELEMETRY", { samples: [{ blob: stale }] }, OLD));

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
