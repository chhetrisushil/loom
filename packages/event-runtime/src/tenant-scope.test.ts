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
