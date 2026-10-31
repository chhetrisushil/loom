import { describe, expect, it } from "vitest";
import { BoundedTopN } from "./BoundedTopN";
import { InMemoryAsyncSnapshotStore } from "./InMemoryAsyncSnapshotStore";
import {
  ProfilingSnapshotStore,
  SIZE_HISTOGRAM_BUCKETS,
  sizeBucket,
  utf8ByteLength,
} from "./ProfilingSnapshotStore";
import type { Snapshot, SnapshotStore } from "./types";

/** `{"pad":""}` is 10 bytes of JSON, so a snapshot of exactly `bytes` pads the rest. */
function sized(executionId: string, bytes: number, sequence = 1): Snapshot {
  return {
    id: `${executionId}-${sequence}`,
    executionId,
    workflowId: "wf",
    sequence,
    state: { pad: "x".repeat(bytes - 10) } as unknown as Snapshot["state"],
    createdAt: sequence,
  };
}

function withState(state: unknown, executionId = "x"): Snapshot {
  return { ...sized(executionId, 10), state: state as Snapshot["state"] };
}

describe("utf8ByteLength / sizeBucket", () => {
  it("counts UTF-8 bytes, not UTF-16 units (multi-byte, astral, lone surrogate)", () => {
    for (const s of ["", "abc", "é", "€", "日本語", "😀", "a😀b", "\ud800", "\udc00x", "\ud800a"]) {
      expect(utf8ByteLength(s)).toBe(new TextEncoder().encode(s).length);
    }
  });

  it("buckets at the power-of-two boundaries", () => {
    expect(sizeBucket(0)).toBe(0);
    expect(sizeBucket(1)).toBe(0);
    expect(sizeBucket(2)).toBe(1);
    expect(sizeBucket(3)).toBe(2);
    expect(sizeBucket(4)).toBe(2);
    expect(sizeBucket(5)).toBe(3);
    expect(sizeBucket(1024)).toBe(10);
    expect(sizeBucket(1025)).toBe(11);
    expect(sizeBucket(2 ** 31)).toBe(31);
    expect(sizeBucket(2 ** 31 + 1)).toBe(32);
    expect(sizeBucket(2 ** 39)).toBe(39);
    expect(sizeBucket(2 ** 39 + 1)).toBe(40);
    expect(sizeBucket(2 ** 60)).toBe(SIZE_HISTOGRAM_BUCKETS - 1);
  });
});

