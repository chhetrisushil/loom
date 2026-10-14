import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { build, flow, settle } from "./__tests__/r2Harness";

// ADR 0109 D6 ordering: a successor's sequence 0 becomes durable BEFORE the kernel registers its
// live handle (execute() runs after the bootstrap append). A follower that reads the head in that
// window used to see `running` with no handle and had to spin on ticks. The runtime now exposes the
// in-flight start (`awaitLiveHandle`), registered BEFORE sequence 0 can be observed.

describe("a successor's live handle is awaitable from the moment its sequence 0 is durable", () => {
  it("awaitLiveHandle resolves the handle for a successor observed in the start window", async () => {
    const inner = new InMemoryAsyncEventStore();
    let rt: ReturnType<typeof build>["rt"] | undefined;
    const seen: Array<{ id: string; liveAtDurable: boolean; pending: Promise<unknown> | undefined }> = [];
    const watching = Object.assign(Object.create(inner) as InMemoryAsyncEventStore, {
      append: async (e: EventEnvelope) => {
        await inner.append(e);
        if (e.sequence === 0 && e.executionId.includes("~") && rt !== undefined) {
          // the instant the successor's sequence 0 is durable, observed from outside
          seen.push({
            id: e.executionId,
            liveAtDurable: rt.liveHandle(e.executionId) !== undefined,
            pending: rt.awaitLiveHandle(e.executionId),
          });
        }
      },
    });
    const h = build({ continueAsNewEnabled: true }, { eventStore: watching });
    rt = h.rt;
    const f = flow<{ gen?: number }, unknown>("hop", async (ctx, input) =>
      (input?.gen ?? 0) < 3 ? ctx.continueAsNew({ gen: (input?.gen ?? 0) + 1 }) : "done"
    );
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "chain" }));
    expect(seen.length).toBeGreaterThanOrEqual(1);
    for (const s of seen) {
      // the window exists (no live handle yet) and is bridged: the pending start resolves the handle
      expect(s.liveAtDurable, s.id).toBe(false);
      const handle = (await s.pending) as { executionId: string } | undefined;
      expect(handle?.executionId, s.id).toBe(s.id);
    }
    // nothing pending is left behind, and an unknown id has no handle
    expect(await h.rt.awaitLiveHandle("never-started")).toBeUndefined();
  });
});
