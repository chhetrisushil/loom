import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { InMemoryAsyncEventStore } from "./InMemoryAsyncEventStore";
import { ShardPlan } from "./ShardPlan";
import { ShardedEventStore } from "./ShardedEventStore";

const evt = (executionId: string, sequence: number): EventEnvelope => ({
  id: `${executionId}-${sequence}`,
  workflowId: "wf",
  executionId,
  eventType: sequence === 0 ? "EXECUTION_STARTED" : "STEP_COMPLETED",
  sequence,
  timestamp: 1000 + sequence,
  payload: { sequence },
});

const shards = (n: number) => Array.from({ length: n }, () => new InMemoryAsyncEventStore());

/**
 * Ids that land in a migrating bucket under `plan`. Asks the plan rather than
 * reimplementing its assignment — an earlier version of this helper duplicated the
 * `bucket % shardCount` logic and silently went stale when the assignment became
 * minimal-movement.
 */
function migratingIds(plan: ShardPlan, ids: string[]): string[] {
  return ids.filter((id) => plan.placementAt(plan.bucketFor(id)).kind === "migrating");
}

describe("ShardPlan", () => {
  it("spreads buckets over shards and round-trips through JSON", () => {
    const plan = ShardPlan.uniform(3, 64);
    expect(plan.shardCount).toBe(3);
    expect(plan.buckets).toBe(64);
    expect(plan.isStable).toBe(true);
    const back = ShardPlan.fromJSON(plan.toJSON());
    expect(back.toJSON()).toEqual(plan.toJSON());
  });

  it("moves the theoretical MINIMUM of buckets when growing", () => {
    // Going from N to M shards, at least total*(1 - N/M) buckets must move — that is simply
    // the share the new shards have to end up holding. Anything above it is wasted copying.
    //
    // This assertion is deliberately tight. The first implementation assigned
    // `bucket % shardCount`, which passed a loose "< 85%" check while actually moving 80%
    // of buckets on 4→5 and 89% on 8→9 — i.e. no better than the `hash % shardCount`
    // routing that virtual buckets exist to escape.
    const total = 4096;
    for (const [from, to] of [
      [4, 5],
      [2, 3],
      [8, 9],
      [3, 6],
    ]) {
      const grown = ShardPlan.uniform(from as number, total).rebalanced(to as number);
      const moved = grown.migratingBuckets().length;
      const minimum = Math.ceil(total * (1 - (from as number) / (to as number)));
      expect(moved).toBeGreaterThan(0);
      expect(moved).toBeLessThanOrEqual(minimum);
      expect(grown.shardCount).toBe(to);
      expect(grown.isStable).toBe(false);
    }
  });

  it("ends balanced — every shard within one bucket of its fair share", () => {
    const total = 4096;
    const grown = ShardPlan.uniform(4, total).rebalanced(7);
    const load = new Array<number>(7).fill(0);
    for (let b = 0; b < total; b++) {
      const p = grown.placementAt(b);
      load[p.kind === "settled" ? p.shard : p.to]!++;
    }
    const fair = total / 7;
    for (const n of load) expect(Math.abs(n - fair)).toBeLessThanOrEqual(1);
    expect(load.reduce((a, b) => a + b, 0)).toBe(total);
  });

  it("is deterministic — two nodes computing the same rebalance agree", () => {
    // Nodes must derive identical plans or the log splits.
    const a = ShardPlan.uniform(4, 512).rebalanced(6);
    const b = ShardPlan.uniform(4, 512).rebalanced(6);
    expect(a.toJSON()).toEqual(b.toJSON());
  });

  it("refuses to re-plan while a migration is outstanding", () => {
    const migrating = ShardPlan.uniform(2, 16).rebalanced(3);
    expect(() => migrating.rebalanced(4)).toThrow(/still migrating/);
  });

  it("refuses to shrink without an explicit opt-in", () => {
    const plan = ShardPlan.uniform(4, 64);
    expect(() => plan.rebalanced(2)).toThrow(/removes capacity/);
    expect(plan.rebalanced(2, { allowShrink: true }).shardCount).toBe(2);
  });

  it("settles a bucket onto its destination", () => {
    const plan = ShardPlan.uniform(2, 16).rebalanced(3);
    const bucket = plan.migratingBuckets()[0] as number;
    const placement = plan.placementAt(bucket);
    expect(placement.kind).toBe("migrating");
    const settled = plan.settled(bucket);
    expect(settled.placementAt(bucket)).toEqual({
      kind: "settled",
      shard: (placement as { to: number }).to,
    });
    // Immutable — the original is untouched.
    expect(plan.placementAt(bucket).kind).toBe("migrating");
  });

  it("rejects a plan referencing a shard that does not exist", () => {
    expect(() =>
      ShardPlan.fromJSON({ version: 1, shardCount: 2, placements: [{ shard: 5 }] })
    ).toThrow(/outside 0\.\.1/);
  });

  it("rejects fewer buckets than shards", () => {
    expect(() => ShardPlan.uniform(8, 4)).toThrow(/at least as many buckets/);
  });
});