describe("ProfilingSnapshotStore", () => {
  it("measures the UTF-8 bytes of the state exactly as the wrapped store receives it", async () => {
    const received: Snapshot[] = [];
    const inner = new InMemoryAsyncSnapshotStore();
    const spy: SnapshotStore = Object.assign(Object.create(inner), {
      save: async (s: Snapshot) => {
        received.push(s);
        return inner.save(s);
      },
    });
    const store = new ProfilingSnapshotStore(spy);
    await store.save(withState({ t: "日本語😀é" }));
    const expected = new TextEncoder().encode(JSON.stringify(received[0]!.state)).length;
    expect(expected).toBeGreaterThan(JSON.stringify(received[0]!.state).length); // multi-byte
    const p = store.profile();
    expect(p.totalBytes).toBe(expected);
    expect(p.maxBytes).toBe(expected);
    expect(p.saves).toBe(1);
  });

  it("aggregates saves, total, max and a histogram that lands on the boundaries", async () => {
    const store = new ProfilingSnapshotStore(new InMemoryAsyncSnapshotStore());
    for (const [i, b] of [16, 17, 1024, 1025, 100].entries()) await store.save(sized("a", b, i));
    const p = store.profile();
    expect(p.saves).toBe(5);
    expect(p.totalBytes).toBe(16 + 17 + 1024 + 1025 + 100);
    expect(p.maxBytes).toBe(1025);
    expect(p.histogram).toHaveLength(SIZE_HISTOGRAM_BUCKETS);
    const at = (maxBytes: number) => p.histogram.find((h) => h.maxBytes === maxBytes)!.count;
    expect(at(16)).toBe(1);
    expect(at(32)).toBe(1);
    expect(at(128)).toBe(1);
    expect(at(1024)).toBe(1);
    expect(at(2048)).toBe(1);
    expect(p.histogram.reduce((n, h) => n + h.count, 0)).toBe(5);
    expect(p.histogram.at(-1)!.maxBytes).toBe(Number.POSITIVE_INFINITY);
  });

  it("keeps the top N by LATEST size: evicts the smallest, updates on grow and shrink", async () => {
    const store = new ProfilingSnapshotStore(new InMemoryAsyncSnapshotStore(), { topN: 3 });
    await store.save(sized("a", 100));
    await store.save(sized("b", 200));
    await store.save(sized("c", 300));
    await store.save(sized("d", 50)); // smaller than all three: not admitted
    expect(store.profile().largest.map((l) => l.executionId)).toEqual(["c", "b", "a"]);
    await store.save(sized("d", 250, 2)); // beats the smallest (a)
    expect(store.profile().largest.map((l) => l.executionId)).toEqual(["c", "d", "b"]);
    await store.save(sized("b", 900, 2)); // grows
    expect(store.profile().largest.map((l) => [l.executionId, l.bytes])).toEqual([
      ["b", 900],
      ["c", 300],
      ["d", 250],
    ]);
    await store.save(sized("b", 20, 3)); // SHRINKS: its entry follows the latest size
    expect(store.profile().largest.map((l) => [l.executionId, l.bytes, l.sequence])).toEqual([
      ["c", 300, 1],
      ["d", 250, 2],
      ["b", 20, 3],
    ]);
    expect(store.profile().maxBytes).toBe(900); // the aggregate keeps the historical max
  });

  it("stays O(N) however many executions it sees", async () => {
    const store = new ProfilingSnapshotStore(new InMemoryAsyncSnapshotStore(), {
      topN: 5,
      largeThresholdBytes: 10,
      dedupeCapacity: 7,
    });
    for (let i = 0; i < 500; i++) await store.save(sized(`e${i}`, 10 + (i % 97)));
    expect(store.trackedCounts()).toEqual({ largest: 5, reported: 7 });
    expect(store.profile().largest).toHaveLength(5);
    expect(store.profile().saves).toBe(500);
  });

  it("BoundedTopN keeps its heap + index consistent under random churn", () => {
    const top = new BoundedTopN(8);
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const latest = new Map<string, number>();
    for (let i = 0; i < 3000; i++) {
      const key = `k${rnd() % 40}`;
      if (rnd() % 7 === 0) {
        top.remove(key);
        latest.delete(key);
      } else {
        const v = rnd() % 1000;
        top.offer(key, v, 0);
        latest.set(key, v);
      }
      expect(top.check()).toBe(true);
    }
    // every retained entry carries its key's true latest value
    for (const e of top.entries()) expect(e.value).toBe(latest.get(e.key));
  });

  describe("onLargeSnapshot", () => {
    it("fires once when an execution first crosses the threshold, not on later saves", async () => {
      const fired: [string, number][] = [];
      const store = new ProfilingSnapshotStore(new InMemoryAsyncSnapshotStore(), {
        largeThresholdBytes: 100,
        onLargeSnapshot: (id, bytes) => void fired.push([id, bytes]),
      });
      await store.save(sized("a", 99, 1));
      expect(fired).toEqual([]);
      await store.save(sized("a", 100, 2));
      await store.save(sized("a", 500, 3));
      await store.save(sized("a", 20, 4)); // shrinks and regrows: still the same execution
      await store.save(sized("a", 600, 5));
      await store.save(sized("b", 150, 1));
      expect(fired).toEqual([
        ["a", 100],
        ["b", 150],
      ]);
    });

    it("re-fires an execution only after the bounded dedupe set evicted it", async () => {
      const fired: string[] = [];
      const store = new ProfilingSnapshotStore(new InMemoryAsyncSnapshotStore(), {
        largeThresholdBytes: 50,
        dedupeCapacity: 2,
        onLargeSnapshot: (id) => void fired.push(id),
      });
      await store.save(sized("a", 60)); // fire a
      await store.save(sized("b", 60)); // fire b
      await store.save(sized("a", 70, 2)); // a is refreshed, no fire
      await store.save(sized("c", 60)); // fire c; evicts b (least recently saved)
      await store.save(sized("a", 80, 3)); // a still remembered
      expect(fired).toEqual(["a", "b", "c"]);
      await store.save(sized("b", 90, 2)); // b was evicted: documented re-fire
      expect(fired).toEqual(["a", "b", "c", "b"]);
    });

    it("a throwing or rejecting hook does not fail the save, and is reported", async () => {
      const errors: unknown[] = [];
      for (const hook of [
        () => {
          throw new Error("sync");
        },
        async () => {
          throw new Error("async");
        },
      ]) {
        const inner = new InMemoryAsyncSnapshotStore();
        const store = new ProfilingSnapshotStore(inner, {
          largeThresholdBytes: 10,
          onLargeSnapshot: hook,
          onMeasurementError: (_id, e) => {
            errors.push(e);
            throw new Error("reporter also throws");
          },
        });
        await expect(store.save(sized("a", 20))).resolves.toBeUndefined();
        expect((await inner.loadLatest("a"))?.id).toBe("a-1");
        await new Promise((r) => setTimeout(r, 0));
      }
      expect(errors.map((e) => (e as Error).message)).toEqual(["sync", "async"]);
    });
  });

  it("never fails or alters a save when measuring throws (BigInt state)", async () => {
    const inner = new InMemoryAsyncSnapshotStore();
    const reported: string[] = [];
    const store = new ProfilingSnapshotStore(inner, {
      onMeasurementError: (id) => void reported.push(id),
    });
    await store.save(withState({ n: 10n }, "bad"));
    await store.save(sized("ok", 30));
    expect((await inner.loadLatest("bad"))?.id).toBe("bad-1");
    const p = store.profile();
    expect(p.measurementErrors).toBe(1);
    expect(p.measured).toBe(1);
    expect(p.saves).toBe(2);
    expect(reported).toEqual(["bad"]);
  });

  it("does not count a save the wrapped store refused", async () => {
    const inner = new InMemoryAsyncSnapshotStore();
    inner.save = async () => {
      throw new Error("refused");
    };
    const store = new ProfilingSnapshotStore(inner, { largeThresholdBytes: 1 });
    await expect(store.save(sized("a", 20))).rejects.toThrow("refused");
    expect(store.profile().saves).toBe(0);
    expect(store.profile().largest).toEqual([]);
  });

  describe("sampling", () => {
    it("measures only the saves the injected sampler admits, but counts every save", async () => {
      const draws = [0.9, 0.1, 0.5, 0.2];
      const store = new ProfilingSnapshotStore(new InMemoryAsyncSnapshotStore(), {
        sampleRate: 0.3,
        sampler: () => draws.shift()!,
      });
      for (let i = 0; i < 4; i++) await store.save(sized("a", 100 + i, i));
      const p = store.profile();
      expect(p.saves).toBe(4);
      expect(p.measured).toBe(2);
      expect(p.totalBytes).toBe(101 + 103);
    });

    it("rate 1 never draws; rate 0 measures nothing; bad options throw", async () => {
      const never = () => {
        throw new Error("drawn");
      };
      const all = new ProfilingSnapshotStore(new InMemoryAsyncSnapshotStore(), { sampler: never });
      await all.save(sized("a", 20));
      expect(all.profile().measured).toBe(1);
      const none = new ProfilingSnapshotStore(new InMemoryAsyncSnapshotStore(), {
        sampleRate: 0,
        sampler: () => 0,
      });
      await none.save(sized("a", 20));
      expect(none.profile().measured).toBe(0);
      const inner = new InMemoryAsyncSnapshotStore();
      expect(() => new ProfilingSnapshotStore(inner, { sampleRate: 1.5 })).toThrow(RangeError);
      expect(() => new ProfilingSnapshotStore(inner, { sampleRate: Number.NaN })).toThrow(
        RangeError
      );
      expect(() => new ProfilingSnapshotStore(inner, { topN: -1 })).toThrow(RangeError);
      expect(() => new ProfilingSnapshotStore(inner, { dedupeCapacity: 1.5 })).toThrow(RangeError);
    });
  });

  describe("forwarding", () => {
    it("forwards loads, close and every optional method; prune and delete drop the entry", async () => {
      const inner = new InMemoryAsyncSnapshotStore();
      const fired: string[] = [];
      const store = new ProfilingSnapshotStore(inner, {
        largeThresholdBytes: 10,
        onLargeSnapshot: (id) => void fired.push(id),
      });
      expect(store.deleteExecution).toBeTypeOf("function");
      expect(store.loadLatestSealed).toBeTypeOf("function");
      expect(store.pruneSnapshots).toBeTypeOf("function");

      for (const seq of [1, 2, 3, 4]) await store.save(sized("a", 100 + seq, seq));
      await store.save(sized("b", 500, 1));
      expect((await store.loadLatest("a"))?.sequence).toBe(4);
      expect((await store.loadAt("a", 2))?.sequence).toBe(2);
      expect((await store.loadLatestBefore("a", 3))?.sequence).toBe(3);
      expect((await store.loadLatestSealed!("a"))?.sequence).toBe(4);
      expect(fired).toEqual(["a", "b"]);

      // pruning that deleted rows but kept the LATEST snapshot (seq 4 is outside (0,4)) keeps
      // the execution listed and does not re-fire the hook
      expect(await store.pruneSnapshots!("a", { after: 0, before: 4 }, [2])).toBe(2);
      expect(await inner.loadAt("a", 1)).toBeNull();
      expect((await inner.loadAt("a", 2))?.sequence).toBe(2);
      expect(store.profile().largest.map((l) => l.executionId)).toEqual(["b", "a"]);
      expect(store.trackedCounts()).toEqual({ largest: 2, reported: 2 });
      await store.save(sized("a", 200, 5));
      expect(fired).toEqual(["a", "b"]);

      // a prune that deleted nothing leaves the entry alone
      expect(await store.pruneSnapshots!("b", { after: 0, before: 1 })).toBe(0);
      expect(store.profile().largest.map((l) => l.executionId)).toContain("b");

      await store.deleteExecution!("b");
      expect(await store.loadLatest("b")).toBeNull();
      expect(store.profile().largest.map((l) => l.executionId)).toEqual(["a"]);
      expect(store.trackedCounts()).toEqual({ largest: 1, reported: 1 });
    });

    it("advertises only what the inner store has", () => {
      const bare: SnapshotStore = {
        save: async () => {},
        loadLatest: async () => null,
        loadAt: async () => null,
        loadLatestBefore: async () => null,
        close: async () => {},
      };
      const store = new ProfilingSnapshotStore(bare);
      expect(store.deleteExecution).toBeUndefined();
      expect(store.loadLatestSealed).toBeUndefined();
      expect(store.pruneSnapshots).toBeUndefined();
    });
  });

  it("resetProfile clears the aggregates, the top-N and the dedupe memory", async () => {
    const store = new ProfilingSnapshotStore(new InMemoryAsyncSnapshotStore(), {
      largeThresholdBytes: 10,
    });
    await store.save(sized("a", 50));
    store.resetProfile();
    expect(store.profile()).toMatchObject({ saves: 0, totalBytes: 0, maxBytes: 0, largest: [] });
    expect(store.trackedCounts()).toEqual({ largest: 0, reported: 0 });
  });

  describe("fix round (out-of-order saves, prune, ties, options)", () => {
    /** An inner store whose saves complete only when the test releases them. */
    function gated() {
      const inner = new InMemoryAsyncSnapshotStore();
      const release = new Map<number, () => void>();
      const spy: SnapshotStore = Object.assign(Object.create(inner), {
        save: (s: Snapshot) =>
          new Promise<void>((resolve) => {
            release.set(s.sequence, () => {
              void inner.save(s).then(resolve);
            });
          }),
      });
      return { spy, release };
    }

    it("F1: an older save completing LAST does not overwrite the latest size", async () => {
      const { spy, release } = gated();
      const store = new ProfilingSnapshotStore(spy);
      const one = store.save(sized("a", 500, 1));
      const two = store.save(sized("a", 100, 2));
      release.get(2)!();
      await two;
      release.get(1)!();
      await one;
      expect(store.profile().largest).toEqual([{ executionId: "a", bytes: 100, sequence: 2 }]);
    });

    it("F1: a stale (lower-sequence) completion does not refresh the dedupe recency", async () => {
      const fired: string[] = [];
      const store = new ProfilingSnapshotStore(new InMemoryAsyncSnapshotStore(), {
        largeThresholdBytes: 10,
        dedupeCapacity: 2,
        onLargeSnapshot: (id) => void fired.push(id),
      });
      await store.save(sized("a", 20, 5)); // fire a
      await store.save(sized("b", 20, 1)); // fire b
      await store.save(sized("a", 20, 3)); // stale: must NOT make a the most recent
      await store.save(sized("c", 20, 1)); // fire c; evicts the least recent = a
      await store.save(sized("b", 20, 2)); // b still remembered
      expect(fired).toEqual(["a", "b", "c"]);
      await store.save(sized("a", 20, 6)); // a was evicted: fires again
      expect(fired).toEqual(["a", "b", "c", "a"]);
    });

    it("F2: a prune whose range covers the held latest sequence forgets the execution", async () => {
      const inner = new InMemoryAsyncSnapshotStore();
      const fired: string[] = [];
      const store = new ProfilingSnapshotStore(inner, {
        largeThresholdBytes: 10,
        onLargeSnapshot: (id) => void fired.push(id),
      });
      for (const seq of [1, 2, 3]) await store.save(sized("a", 100, seq));
      expect(await store.pruneSnapshots!("a", { after: 0, before: 10 })).toBe(3);
      expect(store.profile().largest).toEqual([]);
      expect(store.trackedCounts()).toEqual({ largest: 0, reported: 0 });
    });

    it("F2: a prune that lists the latest in keep leaves it tracked", async () => {
      const store = new ProfilingSnapshotStore(new InMemoryAsyncSnapshotStore());
      for (const seq of [1, 2, 3]) await store.save(sized("a", 100, seq));
      expect(await store.pruneSnapshots!("a", { after: 0, before: 10 }, [3])).toBe(2);
      expect(store.profile().largest.map((l) => l.sequence)).toEqual([3]);
    });

    it("F5: onLargeSnapshot without largeThresholdBytes throws", () => {
      expect(
        () => new ProfilingSnapshotStore(new InMemoryAsyncSnapshotStore(), { onLargeSnapshot: () => {} })
      ).toThrow(RangeError);
    });

    it("F6: equal sizes list in a deterministic order (executionId ascending)", async () => {
      const top = new BoundedTopN(5);
      for (const k of ["d", "b", "e", "a", "c"]) top.offer(k, 7, 1);
      expect(top.entries().map((e) => e.key)).toEqual(["a", "b", "c", "d", "e"]);
      const store = new ProfilingSnapshotStore(new InMemoryAsyncSnapshotStore());
      for (const id of ["z", "m", "q"]) await store.save(sized(id, 40));
      expect(store.profile().largest.map((l) => l.executionId)).toEqual(["m", "q", "z"]);
    });
  });

  describe("surviving mutations", () => {
    it("BoundedTopN with capacity 0 holds nothing", () => {
      const top = new BoundedTopN(0);
      top.offer("a", 5, 1);
      top.offer("b", 9, 1);
      expect(top.size).toBe(0);
      expect(top.entries()).toEqual([]);
    });

    it("BoundedTopN.clear empties the index too, so a key can be offered again", () => {
      const top = new BoundedTopN(3);
      top.offer("a", 5, 1);
      top.offer("b", 6, 1);
      top.clear();
      expect(top.size).toBe(0);
      top.offer("a", 7, 2);
      expect(top.entries()).toEqual([{ key: "a", value: 7, sequence: 2 }]);
      expect(top.check()).toBe(true);
    });

    it("an equal-size newcomer is NOT admitted to a full heap", () => {
      const top = new BoundedTopN(2);
      top.offer("a", 10, 1);
      top.offer("b", 10, 1);
      top.offer("c", 10, 1);
      expect(top.entries().map((e) => e.key)).toEqual(["a", "b"]);
      top.offer("d", 11, 1);
      expect(top.size).toBe(2);
      expect(top.check()).toBe(true);
    });

    it("remove reports true for a present key (swap path and last path), false for absent", () => {
      const top = new BoundedTopN(4);
      for (const [k, v] of [
        ["a", 1],
        ["b", 2],
        ["c", 3],
        ["d", 4],
      ] as const)
        top.offer(k, v, 1);
      expect(top.remove("a")).toBe(true); // root: swap-with-last
      expect(top.check()).toBe(true);
      expect(top.remove("d")).toBe(true);
      expect(top.check()).toBe(true);
      expect(top.remove("zzz")).toBe(false);
      expect(top.remove("a")).toBe(false);
      expect(top.size).toBe(2);
    });

    it("dedupeCapacity 0 fires on every over-threshold save and remembers nothing", async () => {
      const fired: string[] = [];
      const store = new ProfilingSnapshotStore(new InMemoryAsyncSnapshotStore(), {
        largeThresholdBytes: 10,
        dedupeCapacity: 0,
        onLargeSnapshot: (id) => void fired.push(id),
      });
      await store.save(sized("a", 20, 1));
      await store.save(sized("a", 20, 2));
      await store.save(sized("a", 20, 3));
      expect(fired).toEqual(["a", "a", "a"]);
      expect(store.trackedCounts().reported).toBe(0);
    });

    it("a failing inner deleteExecution leaves the entry tracked", async () => {
      const inner = new InMemoryAsyncSnapshotStore();
      inner.deleteExecution = async () => {
        throw new Error("delete failed");
      };
      const store = new ProfilingSnapshotStore(inner, { largeThresholdBytes: 10 });
      await store.save(sized("a", 50));
      await expect(store.deleteExecution!("a")).rejects.toThrow("delete failed");
      expect(store.profile().largest.map((l) => l.executionId)).toEqual(["a"]);
      expect(store.trackedCounts().reported).toBe(1);
    });

    it("a failing inner pruneSnapshots leaves the entry tracked", async () => {
      const inner = new InMemoryAsyncSnapshotStore();
      inner.pruneSnapshots = async () => {
        throw new Error("prune failed");
      };
      const store = new ProfilingSnapshotStore(inner);
      await store.save(sized("a", 50, 1));
      await expect(store.pruneSnapshots!("a", { after: 0, before: 9 })).rejects.toThrow(
        "prune failed"
      );
      expect(store.profile().largest.map((l) => l.executionId)).toEqual(["a"]);
    });

    it("close is forwarded to the wrapped store", async () => {
      let closed = 0;
      const bare: SnapshotStore = {
        save: async () => {},
        loadLatest: async () => null,
        loadAt: async () => null,
        loadLatestBefore: async () => null,
        close: async () => {
          closed++;
        },
      };
      await new ProfilingSnapshotStore(bare).close();
      expect(closed).toBe(1);
    });

    it("loadLatestBefore is the latest strictly before, not an exact load (gap case)", async () => {
      const store = new ProfilingSnapshotStore(new InMemoryAsyncSnapshotStore());
      await store.save(sized("a", 20, 2));
      await store.save(sized("a", 20, 4));
      expect((await store.loadLatestBefore("a", 3))?.sequence).toBe(2);
      expect((await store.loadAt("a", 3))).toBeNull();
    });

    it("resetProfile zeroes the WHOLE profile, including the histogram and measurement errors", async () => {
      const store = new ProfilingSnapshotStore(new InMemoryAsyncSnapshotStore(), {
        largeThresholdBytes: 10,
      });
      await store.save(sized("a", 50));
      await store.save(withState({ n: 10n }, "bad"));
      expect(store.profile().measurementErrors).toBe(1);
      store.resetProfile();
      const p = store.profile();
      expect(p).toEqual({
        saves: 0,
        measured: 0,
        measurementErrors: 0,
        totalBytes: 0,
        maxBytes: 0,
        histogram: p.histogram.map((h) => ({ maxBytes: h.maxBytes, count: 0 })),
        largest: [],
      });
      expect(p.histogram).toHaveLength(SIZE_HISTOGRAM_BUCKETS);
      // reusable after a reset
      await store.save(sized("a", 60, 2));
      expect(store.profile().largest).toEqual([{ executionId: "a", bytes: 60, sequence: 2 }]);
    });

    it("a state JSON.stringify cannot represent (undefined) counts as 0 bytes, not an error", async () => {
      const store = new ProfilingSnapshotStore(new InMemoryAsyncSnapshotStore());
      await store.save(withState(undefined, "u"));
      const p = store.profile();
      expect(p.measured).toBe(1);
      expect(p.measurementErrors).toBe(0);
      expect(p.totalBytes).toBe(0);
      expect(p.histogram[0]!.count).toBe(1);
      expect(p.largest).toEqual([{ executionId: "u", bytes: 0, sequence: 1 }]);
    });
  });
});
