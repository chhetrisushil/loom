import type { EventEnvelope } from "@loom/core";
import type { AppendIfUnchangedResult, EventStore, TipObservation } from "@loom/event-runtime";
import {
  DuplicateEnvelopeIdError,
  DuplicateSequenceError,
  SubscriberRegistry,
  creationMarker,
} from "@loom/event-runtime";
import Database from "better-sqlite3";
import { migrate } from "./schema";

/**
 * #306 — normalize the `UNIQUE (execution_id, sequence)` violation to the portable
 * {@link DuplicateSequenceError} every backend raises, so a caller need not know which
 * store it is talking to (or match on driver text) to recognise a lost sequence race.
 *
 * Narrowed to THAT constraint by name: the table also has a PRIMARY KEY on `id`, and a
 * duplicate id is a different bug (a re-used envelope id) that must not be reported as a
 * sequence conflict. Anything else propagates untouched.
 */
function isDuplicateSequenceViolation(err: unknown): boolean {
  if (!isConstraintViolation(err)) return false;
  return err.message.includes("execution_id") && err.message.includes("sequence");
}

/**
 * #309 — the table's OTHER key: `PRIMARY KEY (id)`. Distinguished from the sequence
 * constraint by the column named in the violation, so each maps to its own error and
 * neither is reported as the other.
 */
function isDuplicateIdViolation(err: unknown): boolean {
  if (!isConstraintViolation(err)) return false;
  return err.message.includes("events.id") && !err.message.includes("execution_id");
}

function isConstraintViolation(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
}

interface EventRow {
  id: string;
  workflow_id: string;
  execution_id: string;
  event_type: string;
  sequence: number;
  timestamp: number;
  payload: string;
  metadata: string | null;
}

function rowToEnvelope(row: EventRow): EventEnvelope {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    executionId: row.execution_id,
    eventType: row.event_type,
    sequence: row.sequence,
    timestamp: row.timestamp,
    payload: JSON.parse(row.payload) as unknown,
    ...(row.metadata !== null && { metadata: JSON.parse(row.metadata) as Record<string, unknown> }),
  };
}

