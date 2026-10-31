import type { ExecutionState } from "@loom/core";
import { zstdAvailable } from "@loom/snapshot-runtime";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSnapshotStore } from "./PostgresSnapshotStore";

// ADR 0140 evidence (issues #730 / #733). NOT part of `pnpm test` (see vitest.shared.ts): run with
// `LOOM_TEST_PERF=1 LOOM_TEST_POSTGRES_URL=... pnpm --filter @loom/plugin-postgres test:perf`.
// It PRINTS the numbers the ADR quotes: stored bytes of an agent run's folded state at 50 and 200 turns
// (plain and claim-checked) as JSONB pglz (`pg_column_size(state)`) vs the zstd-3 BYTEA frame
// (`length(state_z)`), and the resume read (`loadLatest`, query + decode) for both. The ONLY assertions
// are deterministic ones (bytes); wall clock is printed, never gated.
//
// The state is synthetic (a ~20-word vocabulary, as in the #730 harness), so absolute ratios are
// optimistic; the ranking is what carries over.
const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;
const suite = PG_URL && zstdAvailable() ? describe : describe.skip;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The #730 harness's tool output: 1-4 kB of prose over a 20-word vocabulary, ~20% of words followed by a number.
const WORDS =
  "order customer shipped carrier scan delivered damaged refund budget ticket status warehouse region invoice pallet courier label address window note".split(
    " "
  );
function toolOutput(n: number): { n: number; text: string } {
  const r = rng(n + 1);
  const size = 1000 + Math.floor(r() * 3000);
  let s = "";
  while (s.length < size) {
    s += `${WORDS[Math.floor(r() * WORDS.length)]}${r() < 0.2 ? Math.floor(r() * 1e6) : ""} `;
  }
  return { n, text: s.slice(0, size) };
}

/**
 * A RUNNING agent execution's folded state after `turns` turns (the shape `agentLoop$` leaves: per-turn
 * model + tool frames carrying the tool output, turn outputs and `_decisions`). With `claimChecked`,
 * each tool output above the 1 kB inline cap is replaced by a content reference, as the claim-check
 * middleware does. It is a stand-in for the real `agentLoop$` run of the #730 harness, so read the
 * ratios as the ranking, not the absolute figures.
 */
function agentState(turns: number, claimChecked: boolean): ExecutionState {
  const r = rng(turns * 7 + (claimChecked ? 1 : 0));
  const frames: Record<string, unknown> = {};
  const decisions: unknown[] = [];
  const outputs: unknown[] = [];
  const hex = (): string =>
    Array.from({ length: 8 }, () =>
      Math.floor(r() * 2 ** 32)
        .toString(16)
        .padStart(8, "0")
    ).join("");
  for (let i = 0; i < turns; i++) {
    const out = toolOutput(i);
    const big = JSON.stringify(out).length > 1024;
    frames[`a#turn:${i}.lookup`] = {
      stepId: `a#turn:${i}.lookup`,
      status: "COMPLETED",
      attempt: 1,
      startedAt: 1_700_000_000_000 + i * 1000,
      completedAt: 1_700_000_000_000 + i * 1000 + Math.floor(r() * 900),
      toolId: "lookup",
      input: { n: i },
      output: claimChecked && big ? { __loomContent: `sha256:${hex()}` } : out,
    };
    frames[`a#turn:${i}.model`] = {
      stepId: `a#turn:${i}.model`,
      status: "COMPLETED",
      attempt: 1,
      startedAt: 1_700_000_000_000 + i * 1000,
      toolId: "model",
      output: {
        content: `step ${i}: need more evidence`,
        toolCalls: [{ id: `t${i}`, name: "lookup", input: { n: i } }],
      },
    };
    outputs.push({ turn: i, content: `step ${i}: need more evidence` });
    decisions.push({ key: `a#turn:${i}`, value: "tool_use", at: 1_700_000_000_000 + i });
  }
  return {
    executionId: "e",
    workflowId: "agent",
    workflowVersion: "1",
    status: "running",
    frames,
    variables: { _turns: outputs, _decisions: decisions },
    sequence: turns * 6,
    startedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000 + turns * 1000,
  } as unknown as ExecutionState;
}

const median = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

suite("snapshot bytes + resume read: JSONB pglz vs zstd BYTEA (ADR 0140 evidence)", () => {
  const schema = `loom_zstd_perf_${process.pid}`;
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG_URL });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: PG_URL, options: `-c search_path=${schema}`, max: 4 });
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it("prints bytes and loadLatest medians at 50 and 200 turns", { timeout: 600_000 }, async () => {
    const jsonb = new PostgresSnapshotStore(pool);
    const z = new PostgresSnapshotStore(pool, { codec: "zstd" });
    const rows: string[] = [];
    for (const turns of [50, 200]) {
      for (const claimChecked of [false, true]) {
        const state = agentState(turns, claimChecked);
        const rawJson = Buffer.byteLength(JSON.stringify(state));
        const id = `${turns}-${claimChecked}`;
        const snap = (suffix: string, sequence: number) => ({
          id: `${id}-${suffix}`,
          executionId: `${id}-${suffix}`,
          workflowId: "agent",
          sequence,
          state,
          createdAt: 1,
        });
        await jsonb.save(snap("jsonb", 1));
        await z.save(snap("zstd", 1));
        const size = async (sql: string, key: string): Promise<number> =>
          Number((await pool.query(sql, [key])).rows[0]?.b);
        const pglz = await size(
          "SELECT pg_column_size(state)::int AS b FROM snapshots WHERE id = $1",
          `${id}-jsonb`
        );
        const zstd = await size(
          "SELECT length(state_z)::int AS b FROM snapshots WHERE id = $1",
          `${id}-zstd`
        );
        const read = async (store: PostgresSnapshotStore, key: string): Promise<number> => {
          const times: number[] = [];
          for (let i = 0; i < 25; i++) {
            const t = performance.now();
            await store.loadLatest(key);
            times.push(performance.now() - t);
          }
          return Math.round(median(times) * 100) / 100;
        };
        const readJsonb = await read(jsonb, `${id}-jsonb`);
        const readZstd = await read(z, `${id}-zstd`);
        rows.push(
          JSON.stringify({
            turns,
            claimChecked,
            rawJson,
            pglzBytes: pglz,
            zstdBytes: zstd,
            zstdOverPglz: Math.round((zstd / pglz) * 100) / 100,
            loadLatestMs: { jsonbPglz: readJsonb, zstd: readZstd },
          })
        );
        // Deterministic: the codec stores fewer bytes than JSONB's pglz on this state.
        expect(zstd).toBeLessThan(pglz);
        // ...and a round trip is lossless.
        expect(JSON.stringify((await z.loadLatest(`${id}-zstd`))?.state)).toBe(
          JSON.stringify(state)
        );
      }
    }
    console.log(`SNAPSHOT_ZSTD_RESULTS\n${rows.join("\n")}`);
    await jsonb.close();
    await z.close();
  });
});
