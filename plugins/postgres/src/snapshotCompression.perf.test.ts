import { Pool } from "pg";
import { afterAll, beforeAll, describe, it } from "vitest";
import { PostgresSnapshotStore } from "./PostgresSnapshotStore";
import { migrate } from "./schema";

// ADR 0136 evidence (issue #707). NOT part of `pnpm test` (see vitest.shared.ts): run with
// `LOOM_TEST_PERF=1 LOOM_TEST_POSTGRES_URL=... pnpm --filter @loom/plugin-postgres test`.
// It PRINTS the numbers the ADR quotes (bytes on disk by pg_column_size, resume-path loadLatest,
// save, and the events payload column). It asserts nothing about time: wall clock is noise.
const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;
const suite = PG_URL ? describe : describe.skip;

/** Deterministic PRNG so every run measures the same bytes. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const WORDS = (
  "the customer ticket refund order invoice payment failed retry approval pending escalate tool call " +
  "result status error timeout database replica lag primary index vacuum migration schema rollback " +
  "agent model response token budget summary context window policy decision evidence runbook incident"
).split(" ");

/** An agent-like state: many steps with prose-ish results, ids, numbers and nested structure. */
function agentState(targetBytes: number, seed: number): unknown {
  const r = rng(seed);
  const sentence = (n: number): string =>
    Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]).join(" ");
  const steps: Record<string, unknown> = {};
  let size = 0;
  for (let i = 0; size < targetBytes; i++) {
    const step = {
      stepId: `step-${i}`,
      status: r() < 0.9 ? "COMPLETED" : "FAILED",
      startedAt: 1_700_000_000_000 + i * 1000 + Math.floor(r() * 900),
      toolCall: {
        name: `tool_${Math.floor(r() * 12)}`,
        args: { q: sentence(8), limit: Math.floor(r() * 100) },
      },
      result: {
        text: sentence(60 + Math.floor(r() * 120)),
        score: r(),
        ids: [i, i + 1, Math.floor(r() * 1e6)],
      },
    };
    steps[`step-${i}`] = step;
    size += JSON.stringify(step).length;
  }
  return { status: "RUNNING", steps };
}

const median = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const ms = (f: () => Promise<unknown>) => async (): Promise<number> => {
  const t = performance.now();
  await f();
  return performance.now() - t;
};

suite("snapshots.state: pglz vs lz4 (ADR 0136 evidence)", () => {
  const schema = `loom_lz4_perf_${process.pid}`;
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG_URL });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: PG_URL, options: `-c search_path=${schema}`, max: 4 });
    await migrate(pool, { snapshotCompression: "default" });
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it("measures bytes and resume-path reads", { timeout: 600_000 }, async () => {
    const sizes = [100_000, 1_000_000, 5_000_000];
    const out: string[] = [];
    // One table per method, same column shape, so the same bytes are stored both ways.
    for (const method of ["pglz", "lz4"]) {
      await pool.query(
        `CREATE TABLE snap_${method} (id TEXT PRIMARY KEY, state JSONB COMPRESSION ${method} NOT NULL)`
      );
    }
    for (const target of sizes) {
      const text = JSON.stringify(agentState(target, target));
      const raw = Buffer.byteLength(text);
      const row: Record<string, number> = { rawJsonBytes: raw };
      for (const method of ["pglz", "lz4"]) {
        const table = `snap_${method}`;
        const saveTimes: number[] = [];
        for (let i = 0; i < 7; i++) {
          saveTimes.push(
            await ms(() =>
              pool.query(
                `INSERT INTO ${table} (id, state) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state`,
                [`s${target}`, text]
              )
            )()
          );
        }
        const { rows } = await pool.query<{ b: string }>(
          `SELECT pg_column_size(state)::text AS b FROM ${table} WHERE id = $1`,
          [`s${target}`]
        );
        row[`${method}Bytes`] = Number(rows[0]?.b);
        const readTimes: number[] = [];
        for (let i = 0; i < 15; i++) {
          readTimes.push(
            await ms(() =>
              pool.query(`SELECT state FROM ${table} WHERE id = $1 ORDER BY id LIMIT 1`, [
                `s${target}`,
              ])
            )()
          );
        }
        row[`${method}SaveMedianMs`] = Math.round(median(saveTimes) * 10) / 10;
        row[`${method}ReadMedianMs`] = Math.round(median(readTimes) * 10) / 10;
      }
      out.push(JSON.stringify(row));
    }
    // The real resume read: PostgresSnapshotStore.loadLatest on the production table (lz4 via migrate).
    for (const method of ["pglz", "lz4"]) {
      await pool.query("DROP TABLE IF EXISTS snapshots CASCADE");
      // migrate() is memoized per pool; use a fresh pool per method.
      const p = new Pool({ connectionString: PG_URL, options: `-c search_path=${schema}`, max: 2 });
      try {
        await migrate(p, { snapshotCompression: method === "lz4" ? "lz4" : "default" });
        const store = new PostgresSnapshotStore(p);
        const state = agentState(1_000_000, 42) as never;
        await store.save({
          id: "x",
          executionId: "e",
          workflowId: "w",
          sequence: 9,
          state,
          createdAt: 1,
        });
        const times: number[] = [];
        for (let i = 0; i < 25; i++) times.push(await ms(() => store.loadLatest("e"))());
        out.push(
          JSON.stringify({ loadLatest1MB: method, medianMs: Math.round(median(times) * 10) / 10 })
        );
      } finally {
        await p.end();
      }
    }
    console.log(`SNAPSHOT_COMPRESSION_RESULTS\n${out.join("\n")}`);
  });

  it(
    "measures the events payload column (measure only, not changed)",
    { timeout: 600_000 },
    async () => {
      const out: string[] = [];
      for (const method of ["pglz", "lz4"]) {
        await pool.query(
          `CREATE TABLE ev_${method} (id BIGSERIAL PRIMARY KEY, payload JSONB COMPRESSION ${method} NOT NULL)`
        );
        const r = rng(7);
        const payloads: string[] = [];
        for (let i = 0; i < 2000; i++) {
          // typical event payloads: a few hundred bytes to a few kB of structured JSON
          payloads.push(JSON.stringify(agentState(300 + Math.floor(r() * 4000), i)));
        }
        const t = performance.now();
        for (let off = 0; off < payloads.length; off += 50) {
          const batch = payloads.slice(off, off + 50);
          await pool.query(
            `INSERT INTO ev_${method} (payload) SELECT x::jsonb FROM unnest($1::text[]) AS x`,
            [batch]
          );
        }
        const elapsed = performance.now() - t;
        const { rows } = await pool.query<{ raw: string; stored: string; toasted: string }>(
          `SELECT sum(octet_length(payload::text))::text AS raw, sum(pg_column_size(payload))::text AS stored,
                count(*) FILTER (WHERE pg_column_size(payload) <> octet_length(payload::text))::text AS toasted
         FROM ev_${method}`
        );
        out.push(
          JSON.stringify({
            method,
            rows: 2000,
            ...rows[0],
            appendsPerSec: Math.round((2000 / elapsed) * 1000),
          })
        );
      }
      console.log(`EVENTS_PAYLOAD_RESULTS\n${out.join("\n")}`);
    }
  );
});
