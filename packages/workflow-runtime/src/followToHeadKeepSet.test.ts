import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { Latch, build, flow, settle, slow, until } from "./__tests__/r2Harness";
import type { Harness } from "./__tests__/r2Harness";
import { deepestGeneration, routeKeepSet } from "./continuation";

// ADR 0109 residual (0) / ADR 0145: followToHead tolerates RETENTION-RECLAIMED intermediate
// generations. The kernel and the retention pin share ONE search (`deepestGeneration`) and ONE
// keep-set (`routeKeepSet`); these tests pin both sides, by call counts, never by time.

const on = { continueAsNewEnabled: true } as const;
const SEQ0 = /^(.+)~(\d+)$/;

/** Counts (and can intercept) every sequence-0 point read, the kernel's existence/verification read. */
class SpyStore extends InMemoryAsyncEventStore {
  readonly seq0Reads: string[] = [];
  onSeq0?: (id: string) => Promise<void>;
  override async readRange(id: string, from: number, to: number): Promise<EventEnvelope[]> {
    if (from === 0 && to === 0) {
      this.seq0Reads.push(id);
      await this.onSeq0?.(id);
    }
    return super.readRange(id, from, to);
  }
}

const deep = (n: number, hold?: boolean) =>
  flow<{ g?: number }, unknown>("deep", async (ctx, input) => {
    const g = input?.g ?? 0;
    if (g < n) return ctx.continueAsNew({ g: g + 1 });
    if (hold === true) {
      await ctx.run(slow, "x");
      return "end";
    }
    await ctx.suspend({ on: "end" });
    return "end";
  });
const idOf = (g: number): string => (g === 0 ? "c" : `c~${g}`);
const status = async (h: Harness, id: string) =>
  (await h.rt.loadState(id, h.rt.systemOptions()))?.status;

async function chain(n: number, opts: { hold?: boolean; latch?: Latch } = {}) {
  const store = new SpyStore();
  const h = build(on, { eventStore: store, ...(opts.latch && { latch: opts.latch }) });
  const f = deep(n, opts.hold);
  h.rt.registerFlow(f.definition, f.runner);
  await settle(await h.rt.start(f, {}, { executionId: "c" }));
  if (opts.hold === true) {
    await until(async () => (await status(h, idOf(n))) === "running");
  } else {
    await until(async () => (await status(h, idOf(n))) === "suspended");
  }
  return { h, store };
}
/** Delete every intermediate generation outside K(head) (what retention may now release). */
async function reclaim(store: SpyStore, head: number): Promise<number[]> {
  const keep = routeKeepSet(head);
  const gone: number[] = [];
  for (let g = 1; g < head; g++) {
    if (!keep.has(g)) {
      await store.deleteExecution?.(idOf(g));
      gone.push(g);
    }
  }
  return gone;
}
const survivors = (head: number): number[] => [...routeKeepSet(head)].filter((g) => g < head);

describe("group 1 - the shared pure search", () => {
  it("with ONLY K(H) present the search returns H from every survivor and reads nothing outside K(H) (exhaustive to 2000)", async () => {
    for (let H = 1; H <= 2000; H++) {
      const keep = routeKeepSet(H);
      for (const g of keep) {
        const known = g < H ? g + 1 : g;
        const read: number[] = [];
        const d = await deepestGeneration(known, async (q) => {
          read.push(q);
          return keep.has(q);
        });
        if (d !== H) throw new Error(`H=${H} from ${g}: got ${d}`);
        for (const q of read) {
          // a probe may be ABSENT (it must be beyond H), but never a present non-K generation
          if (q <= H && !keep.has(q)) throw new Error(`H=${H} from ${g} read ${q} outside K`);
        }
      }
      // |K| ~ 2*log2(H)
      expect(keep.size).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(H + 1)) + 2);
    }
  }, 60000);

  it("monotone: a generation outside K(H) stays outside K(H') for every H' >= H (all pairs to 400)", () => {
    const ks: ReadonlySet<number>[] = [];
    for (let H = 0; H <= 400; H++) ks.push(routeKeepSet(H));
    for (let H = 0; H <= 400; H++) {
      for (let H2 = H; H2 <= 400; H2++) {
        for (const m of ks[H2] as ReadonlySet<number>) {
          if (m <= H && !(ks[H] as ReadonlySet<number>).has(m)) {
            throw new Error(`m=${m} in K(${H2}) but not K(${H})`);
          }
        }
      }
    }
  }, 60000);

  it("answers at or below `known` cost no read", async () => {
    let reads = 0;
    const d = await deepestGeneration(3, async (q) => {
      reads++;
      return q <= 3;
    });
    expect(d).toBe(3);
    expect(reads).toBe(3); // 7, 5 and 4 (all absent); 1 and 3 are known
  });
});

