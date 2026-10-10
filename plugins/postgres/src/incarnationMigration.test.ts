import type { EventEnvelope } from "@loom/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresEventStore } from "./PostgresEventStore";
import { migrate } from "./schema";

// ADR 0129 — the store-assigned incarnation is a NEW nullable column + sequence + trigger on a
// table older versions created. Prove the upgrade on an OLD-shape `events` table (no
// `incarnation`), in a schema of its own: old executions keep the legacy `timestamp:id` anchor
// (no backfill, an observation taken before the upgrade stays valid), new ones get incarnations,
// and concurrent migrations are safe. Gated on LOOM_TEST_POSTGRES_URL like the rest.
const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;
const SCHEMA = `loom_incarnation_mig_${process.pid}`;

const evt = (executionId: string, sequence: number, timestamp = 1_000): EventEnvelope => ({
  id: `${executionId}-${sequence}`,
  workflowId: "wf",
  executionId,
  eventType: "EXECUTION_STARTED",
  sequence,
  timestamp,
  payload: {},
});

if (PG_URL === undefined) {
  describe.skip("incarnation migration (needs LOOM_TEST_POSTGRES_URL)", () => {});
} else {
  let pool: Pool;
  const admin = async (sql: string): Promise<void> => {
    const a = new Pool({ connectionString: PG_URL });
    try {
      await a.query(sql);
    } finally {
      await a.end();
    }
  };
  beforeAll(async () => {
    await admin(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG_URL, options: `-c search_path=${SCHEMA}`, max: 8 });
  });
  afterAll(async () => {
    await pool.end();
    await admin(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  });

  describe("PostgresEventStore incarnation migration (ADR 0129)", () => {
    it("an OLD-shape events table gains the column; old logs keep the legacy anchor, new ones get incarnations; concurrent migration is safe", async () => {
      // The shape every pre-0129 version created: no `incarnation`.
      await pool.query(`CREATE TABLE events (
        id TEXT NOT NULL PRIMARY KEY, workflow_id TEXT NOT NULL,
        execution_id TEXT COLLATE "C" NOT NULL, event_type TEXT NOT NULL,
        sequence BIGINT NOT NULL, timestamp BIGINT NOT NULL, payload JSONB NOT NULL,
        metadata JSONB, UNIQUE (execution_id, sequence))`);
      for (const e of [evt("old", 0, 7), evt("old", 1, 8)]) {
        await pool.query(
          `INSERT INTO events (id, workflow_id, execution_id, event_type, sequence, timestamp, payload)
           VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb)`,
          [e.id, e.workflowId, e.executionId, e.eventType, e.sequence, e.timestamp]
        );
      }

      // Several nodes booting at once against the old table.
      await Promise.all([migrate(pool), migrate(pool), migrate(pool)]);
      await migrate(pool); // and idempotent afterwards

      const store = new PostgresEventStore(pool);
      try {
        // No backfill: the pre-migration log keeps NULL and so the legacy anchor.
        const nulls = await pool.query(
          "SELECT incarnation FROM events WHERE execution_id = 'old' AND sequence = 0"
        );
        expect(nulls.rows[0].incarnation).toBeNull();
        const before = await store.appendIfUnchanged!("old", null);
        expect(before).toMatchObject({ appended: false, reason: "observed", head: 1 });
        const legacy = (before as { anchor: string }).anchor;
        expect(legacy).toBe("7:old-0");

        // An observation taken before the upgrade is still honoured after it.
        expect(
          await store.appendIfUnchanged!("old", evt("old", 2), {
            head: 1,
            fence: 0,
            anchor: legacy,
          })
        ).toEqual({ appended: true });

        // New executions get a store-assigned incarnation, on sequence 0 only.
        await store.append(evt("fresh", 0));
        await store.append(evt("fresh", 1));
        const rows = await pool.query(
          "SELECT sequence, incarnation FROM events WHERE execution_id = 'fresh' ORDER BY sequence"
        );
        expect(rows.rows[0].incarnation).not.toBeNull();
        expect(rows.rows[1].incarnation).toBeNull();
        const fresh = (await store.appendIfUnchanged!("fresh", null)) as { anchor: string };
        expect(fresh.anchor).toBe(String(rows.rows[0].incarnation));
        expect(fresh.anchor).not.toContain(":"); // can never equal a legacy anchor

        // Delete + byte-identical re-creation: a larger incarnation, the stale observation moves.
        await store.deleteExecution!("fresh");
        await store.append(evt("fresh", 0));
        await store.append(evt("fresh", 1));
        const again = (await store.appendIfUnchanged!("fresh", null)) as { anchor: string };
        expect(Number(again.anchor)).toBeGreaterThan(Number(fresh.anchor));
        expect(
          await store.appendIfUnchanged!("fresh", evt("fresh", 2), {
            head: 1,
            fence: 0,
            anchor: fresh.anchor,
          })
        ).toMatchObject({ appended: false, reason: "moved" });

        // The old log, deleted and re-created after the upgrade, gets an incarnation too.
        await store.deleteExecution!("old");
        await store.append(evt("old", 0, 7));
        const reborn = (await store.appendIfUnchanged!("old", null)) as { anchor: string };
        expect(reborn.anchor).not.toBe(legacy);
        expect(reborn.anchor).not.toContain(":");
      } finally {
        await store.close();
      }
    });
  });
}
