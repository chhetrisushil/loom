import type { TimerRecord, TimerStore } from "@loom/event-runtime";
import { type PgConfig, type PoolLike, toPool } from "./pool";
import { migrate } from "./schema";

interface TimerRow {
  execution_id: string;
  wake_at: string; // BIGINT → string from node-postgres
  redrive: { attempt: number } | null; // JSONB → parsed by node-postgres
}

/**
 * Postgres-backed {@link TimerStore} (T1.3) — the multi-node backend. Timers
 * live in the same database as the event log (one backup = full kernel state),
 * and `INSERT … ON CONFLICT DO NOTHING` keeps scheduling idempotent per
 * (executionId, wakeAt) across nodes. Duplicate cross-node fires settle at the
 * shared log (idempotent-wake guard + UNIQUE sequence backstop + fencing when
 * the TimerService runs `fenced`).
 */
export class PostgresTimerStore implements TimerStore {
  private readonly pool: PoolLike;
  private readonly ownsPool: boolean;
  private readonly ready: Promise<void>;

  constructor(config: PgConfig) {
    const { pool, owned } = toPool(config);
    this.pool = pool;
    this.ownsPool = owned;
    this.ready = migrate(this.pool);
  }

  async schedule(timer: TimerRecord): Promise<void> {
    await this.ready;
    // Upsert (ADR 0118 D4): `DO NOTHING` would drop the re-drive flag when it lands on an existing
    // plain row; this never downgrades a flagged one and lets a flagged record flag a plain one.
    await this.pool.query(
      `INSERT INTO timers (execution_id, wake_at, redrive) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (execution_id, wake_at)
       DO UPDATE SET redrive = COALESCE(EXCLUDED.redrive, timers.redrive)`,
      [
        timer.executionId,
        timer.wakeAt,
        timer.redrive !== undefined ? JSON.stringify(timer.redrive) : null,
      ]
    );
  }

  async due(
    now: number,
    limit = 100,
    options?: { redrive?: boolean; inbox?: boolean }
  ): Promise<TimerRecord[]> {
    await this.ready;
    const { rows } = await this.pool.query<TimerRow>(
      `SELECT execution_id, wake_at, redrive FROM timers WHERE wake_at <= $1${
        options?.redrive === false ? " AND redrive IS NULL" : ""
      }${options?.inbox === false ? " AND (wake_at <> 0 OR redrive IS NOT NULL)" : ""} ORDER BY wake_at ASC LIMIT $2`,
      [now, limit]
    );
    return rows.map((r) => ({
      executionId: r.execution_id,
      wakeAt: Number(r.wake_at),
      ...(r.redrive !== null && { redrive: r.redrive }),
    }));
  }

  async complete(executionId: string, wakeAt: number): Promise<void> {
    await this.ready;
    await this.pool.query("DELETE FROM timers WHERE execution_id = $1 AND wake_at = $2", [
      executionId,
      wakeAt,
    ]);
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
