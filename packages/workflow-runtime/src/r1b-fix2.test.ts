import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { EventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { build, flow, kinds, settle, until } from "./__tests__/r2Harness";
import type { Harness } from "./__tests__/r2Harness";
import { executionAccessPolicy } from "./executionAccessPolicy";

// R1b fix round 2 (ADR 0109 D4): a client walk is ROUTED to the newest generation (an O(log n)
// probe over the deterministic ids, verified link by link), so the first id stays addressable
// forever; maxChainHops only bounds the residual forward stepping.

const on = { continueAsNewEnabled: true } as const;
const alice = { actor: "alice", tenant: "t1" };
const mallory = { actor: "mallory", tenant: "t2" };
const status = async (h: Harness, id: string) =>
  (await h.rt.loadState(id, h.rt.systemOptions()))?.status;

/** Rotates `n` times immediately, then parks on `end` (resume) / `go` (send). */
const deep = (n: number, park: "suspend" | "receive" = "suspend") =>
  flow<{ g?: number }, unknown>("deep", async (ctx, input) => {
    const g = input?.g ?? 0;
    if (g < n) return ctx.continueAsNew({ g: g + 1 });
    if (park === "receive") {
      await ctx.receive("go");
      return "got";
    }
    await ctx.suspend({ on: "end" });
    return "end";
  });

function counting(inner: EventStore): { store: EventStore; reads: () => number; reset(): void } {
  let n = 0;
  const store = new Proxy(inner, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        if (typeof prop === "string" && /^(read|readRange|readFrom|head)/.test(prop)) n++;
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as EventStore;
  return {
    store,
    reads: () => n,
    reset: () => {
      n = 0;
    },
  };
}

describe("D4 - a client walk routes to the newest generation", () => {
  it("a 200-generation chain resolves from its first id with a bounded read count", async () => {
    const c = counting(new InMemoryAsyncEventStore());
    const h = build({ ...on, maxChainHops: 8 }, { eventStore: c.store });
    const f = deep(200);
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "c" }));
    await until(async () => (await status(h, "c~200")) === "suspended", 20000);
    c.reset();
    const head = await h.rt.followToHead("c");
    expect(head?.executionId).toBe("c~200");
    expect(head?.hops).toBe(200);
    expect(c.reads()).toBeLessThan(60); // gallop + bisect + verification + a few folds, not 200 hops
  }, 60000);

  it("a squatted deepest log written straight to the store is NOT routed to: the verified walk wins", async () => {
    const h = build(on);
    const f = deep(3);
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "c" }));
    await until(async () => (await status(h, "c~3")) === "suspended");
    // c~7 is on the gallop path (1, 3, 7) but its predecessor c~6 does not exist
    await h.eventStore.append({
      id: "c~7-0",
      workflowId: "deep",
      executionId: "c~7",
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: 1,
      payload: {
        input: {},
        chainId: "c",
        generation: 7,
        continuedFrom: { executionId: "c~6" },
      },
    });
    expect((await h.rt.followToHead("c"))?.executionId).toBe("c~3");
    expect(await h.rt.cancel("c", "stop")).toBe(true);
    expect(await status(h, "c~3")).toBe("cancelled");
    expect((await h.eventStore.read("c~7")).length).toBe(1); // untouched
  });

  /** An authorizer that records every executionId it is asked about, then delegates. */
  function recording() {
    const asked: string[] = [];
    const policy = executionAccessPolicy();
    return {
      asked,
      deps: {
        ...on,
        executionAuthorizer: {
          ...policy,
          authorize: (req: { executionId: string }) => {
            asked.push(req.executionId);
            return (policy.authorize as (r: unknown) => { allowed: boolean })(req);
          },
        } as never,
        executionAuthz: { requirePrincipal: true },
      },
    };
  }

  it("resume by the generation-0 id reaches the head past 8 hops, authorized against the head's owner", async () => {
    const { asked, deps } = recording();
    const h = build(deps);
    const f = deep(12);
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "c", principal: alice }));
    await until(async () => (await status(h, "c~12")) === "suspended");
    asked.length = 0;
    await expect(
      h.rt.resume("c", { eventType: "end", payload: 1 }, { principal: mallory })
    ).rejects.toThrow();
    expect(asked.filter((id) => id !== "c")).toEqual([]); // an unauthorized caller reads no chain
    asked.length = 0;
    const handle = await h.rt.resume("c", { eventType: "end", payload: 1 }, { principal: alice });
    await handle.waitForCompletion();
    expect(await status(h, "c~12")).toBe("completed");
    expect(asked[0]).toBe("c"); // the addressed id first...
    expect(asked).toContain("c~12"); // ...then the resolved head's owner
  });

  it("send by the generation-0 id reaches the head past 8 hops, authorized against the head's owner", async () => {
    const { asked, deps } = recording();
    const h = build(deps);
    const f = deep(12, "receive");
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "c", principal: alice }));
    await until(async () => (await status(h, "c~12")) === "suspended");
    asked.length = 0;
    const sent = await h.rt.send("c", { topic: "go", payload: 1 }, { principal: alice });
    expect(sent.executionId).toBe("c~12");
    expect(asked[0]).toBe("c");
    expect(asked).toContain("c~12");
    await until(async () => (await status(h, "c~12")) === "completed");
  });

  it("cancel by the generation-0 id reaches the head past 8 hops, authorized against the head's owner; an unauthorized cancel reads no chain", async () => {
    const { asked, deps } = recording();
    const h = build(deps);
    const f = deep(12);
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "c", principal: alice }));
    await until(async () => (await status(h, "c~12")) === "suspended");
    asked.length = 0;
    await expect(h.rt.cancel("c", "x", { principal: mallory })).rejects.toThrow();
    expect(asked.filter((id) => id !== "c")).toEqual([]);
    expect(await status(h, "c~12")).toBe("suspended");
    asked.length = 0;
    expect(await h.rt.cancel("c", "stop", { principal: alice })).toBe(true);
    expect(await status(h, "c~12")).toBe("cancelled");
    expect(asked).toContain("c~12");
    expect(await kinds(h.eventStore, "c")).not.toContain("EXECUTION_CANCELLED"); // history not rewritten
  });

  it("a consistent forged pair at the deepest ids but ANOTHER owner is not routed to (lineage must match the addressed chain)", async () => {
    const h = build(on);
    const f = deep(3);
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "c", principal: alice }));
    await until(async () => (await status(h, "c~3")) === "suspended");
    const forged = (g: number) => ({
      id: `c~${g}-0`,
      workflowId: "deep",
      executionId: `c~${g}`,
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: 1,
      payload: {
        input: {},
        principal: { v: 1, identity: { actor: "mallory", tenant: "t2" } },
        chainId: "c",
        generation: g,
        continuedFrom: { executionId: g === 6 ? "c~5" : "c~6" },
      },
    });
    await h.eventStore.append(forged(6)); // c~6 -> c~7 is self-consistent; c~5 is absent
    await h.eventStore.append(forged(7));
    expect((await h.rt.followToHead("c"))?.executionId).toBe("c~3");
    const sent = await h.rt.send("c", { topic: "x", payload: 1 }).catch(() => undefined);
    expect(sent === undefined || sent.executionId === "c~3").toBe(true);
  });

  it("a deepest log whose predecessor exists but is NOT the one it names is not routed to", async () => {
    const h = build(on);
    const f = deep(3);
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "c" }));
    await until(async () => (await status(h, "c~3")) === "suspended");
    const planted = (g: number, from: string) => ({
      id: `c~${g}-0`,
      workflowId: "deep",
      executionId: `c~${g}`,
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: 1,
      payload: { input: {}, chainId: "c", generation: g, continuedFrom: { executionId: from } },
    });
    await h.eventStore.append(planted(6, "c~5"));
    await h.eventStore.append(planted(7, "elsewhere")); // c~6 exists, but c~7 names another execution
    expect((await h.rt.followToHead("c"))?.executionId).toBe("c~3");
  });
});