describe("group 2 - the kernel over a reclaimed chain", () => {
  it("40 generations, everything outside K(40) deleted: every follower from every survivor reaches c~40 within the read bound", async () => {
    const { h, store } = await chain(40);
    const gone = await reclaim(store, 40);
    expect(gone.length).toBeGreaterThan(20);
    const keep = routeKeepSet(40);
    for (const g of survivors(40)) {
      store.seq0Reads.length = 0;
      const r = await h.rt.followToHead(idOf(g));
      expect(r?.executionId, `from ${idOf(g)}`).toBe("c~40");
      // the strongest bound: every successor-id read is a member of K(40); never a reclaimed one
      for (const id of store.seq0Reads) {
        const m = SEQ0.exec(id);
        // an ABSENT id (beyond the head) may be probed; a PRESENT one must be in K(40)
        if (m !== null && Number(m[2]) <= 40) {
          expect(keep.has(Number(m[2])), `${id} read from ${idOf(g)}`).toBe(true);
        }
      }
      expect(store.seq0Reads.length).toBeLessThanOrEqual(24);
    }
  }, 60000);

  it("resume from the original id reaches the head over a reclaimed chain", async () => {
    const { h, store } = await chain(40);
    await reclaim(store, 40);
    await h.rt.resume("c", { eventType: "end", payload: 1 });
    await until(async () => (await status(h, "c~40")) === "completed");
  }, 60000);

  it("cancel from the original id reaches the head over a reclaimed chain", async () => {
    const { h, store } = await chain(40);
    await reclaim(store, 40);
    expect(await h.rt.cancel("c", "stop")).toBe(true);
    expect(await status(h, "c~40")).toBe("cancelled");
  }, 60000);

  it("send from the original id resolves to the head over a reclaimed chain", async () => {
    const { h, store } = await chain(40);
    await reclaim(store, 40);
    const sent = await h.rt.send("c", { topic: "go", payload: 1, messageId: "m1" });
    expect(sent.executionId).toBe("c~40");
  }, 60000);

  it("the head's predecessor is part of K (a head whose H-1 is not a search probe, e.g. 9) and the head verifies against it", async () => {
    expect(routeKeepSet(9).has(8)).toBe(true);
    const { h, store } = await chain(9);
    const gone = await reclaim(store, 9);
    expect(gone).toEqual([2, 4, 5, 6]);
    expect((await h.rt.followToHead("c"))?.executionId).toBe("c~9");
    await store.deleteExecution?.("c~8"); // the verification link itself: refused, never routed past
    expect((await h.rt.followToHead("c"))?.executionId).not.toBe("c~9");
  });

  it("deleting c~2 (outside K(4)) leaves c~4 reachable from c", async () => {
    const { h, store } = await chain(4);
    await store.deleteExecution?.("c~2");
    expect((await h.rt.followToHead("c"))?.executionId).toBe("c~4");
    expect((await h.rt.followToHead("c~1"))?.executionId).toBe("c~4");
    expect((await h.rt.followToHead("c~3"))?.executionId).toBe("c~4");
  });

  it("HOT PATH: a RUNNING head g reads only g+1 (the router's one existence read + the walk's own probe), for every g", async () => {
    for (const g of [1, 2, 3, 4, 5, 6, 7]) {
      const latch = new Latch();
      const { h, store } = await chain(g, { hold: true, latch });
      store.seq0Reads.length = 0;
      const r = await h.rt.followToHead(idOf(g));
      expect(r?.executionId).toBe(idOf(g));
      const successorReads = store.seq0Reads.filter((id) => id !== idOf(g));
      // ONE existence read in the router (g+1, absent -> stop) and the walk's own successor probe
      // reads the same id once more: exactly what the gallop did before this change.
      expect(successorReads, `head ${g}`).toEqual([idOf(g + 1), idOf(g + 1)]);
      latch.release();
    }
  }, 60000);
});

