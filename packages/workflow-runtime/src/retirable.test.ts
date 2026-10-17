import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { EventStore } from "@loom/event-runtime";
import { EncryptingEventStore, InMemoryKeyStore } from "@loom/plugin-crypto";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import type { Snapshot } from "@loom/snapshot-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  Latch,
  SYNC_METHODS,
  build,
  flow,
  retirable,
  sealedSnapshots,
  until,
} from "./__tests__/r2Harness";

// `retirable()` models a process going away. It must never turn a SYNCHRONOUS SPI method
// (`sealingCapability`, `readAtRest`) into a rejected Promise: the caller reads the result inline,
// drops the Promise, and the rejection is unhandleable (vitest: "Unhandled error"). That was the flake in
// r2-erasure's P3-2 on Postgres, where the retire could land before the park's checkpoint save ran.

/** Records every unhandled rejection the process sees until `stop()`. */
function collectUnhandled() {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", onRejection);
  return {
    seen,
    /** Let the process's rejection turn run (it fires after the microtask queue drains), then stop. */
    flush: async () => {
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
    },
    stop: () => process.off("unhandledRejection", onRejection),
  };
}

describe("retirable()", () => {
  let collector: ReturnType<typeof collectUnhandled> | undefined;
  afterEach(() => collector?.stop());

  it("never returns a Promise from a synchronous SPI method once retired", async () => {
    collector = collectUnhandled();
    const capability = { covers: ["EXECUTION_STARTED"] };
    const inner = new InMemoryAsyncEventStore() as unknown as Record<string, unknown>;
    inner.sealingCapability = () => capability;
    inner.readAtRest = () => ({ readLatest: async () => null });
    const r = retirable(inner as unknown as EventStore);
    const store = r.store;
    expect(SYNC_METHODS.has("sealingCapability") && SYNC_METHODS.has("readAtRest")).toBe(true);

    // live: both answer inline
    expect(store.sealingCapability?.()).toBe(capability);
    expect(store.readAtRest?.()).not.toBeInstanceOf(Promise);

    await r.retire();

    // the pure capability query is forwarded, synchronously
    const cap = store.sealingCapability?.();
    expect(cap).not.toBeInstanceOf(Promise);
    expect(cap).toBe(capability);
    // the reader factory throws synchronously instead of returning a rejected Promise
    expect(() => store.readAtRest?.()).toThrow("store retired: readAtRest");
    // async methods are refused with a rejection the caller holds
    await expect(store.read("e")).rejects.toThrow("store retired: read");

    await collector.flush();
    expect(collector.seen).toEqual([]);
  });

  it("fences the snapshot store with the same switch", async () => {
    const r = retirable(new InMemoryAsyncEventStore(), new InMemoryAsyncSnapshotStore());
    await r.retire();
    await expect(r.snapshotStore.loadLatest("e")).rejects.toThrow("store retired: loadLatest");
    await expect(r.snapshotStore.save({} as Snapshot)).rejects.toThrow("store retired: save");
  });
});

describe("a park's checkpoint save after the process retired", () => {
  let collector: ReturnType<typeof collectUnhandled> | undefined;
  afterEach(() => collector?.stop());

  it("is refused and reported, and leaks no unhandled rejection from the checkpoint guard", async () => {
    collector = collectUnhandled();
    const keys = new InMemoryKeyStore();
    const rawEvents = new InMemoryAsyncEventStore();
    const rawSnaps = new InMemoryAsyncSnapshotStore();
    const sealing = new EncryptingEventStore(rawEvents, keys, {
      sensitive: { MESSAGE_CONSUMED: ["payload"] },
      subjectOf: (e) => e.executionId,
    });

    // The latch holds the park's EXECUTION_SUSPENDED append open: the park's tail (the checkpoint
    // save, preceded by the checkpoint guard's `sealingCapability()` read) has not started yet.
    const latch = new Latch();
    const isPark = (e: EventEnvelope) => e.eventType === "EXECUTION_SUSPENDED";
    const latched = new Proxy(sealing, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        if (key === "append" || key === "appendBatch") {
          return async (arg: EventEnvelope | readonly EventEnvelope[]) => {
            const batch = Array.isArray(arg) ? arg : [arg as EventEnvelope];
            const result = await value.call(target, arg);
            if (batch.some(isPark)) {
              latch.enter();
              await latch.promise;
            }
            return result;
          };
        }
        return value.bind(target);
      },
    }) as unknown as EventStore;

    const process1 = retirable(latched, sealedSnapshots(sealing, rawSnaps));
    const h = build({}, { eventStore: process1.store, snapshotStore: process1.snapshotStore });
    const f = flow("w", async (ctx) => {
      await ctx.suspend({ on: "Go" });
      return 1;
    });
    h.rt.registerFlow(f.definition, f.runner);

    void h.rt.start(f, {}, { executionId: "e1" });
    await latch.entered; // the park is mid-append: its checkpoint save has not run
    const retired = process1.retire(); // the process goes away HERE...
    latch.release(); // ...and its park carries on into the checkpoint save
    await retired;

    await until(() => h.storageErrors.length > 0);
    expect(String((h.storageErrors[0] as Error).message)).toContain("store retired");
    expect(await rawSnaps.loadLatest("e1")).toBeNull(); // the dead process wrote nothing
    await collector.flush();
    expect(collector.seen).toEqual([]);
  });
});
