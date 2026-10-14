import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresLeaseStore } from "./PostgresLeaseStore";

// S7a review P3-8: the lock-ordering claim ("two concurrent batches take their row locks in the
// same order and cannot deadlock") needs a probe, not a comment. Several pools (= several nodes)
// hammer ONE small id space with OVERLAPPING, SHUFFLED id subsets through acquireMany / renewMany /
// releaseMany plus single-id steals; any deadlock_detected (40P01) or other error fails it. Gated
// on LOOM_TEST_POSTGRES_URL like the rest.
const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;
const SCHEMA = `loom_lease_conc_${process.pid}`;

if (PG_URL === undefined) {
  describe.skip("PostgresLeaseStore overlapping batches (needs LOOM_TEST_POSTGRES_URL)", () => {});
} else {
  const NODES = 4;
  const IDS = 40;
  const OPS_PER_NODE = 800;
  const all = Array.from({ length: IDS }, (_, i) => `e${String(i).padStart(3, "0")}`);
  const pools: Pool[] = [];
  const stores: PostgresLeaseStore[] = [];

  beforeAll(async () => {
    const admin = new Pool({ connectionString: PG_URL });
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    } finally {
      await admin.end();
    }
    for (let i = 0; i < NODES; i++) {
      const pool = new Pool({
        connectionString: PG_URL,
        options: `-c search_path=${SCHEMA}`,
        max: 4,
      });
      pools.push(pool);
      stores.push(new PostgresLeaseStore(pool));
    }
  });
  afterAll(async () => {
    for (const p of pools) await p.end();
    const admin = new Pool({ connectionString: PG_URL });
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    } finally {
      await admin.end();
    }
  });

  // Deterministic PRNG so a failure reproduces.
  const rng = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const subset = (rand: () => number): string[] => {
    const shuffled = [...all].sort(() => rand() - 0.5); // SHUFFLED: callers do not sort
    return shuffled.slice(0, 5 + Math.floor(rand() * 20));
  };

  describe("PostgresLeaseStore overlapping batches (ADR 0130 D11 lock ordering)", () => {
    it("mixed acquireMany/renewMany/releaseMany/steal from several nodes: zero errors, no deadlock", async () => {
      const errors: unknown[] = [];
      let ops = 0;
      const node = async (n: number): Promise<void> => {
        const store = stores[n] as PostgresLeaseStore;
        const owner = `node-${n}`;
        const rand = rng(1000 + n);
        for (let i = 0; i < OPS_PER_NODE; i += 4) {
          // Four overlapping statements in flight at once from this node, to fill its pool.
          await Promise.all(
            [0, 1, 2, 3].map(async () => {
              try {
                const r = rand();
                if (r < 0.35) await store.acquireMany(subset(rand), owner, 60_000);
                else if (r < 0.6) await store.renewMany(subset(rand), owner, 60_000);
                else if (r < 0.8) await store.releaseMany(subset(rand), owner);
                else {
                  const id = all[Math.floor(rand() * IDS)] as string;
                  await store.acquire(id, owner, 60_000, undefined, { steal: { fence: 1 } });
                }
                ops++;
              } catch (e) {
                errors.push(e);
              }
            })
          );
        }
      };
      await Promise.all(Array.from({ length: NODES }, (_, n) => node(n)));
      expect(errors).toEqual([]);
      expect(ops).toBe(NODES * OPS_PER_NODE);
      // Single-owner invariant still holds after the storm: every row has exactly one owner.
      const { rows } = await (pools[0] as Pool).query(
        "SELECT execution_id, count(*) FROM leases GROUP BY execution_id HAVING count(*) > 1"
      );
      expect(rows).toEqual([]);
    }, 60_000);
  });
}
