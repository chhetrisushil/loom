import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { InMemoryAsyncEventStore } from "./InMemoryAsyncEventStore";
import { TenantScopedEventStore } from "./TenantScopedEventStore";

function ev(executionId: string, sequence: number): EventEnvelope {
  return {
    id: `${executionId}-${sequence}`,
    workflowId: "wf",
    executionId,
    eventType: "STEP_COMPLETED",
    sequence,
    timestamp: 1000 + sequence,
    payload: { n: sequence },
  };
}

describe("K12.5 — tenant-scoped store (cross-tenant isolation by construction)", () => {
  it("the app sees its own unprefixed ids; tenants cannot read each other's executions", async () => {
    const shared = new InMemoryAsyncEventStore();
    const a = new TenantScopedEventStore(shared, "acme");
    const b = new TenantScopedEventStore(shared, "globex");

    // Both tenants use the SAME executionId "run-1" — no collision, no leak.
    await a.append(ev("run-1", 0));
    await b.append(ev("run-1", 0));

    const aEvents = await a.read("run-1");
    const bEvents = await b.read("run-1");
    expect(aEvents.length).toBe(1);
    expect(bEvents.length).toBe(1);
    // Each tenant sees its OWN unprefixed id back.
    expect(aEvents[0]?.executionId).toBe("run-1");
    expect(bEvents[0]?.executionId).toBe("run-1");
    // But they are physically distinct rows in the shared store.
    expect((aEvents[0]?.payload as { n: number }).n).toBe(0);

    // Tenant A cannot address tenant B's data — a read of an id it never wrote is empty,
    // and there is NO id it can pass to reach B's rows (the prefix is applied internally).
    await a.append(ev("secret-a", 5));
    expect(await b.read("secret-a")).toEqual([]); // B sees nothing of A's
    expect((await a.read("secret-a")).length).toBe(1);
  });

  it("subscriptions are tenant-scoped (no cross-tenant delivery)", async () => {
    const shared = new InMemoryAsyncEventStore();
    const a = new TenantScopedEventStore(shared, "acme");
    const b = new TenantScopedEventStore(shared, "globex");

    const aSeen: string[] = [];
    await a.subscribe("run-1", (e) => aSeen.push(e.executionId));

    await b.append(ev("run-1", 0)); // B's write on the same logical id
    await a.append(ev("run-1", 1)); // A's write
    await new Promise((r) => setTimeout(r, 5));

    // A's subscriber saw only A's event, with the unprefixed id.
    expect(aSeen).toEqual(["run-1"]);
  });

  it("forwards fencing/deletion within the tenant scope", async () => {
    const shared = new InMemoryAsyncEventStore();
    const a = new TenantScopedEventStore(shared, "acme");
    const fence = await a.acquireFence?.("run-1");
    expect(fence).toBe(1);
    await a.append({ ...ev("run-1", 0), metadata: { fence } });
    expect((await a.read("run-1")).length).toBe(1);
    await a.deleteExecution?.("run-1");
    expect(await a.read("run-1")).toEqual([]);
  });
});

describe("K12.5 — tenant-scoped paged enumeration (L1: listExecutionsPage is no longer dropped)", () => {
  async function seeded() {
    const shared = new InMemoryAsyncEventStore();
    // Tenants whose ranges interleave nothing but sit on either side of each other, plus an
    // unscoped id that sorts before them — the shapes the range logic has to get right.
    for (const id of [
      "aaa:x",
      "acme:r1",
      "acme:r2",
      "acme:r3",
      "acme:r4",
      "acme:r5",
      "globex:r1",
    ]) {
      await shared.append(ev(id, 0));
    }
    return shared;
  }

  it("pages only its own ids, stripped, each exactly once, in order", async () => {
    const acme = new TenantScopedEventStore(await seeded(), "acme");
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await acme.listExecutionsPage!({
        ...(cursor !== undefined && { cursor }),
        limit: 2,
      });
      expect(page.executionIds.length).toBeLessThanOrEqual(2);
      seen.push(...page.executionIds);
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(["r1", "r2", "r3", "r4", "r5"]);
  });

  it("finds every id even when the store's order interleaves other ids into its range", async () => {
    // Postgres pages in the database collation, not code-unit order: on an en_US cluster
    // "a~" sorts before "ab". A scan that stopped at the first id past `acme:` would miss
    // whatever the collation puts after it. This inner store returns a deliberately
    // non-code-unit order to prove the decorator never relies on one.
    const ids = ["acme:r1", "acmex", "acme:r2", "zeta:1", "acme:r3"];
    const events = new InMemoryAsyncEventStore();
    for (const id of ids) await events.append(ev(id, 0));
    const shuffled = new Proxy(events, {
      get(target, prop, receiver) {
        if (prop === "listExecutionsPage") {
          return async (opts?: { cursor?: string; limit?: number }) => {
            const start = opts?.cursor === undefined ? 0 : Number(opts.cursor);
            const limit = opts?.limit ?? 1000;
            const executionIds = ids.slice(start, start + limit);
            const next = start + limit;
            return next < ids.length
              ? { executionIds, nextCursor: String(next) }
              : { executionIds };
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const acme = new TenantScopedEventStore(shuffled, "acme");
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await acme.listExecutionsPage!({
        ...(cursor !== undefined && { cursor }),
        limit: 2,
      });
      seen.push(...page.executionIds);
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(["r1", "r2", "r3"]);
  });

  it("refuses a non-advancing inner cursor instead of spinning", async () => {
    const events = new InMemoryAsyncEventStore();
    await events.append(ev("other:1", 0));
    const stuck = new Proxy(events, {
      get(target, prop, receiver) {
        if (prop === "listExecutionsPage") {
          return async () => ({ executionIds: ["other:1"], nextCursor: "same" });
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const acme = new TenantScopedEventStore(stuck, "acme");
    await expect(acme.listExecutionsPage!({ cursor: "same", limit: 1 })).rejects.toThrow(
      /non-advancing cursor/
    );
  });

  it("an empty tenant pages to an empty, final result", async () => {
    const nobody = new TenantScopedEventStore(await seeded(), "nobody");
    expect(await nobody.listExecutionsPage!({ limit: 2 })).toEqual({ executionIds: [] });
  });
});
