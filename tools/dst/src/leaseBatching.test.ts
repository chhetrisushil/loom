import { describe, expect, it } from "vitest";
import { advance, flaky, rig, until } from "./__tests__/leaseRig";

// ── The lease overhead is BATCHED, deterministically (ADR 0130 D11, S7f) ──────────────────────────
//
// Call counts, not time: N concurrent executions in flight on one node cost ONE renew call per
// chunk per tick (never one per execution), and the acquires/releases are group-committed.

describe("lease batching", () => {
  const N = 50;
  const CHUNK = 20; // => ceil(50 / 20) = 3 chunks

  it("N concurrent executions: renewMany is one call per chunk per tick, and no per-id renew is ever made", async () => {
    const r = rig();
    const f = flaky(r.leases);
    const a = r.node("a", { leaseStore: f.store, heartbeat: { chunkSize: CHUNK } });
    const ids = Array.from({ length: N }, (_, i) => `batch-${i}`);
    const handles = await Promise.all(
      ids.map((id) => a.rt.start(r.flow, { id }, { executionId: id }))
    );
    await until(() => ids.every((id) => r.probe.count(id, "b") === 1), "all inside step b");
    expect(a.rt.leaseKeeper?.size).toBe(N);

    // Acquires were group-committed: far fewer store calls than executions, and none per-id.
    const acquireCalls = (f.calls.get("acquireMany") ?? 0) + (f.calls.get("acquire") ?? 0);
    expect(f.calls.get("acquire") ?? 0).toBe(0);
    expect(acquireCalls).toBeLessThan(N / 2);

    const chunks = Math.ceil(N / CHUNK);
    for (let tick = 1; tick <= 4; tick++) {
      advance(r.clock, 10_000);
      await a.tick();
      expect(f.calls.get("renewMany") ?? 0, `after tick ${tick}`).toBe(tick * chunks);
      expect(f.calls.get("renew") ?? 0).toBe(0);
    }
    expect(a.errors).toEqual([]);

    for (const id of ids) r.probe.gate(id).open();
    await Promise.all(handles.map((h) => h.waitForCompletion()));
    // Releases were group-committed too, and every lease is gone.
    expect(f.calls.get("release") ?? 0).toBe(0);
    expect(f.calls.get("releaseMany") ?? 0).toBeLessThan(N / 2);
    expect(a.rt.leaseKeeper?.size).toBe(0);
    for (const id of ids) expect((await r.leases.get?.(id)) ?? null).toBeNull();
  });

  it("with the default chunk size N executions are exactly ONE renewMany call per tick", async () => {
    const r = rig();
    const f = flaky(r.leases);
    const a = r.node("a", { leaseStore: f.store });
    const ids = Array.from({ length: N }, (_, i) => `one-${i}`);
    const handles = await Promise.all(
      ids.map((id) => a.rt.start(r.flow, { id }, { executionId: id }))
    );
    await until(() => ids.every((id) => r.probe.count(id, "b") === 1), "all inside step b");
    for (let tick = 1; tick <= 3; tick++) {
      advance(r.clock, 10_000);
      await a.tick();
      expect(f.calls.get("renewMany") ?? 0).toBe(tick);
    }
    for (const id of ids) r.probe.gate(id).open();
    await Promise.all(handles.map((h) => h.waitForCompletion()));
  });
});