export class SqliteEventStore implements EventStore {
  private readonly db: Database.Database;
  private pageFirstStmt: Database.Statement | undefined;
  private pageAfterStmt: Database.Statement | undefined;
  private readonly subscribers = new SubscriberRegistry();

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      migrate(this.db);
    } catch (err) {
      this.db.close(); // don't leak the file handle if setup fails on a bad/locked file
      throw err;
    }
  }

  async append(envelope: EventEnvelope): Promise<void> {
    const stmt = this.db.prepare<
      [string, string, string, string, number, number, string, string | null]
    >(`
      INSERT INTO events (id, workflow_id, execution_id, event_type, sequence, timestamp, payload, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      stmt.run(
        envelope.id,
        envelope.workflowId,
        envelope.executionId,
        envelope.eventType,
        envelope.sequence,
        envelope.timestamp,
        JSON.stringify(envelope.payload),
        envelope.metadata !== undefined ? JSON.stringify(envelope.metadata) : null
      );
    } catch (err) {
      if (isDuplicateSequenceViolation(err)) {
        throw new DuplicateSequenceError(envelope.executionId, envelope.sequence, err);
      }
      if (isDuplicateIdViolation(err)) {
        throw new DuplicateEnvelopeIdError(envelope.id, envelope.executionId, err);
      }
      throw err;
    }

    this.notify(envelope.executionId, envelope);
  }

  /**
   * ADR 0074 D1 — bulk append in ONE transaction. better-sqlite3's `transaction()` wrapper
   * is synchronous and rolls back on throw, which gives the required atomicity directly:
   * a UNIQUE(execution_id, sequence) violation part-way aborts the whole statement group,
   * so no execution is left with a hole.
   *
   * Subscribers fire only after the transaction commits — a subscriber must never observe
   * a batch that could still roll back.
   */
  async appendBatch(envelopes: readonly EventEnvelope[]): Promise<void> {
    if (envelopes.length === 0) return;
    const stmt = this.db.prepare<
      [string, string, string, string, number, number, string, string | null]
    >(`
      INSERT INTO events (id, workflow_id, execution_id, event_type, sequence, timestamp, payload, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAll = this.db.transaction((batch: readonly EventEnvelope[]) => {
      for (const envelope of batch) {
        stmt.run(
          envelope.id,
          envelope.workflowId,
          envelope.executionId,
          envelope.eventType,
          envelope.sequence,
          envelope.timestamp,
          JSON.stringify(envelope.payload),
          envelope.metadata !== undefined ? JSON.stringify(envelope.metadata) : null
        );
      }
    });
    try {
      insertAll(envelopes);
    } catch (err) {
      if (isDuplicateSequenceViolation(err) || isDuplicateIdViolation(err)) {
        // SQLite names the constraint, not the row, so locate the offender ourselves —
        // an error that cannot say WHICH slot was taken sends the reader back to the log.
        // Error path only, so the extra query costs nothing on the hot path. The
        // transaction has rolled back, so a slot found occupied now was occupied before.
        throw this.duplicateIn(envelopes, err);
      }
      throw err;
    }
    for (const envelope of envelopes) this.notify(envelope.executionId, envelope);
  }

  /**
   * Which envelope in a rejected batch claimed something already taken — a
   * `(executionId, sequence)` slot or an envelope `id`, either because the log already held
   * it or because another envelope in the SAME batch did. Slot first, so a writer that lost
   * a sequence race is told THAT rather than told about the id its own naming convention
   * derived from the sequence it lost.
   */
  private duplicateIn(envelopes: readonly EventEnvelope[], cause: unknown): Error {
    const taken = this.db.prepare<[string, number], { one: number }>(
      "SELECT 1 AS one FROM events WHERE execution_id = ? AND sequence = ?"
    );
    const idTaken = this.db.prepare<[string], { one: number }>(
      "SELECT 1 AS one FROM events WHERE id = ?"
    );
    const claimedIds = new Set<string>();
    const claimed = new Set<string>();
    for (const e of envelopes) {
      const key = `${e.executionId}\u0000${e.sequence}`;
      if (claimed.has(key) || taken.get(e.executionId, e.sequence) !== undefined) {
        return new DuplicateSequenceError(e.executionId, e.sequence, cause);
      }
      if (claimedIds.has(e.id) || idTaken.get(e.id) !== undefined) {
        return new DuplicateEnvelopeIdError(e.id, e.executionId, cause);
      }
      claimed.add(key);
      claimedIds.add(e.id);
    }
    return cause instanceof Error ? cause : new Error(String(cause));
  }

  /**
   * SPI 2.2.0 (ADR 0116 amendment) — existence, head and the (always 0: SQLite does not fence)
   * token are checked and the row inserted inside ONE `BEGIN IMMEDIATE` transaction, so a
   * retention delete or another process's append cannot slip between the check and the write.
   */
  async appendIfUnchanged(
    executionId: string,
    event: EventEnvelope | null,
    expect?: TipObservation
  ): Promise<AppendIfUnchangedResult> {
    if (event !== null && (expect === undefined || event.executionId !== executionId)) {
      throw new TypeError(
        "appendIfUnchanged: an event needs `expect` and the matching executionId"
      );
    }
    const run = this.db.transaction((): AppendIfUnchangedResult => {
      const first = this.db
        .prepare<[string], { id: string; timestamp: number }>(
          "SELECT id, timestamp FROM events WHERE execution_id = ? AND sequence = 0"
        )
        .get(executionId);
      if (first === undefined) {
        return { appended: false, reason: "gone", head: null, fence: 0, anchor: null };
      }
      const anchor = creationMarker(first);
      const tip = this.db
        .prepare<[string], { tip: number }>(
          "SELECT MAX(sequence) AS tip FROM events WHERE execution_id = ?"
        )
        .get(executionId);
      const head = tip?.tip ?? 0;
      if (event === null) return { appended: false, reason: "observed", head, fence: 0, anchor };
      const want = expect as TipObservation;
      if (
        head !== want.head ||
        want.fence !== 0 ||
        anchor !== want.anchor ||
        event.sequence !== head + 1
      ) {
        return { appended: false, reason: "moved", head, fence: 0, anchor };
      }
      this.db
        .prepare(
          `INSERT INTO events (id, workflow_id, execution_id, event_type, sequence, timestamp, payload, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          event.id,
          event.workflowId,
          event.executionId,
          event.eventType,
          event.sequence,
          event.timestamp,
          JSON.stringify(event.payload),
          event.metadata !== undefined ? JSON.stringify(event.metadata) : null
        );
      return { appended: true };
    });
    let result: AppendIfUnchangedResult;
    try {
      result = run.immediate();
    } catch (err) {
      if (isDuplicateSequenceViolation(err)) {
        throw new DuplicateSequenceError(executionId, event?.sequence ?? -1, err);
      }
      if (isDuplicateIdViolation(err)) {
        throw new DuplicateEnvelopeIdError(event?.id ?? "", executionId, err);
      }
      throw err;
    }
    if (result.appended && event !== null) this.notify(executionId, event);
    return result;
  }

  async read(executionId: string): Promise<EventEnvelope[]> {
    const rows = this.db
      .prepare<[string], EventRow>(
        "SELECT * FROM events WHERE execution_id = ? ORDER BY sequence ASC"
      )
      .all(executionId);
    return rows.map(rowToEnvelope);
  }

  async readFrom(executionId: string, fromSequence: number): Promise<EventEnvelope[]> {
    const rows = this.db
      .prepare<[string, number], EventRow>(
        "SELECT * FROM events WHERE execution_id = ? AND sequence >= ? ORDER BY sequence ASC"
      )
      .all(executionId, fromSequence);
    return rows.map(rowToEnvelope);
  }

  async head(executionId: string): Promise<number | null> {
    const row = this.db
      .prepare<[string], { tip: number | null }>(
        "SELECT MAX(sequence) AS tip FROM events WHERE execution_id = ?"
      )
      .get(executionId);
    return row?.tip ?? null;
  }

  async readRange(
    executionId: string,
    fromSequence: number,
    toSequence: number
  ): Promise<EventEnvelope[]> {
    if (toSequence < fromSequence) return [];
    const rows = this.db
      .prepare<[string, number, number], EventRow>(
        "SELECT * FROM events WHERE execution_id = ? AND sequence >= ? AND sequence <= ? ORDER BY sequence ASC"
      )
      .all(executionId, fromSequence, toSequence);
    return rows.map(rowToEnvelope);
  }

  async copyPrefix(
    fromExecutionId: string,
    toExecutionId: string,
    throughSequence: number,
    metadata: Record<string, unknown>
  ): Promise<void> {
    // Copy the prefix entirely inside SQLite — payload stays as stored TEXT (no
    // JS parse/stringify), id/execution_id are re-stamped, and provenance metadata
    // is merged via json_patch (JSON1). O(P) rows, zero JS serialization.
    this.db
      .prepare<[string, string, string, string, number]>(
        `INSERT INTO events (id, workflow_id, execution_id, event_type, sequence, timestamp, payload, metadata)
         SELECT ? || '-' || sequence, workflow_id, ?, event_type, sequence, timestamp, payload,
                json_patch(COALESCE(metadata, '{}'), json(?))
         FROM events WHERE execution_id = ? AND sequence <= ?`
      )
      .run(
        toExecutionId,
        toExecutionId,
        JSON.stringify(metadata),
        fromExecutionId,
        throughSequence
      );
  }

  async subscribe(
    executionId: string,
    handler: (event: EventEnvelope) => void
  ): Promise<() => void> {
    return this.subscribers.add(executionId, handler);
  }

  async deleteExecution(executionId: string): Promise<void> {
    this.db.prepare<[string]>("DELETE FROM events WHERE execution_id = ?").run(executionId);
  }

  async truncatePrefix(executionId: string, throughSequence: number): Promise<void> {
    // Preserve sequence 0 (bootstrap anchor); drop (0..throughSequence].
    this.db
      .prepare<[string, number]>(
        "DELETE FROM events WHERE execution_id = ? AND sequence > 0 AND sequence <= ?"
      )
      .run(executionId, throughSequence);
  }

  async truncatePrefixKeeping(
    executionId: string,
    throughSequence: number,
    keepEventTypes: readonly string[]
  ): Promise<void> {
    // ADR 0106 — one statement: sequence 0 and every kept-type event survive in place. The
    // kept types ride as one JSON array parameter, so the statement text never varies.
    this.db
      .prepare<[string, number, string]>(
        "DELETE FROM events WHERE execution_id = ? AND sequence > 0 AND sequence <= ? AND event_type NOT IN (SELECT value FROM json_each(?))"
      )
      .run(executionId, throughSequence, JSON.stringify(keepEventTypes));
  }

  async listExecutions(): Promise<string[]> {
    // The (execution_id, sequence) index makes DISTINCT a cheap index-only scan.
    const rows = this.db
      .prepare<[], { execution_id: string }>("SELECT DISTINCT execution_id FROM events")
      .all();
    return rows.map((r) => r.execution_id);
  }

  async listExecutionsPage(opts?: {
    cursor?: string;
    limit?: number;
  }): Promise<{ executionIds: string[]; nextCursor?: string }> {
    // SP-1 (SPI 1.2.0) — keyset over the same index: lexicographic, bounded memory.
    // Statements prepared lazily once (audit: no per-page re-parse on big scans).
    const limit = opts?.limit ?? 1000;
    this.pageFirstStmt ??= this.db.prepare(
      "SELECT DISTINCT execution_id FROM events ORDER BY execution_id LIMIT ?"
    );
    this.pageAfterStmt ??= this.db.prepare(
      "SELECT DISTINCT execution_id FROM events WHERE execution_id > ? ORDER BY execution_id LIMIT ?"
    );
    const rows =
      opts?.cursor === undefined
        ? (this.pageFirstStmt.all(limit + 1) as { execution_id: string }[])
        : (this.pageAfterStmt.all(opts.cursor, limit + 1) as { execution_id: string }[]);
    const executionIds = rows.slice(0, limit).map((r) => r.execution_id);
    const last = executionIds[executionIds.length - 1];
    return {
      executionIds,
      ...(rows.length > limit && last !== undefined && { nextCursor: last }),
    };
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private notify(_executionId: string, event: EventEnvelope): void {
    this.subscribers.emit(event);
  }
}
