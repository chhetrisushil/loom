import type { EventEnvelope } from "@loom/core";
import {
  CoalescingEventStore,
  type EventStore,
  InMemoryAsyncEventStore,
  ProfilingEventStore,
  ShardedEventStore,
  TenantScopedEventStore,
} from "@loom/event-runtime";
import { ContentResolvingEventStore, InMemoryContentStore } from "@loom/plugin-content";
import { EncryptingEventStore, InMemoryKeyStore } from "@loom/plugin-crypto";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { build, flow } from "./__tests__/r2Harness";

// ADR 0116 round 3 (P3 #6, #7) — `recordOutcome` driven THROUGH every store decorator that
// forwards `appendIfUnchanged`: the late outcome lands exactly once per key, folds, stays
// idempotent, and the decorator's own transform (scope, seal, externalise) is applied to it.
// The audit-chain decorator has its own test beside the plugin (it cannot be a dependency here).

const deciding = flow("decider", async (ctx) => {
  await ctx.decide("route", () => "opus");
  return { done: true };
});

async function drive(store: EventStore) {
  const h = build({}, { eventStore: store, snapshotStore: new InMemoryAsyncSnapshotStore() });
  h.rt.registerFlow(deciding.definition, deciding.runner);
  await (await h.rt.start(deciding, {}, { executionId: "e" })).waitForCompletion();
  const first = await h.rt.recordOutcome("e", { decisionId: "route", key: "k", score: 0.5 });
  const dup = await h.rt.recordOutcome("e", { decisionId: "route", key: "k", score: 0.5 });
  const second = await h.rt.recordOutcome("e", { decisionId: "route", key: "k2", score: 0.7 });
  const state = await h.rt.loadState("e");
  return { h, first, dup, second, state };
}

const expectLanded = (r: Awaited<ReturnType<typeof drive>>) => {
  expect(r.first.appended).toBe(true);
  expect(r.dup.appended).toBe(false);
  expect(r.second.appended).toBe(true);
  expect(
    (r.state?.variables._outcomes as Array<{ key: string; score: number; late?: boolean }>).map(
      (o) => [o.key, o.score, o.late]
    )
  ).toEqual([
    ["k", 0.5, true],
    ["k2", 0.7, true],
  ]);
};

describe("recordOutcome through store decorators", () => {
  it("TenantScopedEventStore: lands under the tenant scope, unscoped on read", async () => {
    const inner = new InMemoryAsyncEventStore();
    const r = await drive(new TenantScopedEventStore(inner, "acme"));
    expectLanded(r);
    expect(await inner.listExecutions?.()).not.toContain("e"); // only the scoped id exists
    expect((await inner.listExecutions?.())?.length).toBe(1);
  });

  it("EncryptingEventStore: the sealed field is ciphertext at rest, plain after the fold", async () => {
    const inner = new InMemoryAsyncEventStore();
    const store = new EncryptingEventStore(inner, new InMemoryKeyStore(), {
      sensitive: { OUTCOME_RECORDED: ["score"] },
    });
    const r = await drive(store);
    expectLanded(r);
    const raw = (await inner.read("e")).filter((x) => x.eventType === "OUTCOME_RECORDED");
    expect(raw).toHaveLength(2);
    for (const e of raw) expect(typeof (e.payload as { score: unknown }).score).not.toBe("number");
  });

  it("ContentResolvingEventStore: the externalised field is a ref at rest, resolved after the fold", async () => {
    const inner = new InMemoryAsyncEventStore();
    const content = new InMemoryContentStore();
    const store = new ContentResolvingEventStore(inner, content, {
      externalize: { OUTCOME_RECORDED: ["key"] },
    });
    const r = await drive(store);
    expectLanded(r);
    const raw = (await inner.read("e")).filter((x) => x.eventType === "OUTCOME_RECORDED");
    for (const e of raw) expect(typeof (e.payload as { key: unknown }).key).toBe("object");
  });

  it("ContentResolvingEventStore: a write that lost the race stores NO blob; only the retry does", async () => {
    class Counting extends InMemoryContentStore {
      puts = 0;
      override async put(bytes: Uint8Array) {
        this.puts++;
        return super.put(bytes);
      }
    }
    const inner = new InMemoryAsyncEventStore();
    const content = new Counting();
    const resolving = new ContentResolvingEventStore(inner, content, {
      externalize: { OUTCOME_RECORDED: ["key"] },
    });
    let raced = false;
    // Sits OUTSIDE the decorator: another writer lands between recordOutcome's observation and
    // its conditional append, so the first attempt is refused.
    const store = new Proxy(resolving, {
      get(t, k, r) {
        if (k !== "appendIfUnchanged") {
          const v = Reflect.get(t, k, r);
          return typeof v === "function" ? v.bind(t) : v;
        }
        return async (id: string, ev: EventEnvelope | null, expect?: never) => {
          if (ev !== null && !raced) {
            raced = true;
            const head = (await inner.head?.(id)) as number;
            await inner.append({
              id: `${id}-rival`,
              workflowId: ev.workflowId,
              executionId: id,
              eventType: "OUTCOME_RECORDED",
              sequence: head + 1,
              timestamp: ev.timestamp,
              payload: { key: "rival", decisionId: "route", score: 0, late: true, recordedBy: "x" },
              metadata: { kernel: true },
            });
          }
          return t.appendIfUnchanged!(id, ev, expect);
        };
      },
    }) as EventStore;
    const h = build({}, { eventStore: store, snapshotStore: new InMemoryAsyncSnapshotStore() });
    h.rt.registerFlow(deciding.definition, deciding.runner);
    await (await h.rt.start(deciding, {}, { executionId: "e" })).waitForCompletion();
    expect(content.puts).toBe(0);
    const r = await h.rt.recordOutcome("e", { decisionId: "route", key: "k", score: 0.5 });
    expect(r.appended).toBe(true);
    expect(raced).toBe(true);
    // one blob for the one event that landed; the refused first attempt left none behind
    expect(content.puts).toBe(1);
  });

  it("ShardedEventStore, CoalescingEventStore and ProfilingEventStore forward it", async () => {
    expectLanded(
      await drive(
        new ShardedEventStore([new InMemoryAsyncEventStore(), new InMemoryAsyncEventStore()])
      )
    );
    expectLanded(await drive(new CoalescingEventStore(new InMemoryAsyncEventStore())));
    expectLanded(await drive(new ProfilingEventStore(new InMemoryAsyncEventStore())));
  });
});
