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

  it("hands out its OWN ids as cursors, so a caller can resume it from any id (L10)", async () => {
    // What `ShardedEventStore` does: resume from the last id of a merged page, which it
    // only ever sees unprefixed. The prefixed inner cursor used to leak out instead.
    const acme = new TenantScopedEventStore(await seeded(), "acme");
    const first = await acme.listExecutionsPage!({ limit: 2 });
    expect(first).toEqual({ executionIds: ["r1", "r2"], nextCursor: "r2" });
    expect(await acme.listExecutionsPage!({ cursor: "r3", limit: 100 })).toEqual({
      executionIds: ["r4", "r5"],
    });
    // A cursor this tenant never handed out resumes strictly after it, too.
    expect(await acme.listExecutionsPage!({ cursor: "r25", limit: 100 })).toEqual({
      executionIds: ["r3", "r4", "r5"],
    });
  });

  it("stops at the end of its own range instead of walking the rest of the store", async () => {
    // SPI 2.0.0 guarantees code point order, where a tenant's ids are contiguous. Counting
    // inner pages proves the walk ends at the first id past `acme:`, not at the store's end.
    const events = new InMemoryAsyncEventStore();
    for (const id of ["acme:r1", "acme:r2", ...Array.from({ length: 50 }, (_, i) => `zeta:${i}`)]) {
      await events.append(ev(id, 0));
    }
    let innerPages = 0;
    const counted = new Proxy(events, {
      get(target, prop, receiver) {
        if (prop === "listExecutionsPage") {
          return (opts?: { cursor?: string; limit?: number }) => {
            innerPages++;
            return target.listExecutionsPage(opts);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const acme = new TenantScopedEventStore(counted, "acme");
    expect(await acme.listExecutionsPage!({ limit: 5 })).toEqual({ executionIds: ["r1", "r2"] });
    expect(innerPages).toBe(1);
  });

  it("finds its blank stream and skips a tenant whose name it prefixes", async () => {
    // "acme-corp:…" sorts BETWEEN "acme" and "acme:" ('-' < ':'), and "acme:" itself is the
    // tenant's blank stream (executionId ""), which repair must still be able to enumerate.
    const events = new InMemoryAsyncEventStore();
    for (const id of ["acme-corp:x", "acme:", "acme:r1", "acmex"]) await events.append(ev(id, 0));
    const acme = new TenantScopedEventStore(events, "acme");
    expect(await acme.listExecutionsPage!({ limit: 1 })).toEqual({
      executionIds: [""],
      nextCursor: "",
    });
    expect(await acme.listExecutionsPage!({ cursor: "", limit: 1 })).toEqual({
      executionIds: ["r1"],
      nextCursor: "r1",
    });
    expect(await acme.listExecutionsPage!({ cursor: "r1", limit: 1 })).toEqual({
      executionIds: [],
    });
  });

  it("a fresh scan never reads tenants whose names extend its own ('acme-eu', 'acme.io', 'acme0')", async () => {
    const events = new InMemoryAsyncEventStore();
    const others = ["acme-eu", "acme.io", "acme0", "acme9"].flatMap((t) =>
      Array.from({ length: 20 }, (_, i) => `${t}:${i}`)
    );
    for (const id of [...others, "acme:", "acme:r1"]) await events.append(ev(id, 0));
    const read: string[] = [];
    const recording = new Proxy(events, {
      get(target, prop, receiver) {
        if (prop === "listExecutionsPage") {
          return async (opts?: { cursor?: string; limit?: number }) => {
            const page = await target.listExecutionsPage(opts);
            read.push(...page.executionIds);
            return page;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const acme = new TenantScopedEventStore(recording, "acme");
    expect(await acme.listExecutionsPage!({ limit: 10 })).toEqual({ executionIds: ["", "r1"] });
    expect(read).toEqual(["acme:", "acme:r1"]);
  });

  it("refuses a non-advancing inner cursor instead of spinning", async () => {
    const events = new InMemoryAsyncEventStore();
    await events.append(ev("acme-corp:1", 0));
    const stuck = new Proxy(events, {
      get(target, prop, receiver) {
        if (prop === "listExecutionsPage") {
          // Another tenant's id (inside the walked gap, so not "past" acme) and a cursor that
          // never moves off where this decorator started.
          return async () => ({ executionIds: ["acme-corp:1"], nextCursor: "acme9\u{10FFFF}" });
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const acme = new TenantScopedEventStore(stuck, "acme");
    await expect(acme.listExecutionsPage!({ limit: 1 })).rejects.toThrow(/non-advancing cursor/);
  });

  it("an empty tenant pages to an empty, final result", async () => {
    const nobody = new TenantScopedEventStore(await seeded(), "nobody");
    expect(await nobody.listExecutionsPage!({ limit: 2 })).toEqual({ executionIds: [] });
  });
});

describe("K12.5 — a tenant name cannot contain the separator", () => {
  it('rejects a tenant containing \':\' — tenant "a" would otherwise prefix-match "a:b"\'s ids', () => {
    const shared = new InMemoryAsyncEventStore();
    // Tenant "a" scopes "b:x" to "a:b:x", which is exactly tenant "a:b"'s "x" — one tenant
    // could address (and enumerate, via the prefix filter) another's executions.
    expect(() => new TenantScopedEventStore(shared, "a:b")).toThrow(/separator/);
    expect(() => new TenantScopedEventStore(shared, "")).toThrow(/tenant/);
    expect(() => new TenantScopedEventStore(shared, "acme")).not.toThrow();
  });
});
