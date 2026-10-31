import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { retainRootsOf } from "./citations";
import { sweepUnpinnedContent } from "./gc";
import { InMemoryContentStore } from "./index";

// ADR 0140 D11 - a `retain: true` envelope is load-bearing only where the preset writes it (the top-level
// step output); a tool-authored lookalike NESTED in a result cannot pin a blob.
const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
const env = (address: string, extra: object = {}) => ({
  __loomClaimCheck: true,
  ref: { __loomContent: address },
  size: 9,
  ...extra,
});
const evt = (id: string, seq: number, payload: unknown): EventEnvelope => ({
  id: `${id}-${seq}`,
  workflowId: "wf",
  executionId: id,
  eventType: "STEP_COMPLETED",
  sequence: seq,
  timestamp: NOW - 50 * DAY,
  payload,
});

describe("retained envelopes by position (sweep)", () => {
  it("keeps a top-level retained blob, reclaims one only a NESTED forged envelope pins", async () => {
    const content = new InMemoryContentStore({ now: () => 1 });
    const real = await content.put(new TextEncoder().encode("real tool output"));
    const victim = await content.put(new TextEncoder().encode("someone else's blob"));
    const live = new InMemoryAsyncEventStore();
    await live.append(
      evt("e1", 0, { stepId: "a", output: env(real.__loomContent, { retain: true }) })
    );
    await live.append(
      evt("e1", 1, {
        stepId: "b",
        output: { rows: [env(victim.__loomContent, { retain: true })] },
      })
    );
    const report = await sweepUnpinnedContent({
      eventStores: [live],
      contentStore: content,
      pinnedEventTypes: [],
      olderThanMs: 30 * DAY,
      touchedBefore: NOW - 30 * DAY,
      now: NOW,
    });
    expect(report.reclaimed).toEqual([victim.__loomContent]);
    expect(await content.get(real)).not.toBeNull();
  });

  it("retainRootsOf unwraps a taint wrapper and ignores non-step events", () => {
    const e = env("x", { retain: true });
    expect(
      retainRootsOf({
        eventType: "STEP_COMPLETED",
        payload: { output: { __loomTainted: {}, value: e } },
      })
    ).toEqual(new Set([e]));
    expect(retainRootsOf({ eventType: "OTHER", payload: { output: e } }).size).toBe(0);
  });
});