describe("ShardedEventStore — rebalancing", () => {
  const ids = Array.from({ length: 300 }, (_, i) => `exec-${i}`);

  it("keeps serving executions that stay on the source while a bucket migrates", async () => {
    const pool = shards(3);
    const plan = ShardPlan.uniform(2, 256);
    // Start on 2 shards (the third is spare capacity being added).
    const store = new ShardedEventStore(pool.slice(0, 2), { plan });
    for (const id of ids) {
      await store.append(evt(id, 0));
      await store.append(evt(id, 1));
    }

    // Grow to 3. Routing changes; NOTHING is copied.
    const grown = plan.rebalanced(3);
    const grownStore = new ShardedEventStore(pool, { plan: grown });

    // Every pre-existing execution is still readable and still appendable, wherever it
    // physically lives — that is the whole promise of a no-downtime rebalance.
    for (const id of ids) {
      expect((await grownStore.read(id)).map((e) => e.sequence)).toEqual([0, 1]);
      await grownStore.append(evt(id, 2));
      expect((await grownStore.read(id)).map((e) => e.sequence)).toEqual([0, 1, 2]);
    }
    await grownStore.close();
  });

  it("starts NEW executions on the destination of a migrating bucket", async () => {
    const pool = shards(3);
    const plan = ShardPlan.uniform(2, 256);
    const seed = new ShardedEventStore(pool.slice(0, 2), { plan });
    await seed.append(evt("existing", 0));

    const grown = plan.rebalanced(3);
    const store = new ShardedEventStore(pool, { plan: grown });
    const bucket = grown.bucketFor("existing");
    const placement = grown.placementAt(bucket);

    // Find a fresh id in a migrating bucket and confirm it lands on the destination.
    const fresh = ids.find((id) => grown.placementAt(grown.bucketFor(id)).kind === "migrating");
    expect(fresh).toBeDefined();
    const target = grown.placementAt(grown.bucketFor(fresh as string)) as { to: number };
    await store.append(evt(fresh as string, 0));
    expect((await pool[target.to]!.read(fresh as string)).length).toBe(1);

    // …while the pre-existing one is untouched on whichever side already had it.
    if (placement.kind === "migrating") {
      expect((await pool[placement.from]!.read("existing")).length).toBe(1);
      expect((await pool[placement.to]!.read("existing")).length).toBe(0);
    }
    await store.close();
  });

  it("migrateExecution copies then deletes, and routing follows", async () => {
    const pool = shards(3);
    const plan = ShardPlan.uniform(2, 256);
    const grown = plan.rebalanced(3);
    const seed = new ShardedEventStore(pool.slice(0, 2), { plan });
    const moving = migratingIds(grown, ids);
    expect(moving.length).toBeGreaterThan(0);
    const id = moving[0] as string;
    for (let s = 0; s < 4; s++) await seed.append(evt(id, s));

    const store = new ShardedEventStore(pool, { plan: grown });
    const placement = grown.placementAt(grown.bucketFor(id)) as { from: number; to: number };

    expect((await pool[placement.from]!.read(id)).length).toBe(4);
    const result = await store.migrateExecution(id);
    expect(result).toEqual({ executionId: id, outcome: "moved", events: 4 });
    // Copied to the destination, removed from the source, and reads keep working throughout.
    expect((await pool[placement.to]!.read(id)).map((e) => e.sequence)).toEqual([0, 1, 2, 3]);
    expect(await pool[placement.from]!.read(id)).toEqual([]);
    expect((await store.read(id)).map((e) => e.sequence)).toEqual([0, 1, 2, 3]);

    // Idempotent.
    expect((await store.migrateExecution(id)).outcome).toBe("already-there");
    await store.close();
  });

  it("reports a bucket drained only once its source side is empty, and settles cleanly", async () => {
    const pool = shards(3);
    const plan = ShardPlan.uniform(2, 256);
    const grown = plan.rebalanced(3);
    const seed = new ShardedEventStore(pool.slice(0, 2), { plan });
    const id = migratingIds(grown, ids)[0] as string;
    await seed.append(evt(id, 0));

    const store = new ShardedEventStore(pool, { plan: grown });
    const bucket = grown.bucketFor(id);

    expect(await store.isBucketDrained(bucket)).toBe(false);
    await store.migrateExecution(id);
    expect(await store.isBucketDrained(bucket)).toBe(true);

    // Settling retires the two-sided lookup; reads must still resolve.
    store.setPlan(grown.settled(bucket));
    expect(store.shardPlan?.placementAt(bucket).kind).toBe("settled");
    expect((await store.read(id)).length).toBe(1);
    await store.close();
  });

  it("survives a crash between copy and delete — the execution resolves to the destination", async () => {
    const pool = shards(3);
    const plan = ShardPlan.uniform(2, 256);
    const grown = plan.rebalanced(3);
    const seed = new ShardedEventStore(pool.slice(0, 2), { plan });
    const id = migratingIds(grown, ids)[0] as string;
    await seed.append(evt(id, 0));
    await seed.append(evt(id, 1));

    const placement = grown.placementAt(grown.bucketFor(id)) as { from: number; to: number };
    // Simulate the crash: the copy landed, the delete never ran.
    await pool[placement.to]!.appendBatch!(await pool[placement.from]!.read(id));

    const store = new ShardedEventStore(pool, { plan: grown });
    // Resolves to the destination (checked first), so reads see the surviving copy…
    expect((await store.read(id)).map((e) => e.sequence)).toEqual([0, 1]);
    // …and a re-run finishes the job rather than duplicating it.
    expect((await store.migrateExecution(id)).outcome).toBe("already-there");
    // Enumeration reports it once despite existing on both sides.
    expect((await store.listExecutions!()).filter((x) => x === id).length).toBe(1);
    await store.close();
  });

  it("routes identically to pre-0075 when no plan is supplied", async () => {
    const withPlan = shards(3);
    const without = shards(3);
    const planned = new ShardedEventStore(withPlan);
    const legacy = new ShardedEventStore(without);
    for (const id of ids.slice(0, 50)) {
      await planned.append(evt(id, 0));
      await legacy.append(evt(id, 0));
    }
    // Same routing ⇒ same per-shard distribution, execution for execution.
    for (let s = 0; s < 3; s++) {
      expect((await withPlan[s]!.listExecutions!()).sort()).toEqual(
        (await without[s]!.listExecutions!()).sort()
      );
    }
    expect(planned.shardPlan).toBeUndefined();
    await planned.close();
    await legacy.close();
  });

  it("rejects a plan whose shard count disagrees with the store", () => {
    expect(() => new ShardedEventStore(shards(2), { plan: ShardPlan.uniform(3, 64) })).toThrow(
      /plan expects 3 shards but the store has 2/
    );
  });

  it("bounds the placement cache", async () => {
    const pool = shards(3);
    const plan = ShardPlan.uniform(2, 256).rebalanced(3);
    const store = new ShardedEventStore(pool, { plan, placementCacheSize: 8 });
    for (const id of ids.slice(0, 60)) await store.append(evt(id, 0));
    // biome-ignore lint/suspicious/noExplicitAny: asserting the bound needs the private map.
    expect((store as any).placementCache.size).toBeLessThanOrEqual(8);
    // Still correct after eviction — resolution falls back to the point-reads.
    for (const id of ids.slice(0, 60)) expect((await store.read(id)).length).toBe(1);
    await store.close();
  });
});
