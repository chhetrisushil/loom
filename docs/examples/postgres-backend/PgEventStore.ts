// Reference: a Postgres-backed EventStore for Loom. Copy into your app, add
// `pg` (`pnpm add pg @types/pg`), run schema.sql once, and inject it into
// WorkflowRuntime exactly like SqliteEventStore. Not compiled in this repo — it
// exists to show the async EventStore contract against a real network backend.
//
// The whole point of Loom's async-first storage layer: because `append`/`read`
// return Promises and the runtime awaits them, a network store like this is a
// first-class backend — no in-memory shim, no write-behind hacks.

import type { EventEnvelope } from "@loom/core";
import type { EventStore } from "@loom/event-runtime";
import { Pool, type PoolClient } from "pg";

interface EventRow {
  id: string;
  workflow_id: string;
  execution_id: string;
  event_type: string;
  sequence: string; // BIGINT comes back as a string from node-postgres
  timestamp: string;
  payload: unknown;
  metadata: Record<string, unknown> | null;
}

function rowToEnvelope(r: EventRow): EventEnvelope {
  return {
    id: r.id,
    workflowId: r.workflow_id,
    executionId: r.execution_id,
    eventType: r.event_type,
    sequence: Number(r.sequence),
    timestamp: Number(r.timestamp),
    payload: r.payload,
    ...(r.metadata !== null && { metadata: r.metadata }),
  };
}

export class PgEventStore implements EventStore {
  constructor(private readonly pool: Pool) {}

  async append(e: EventEnvelope): Promise<void> {
    // The UNIQUE(execution_id, sequence) constraint is the durable safety net —
    // sequence itself is allocated by the runtime's in-memory ExecutionJournal,
    // so there is no read-then-write round-trip here.
    await this.pool.query(
      `INSERT INTO events (id, workflow_id, execution_id, event_type, sequence, timestamp, payload, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        e.id,
        e.workflowId,
        e.executionId,
        e.eventType,
        e.sequence,
        e.timestamp,
        JSON.stringify(e.payload),
        e.metadata !== undefined ? JSON.stringify(e.metadata) : null,
      ]
    );
    // Fan out to LISTEN/NOTIFY subscribers on the same channel (see subscribe()).
    await this.pool.query("SELECT pg_notify($1, $2)", [
      `loom_events_${e.executionId}`,
      JSON.stringify(e),
    ]);
  }

  async read(executionId: string): Promise<EventEnvelope[]> {
    const { rows } = await this.pool.query<EventRow>(
      "SELECT * FROM events WHERE execution_id = $1 ORDER BY sequence ASC",
      [executionId]
    );
    return rows.map(rowToEnvelope);
  }

  async readFrom(executionId: string, fromSequence: number): Promise<EventEnvelope[]> {
    const { rows } = await this.pool.query<EventRow>(
      "SELECT * FROM events WHERE execution_id = $1 AND sequence >= $2 ORDER BY sequence ASC",
      [executionId, fromSequence]
    );
    return rows.map(rowToEnvelope);
  }

  // This is WHY subscribe is async: a network store needs a round-trip to open a
  // dedicated LISTEN connection before it can deliver notifications.
  async subscribe(
    executionId: string,
    handler: (event: EventEnvelope) => void
  ): Promise<() => void> {
    const client: PoolClient = await this.pool.connect();
    const channel = `loom_events_${executionId}`;
    const onNotification = (msg: { channel: string; payload?: string }) => {
      if (msg.channel === channel && msg.payload) handler(JSON.parse(msg.payload) as EventEnvelope);
    };
    client.on("notification", onNotification);
    await client.query(`LISTEN ${channel}`);
    return () => {
      client.removeListener("notification", onNotification);
      void client.query(`UNLISTEN ${channel}`).finally(() => client.release());
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