describe("group 3 - verification is as strong as before", () => {
  const plant = (id: string, over: Record<string, unknown>): EventEnvelope =>
    ({
      id: `${id}-0`,
      workflowId: "deep",
      executionId: id,
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: 1,
      payload: {
        input: {},
        chainId: "c",
        generation: 41,
        continuedFrom: { executionId: "c~40" },
        ...over,
      },
    }) as unknown as EventEnvelope;

  for (const [name, over] of [
    [
      "a squatter that does not name its predecessor",
      { continuedFrom: { executionId: "elsewhere" } },
    ],
    [
      "a forged head owned by another principal",
      { principal: { v: 1, identity: { actor: "mallory", tenant: "t2" } } },
    ],
    ["a squatter with the wrong generation", { generation: 7 }],
  ] as const) {
    it(`${name} beyond the head is never routed to; the squatter is left untouched`, async () => {
      const { h, store } = await chain(40);
      await reclaim(store, 40);
      await store.append(plant("c~41", over));
      let r: Awaited<ReturnType<typeof h.rt.followToHead>> | undefined;
      try {
        r = await h.rt.followToHead("c");
      } catch {
        /* a typed refusal is acceptable: liveness only */
      }
      expect(r?.executionId).not.toBe("c~41");
      expect((await store.read("c~41")).length).toBe(1);
      // addressing a verified survivor still reaches the real head? the squatter shadows the search
      // (it is the deepest EXISTING id), so refusal to route is the safe outcome.
      await expect(h.rt.resume("c~41", { eventType: "end", payload: 1 })).rejects.toThrow();
    }, 60000);
  }

  it("a re-planted reclaimed intermediate OUTSIDE K is never read, so never routed to", async () => {
    const { h, store } = await chain(40);
    await reclaim(store, 40);
    await store.append(plant("c~5", { generation: 5, continuedFrom: { executionId: "c~4" } }));
    store.seq0Reads.length = 0;
    expect((await h.rt.followToHead("c"))?.executionId).toBe("c~40");
    expect(store.seq0Reads).not.toContain("c~5");
  }, 60000);
});

describe("group 5 - races", () => {
  it("a walk that read head H and finds H-1 gone (retention after a rotation) succeeds on the single retry", async () => {
    const { h, store } = await chain(9);
    expect(routeKeepSet(10).has(8)).toBe(false); // H-1 of the old head is releasable once the head is 10
    const c9 = (await store.read("c~9"))[0] as EventEnvelope;
    let fired = false;
    store.onSeq0 = async (id) => {
      if (id !== "c~8" || fired) return;
      fired = true;
      // the chain rotates to 10 and retention releases 8, between the walk's two reads
      await store.append({
        ...c9,
        id: "c~10-0",
        executionId: "c~10",
        payload: {
          ...(c9.payload as object),
          generation: 10,
          continuedFrom: { executionId: "c~9" },
        },
      } as EventEnvelope);
      await store.deleteExecution?.("c~8");
    };
    expect((await h.rt.followToHead("c"))?.executionId).toBe("c~10");
    expect(fired).toBe(true);
  });
});
