import type { EventEnvelope } from "@loom/core";

// ── RM (db-copilot infra, issue #183) — durable cross-execution read models ───
//
// A read model is a CACHE of the log with a watermark, never an authority
// (RM-2): drop it and rebuild by re-scanning. Ingestion converges from any mix
// of live `onEvent` tail, catch-up scans, and multiple nodes, because `apply`
// is idempotent per row id and watermarks are monotonic per execution. Queries
// are read-only and never recorded — replay never touches a read model.

/** Indexable scalar — the only value types `where` equality supports. */
export type ReadModelScalar = string | number | boolean | null;

/** One extracted row, as the app's extractor returns it. */
export interface ExtractedRow {
  /** Declared indexed fields (RM-3). Keys must be listed in the definition's `indexes`. */
  fields: Record<string, ReadModelScalar>;
  /** The value queries return; defaults to the source event's payload. */
  value?: unknown;
  /** Distinguishes multiple rows extracted from ONE event; suffixed onto the row id. */
  rowKey?: string;
}

export interface ReadModelDefinition {
  id: string;
  /** Event kinds this model indexes (non-empty). */
  kinds: readonly string[];
  /** The queryable field names every extracted row may set. */
  indexes: readonly string[];
  /** Pure. Called once per matching event; return [] to skip. */
  extract(event: EventEnvelope): readonly ExtractedRow[];
}

/** A stored row. `rowId` is the idempotency key: `${event.id}` or `${event.id}#${rowKey}`. */
export interface ReadModelRow {
  rowId: string;
  executionId: string;
  sequence: number;
  timestamp: number;
  kind: string;
  fields: Record<string, ReadModelScalar>;
  value: unknown;
}

export interface ReadModelQuery {
  /** Filter to one event kind. */
  kind?: string;
  /** Equality over declared indexed fields (ANDed). */
  where?: Record<string, ReadModelScalar>;
  /** Order over (timestamp, sequence, rowId). Default "asc". */
  order?: "asc" | "desc";
  /** Page size; default 100. */
  limit?: number;
  /** Opaque keyset cursor from a prior page. */
  cursor?: string;
}

export interface ReadModelPage {
  rows: ReadModelRow[];
  /** Present iff more rows exist past this page. */
  nextCursor?: string;
}

/** Hard page-size ceiling (audit hardening): huge limits cannot exhaust a backend. */
export const MAX_QUERY_LIMIT = 10_000;

/** Validate + clamp a query limit. Backends MUST route limits through this (SPI contract). */
export function clampQueryLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError(`read-model query: limit must be a positive integer (got ${limit})`);
  }
  return Math.min(limit, MAX_QUERY_LIMIT);
}

/** The keyset cursor tuple every backend orders by. */
export type QueryCursor = [timestamp: number, sequence: number, rowId: string];

/** Parse + validate an opaque cursor. Malformed input is a loud TypeError, never a crash. */
export function parseQueryCursor(cursor: string): QueryCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    parsed = undefined;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    typeof parsed[0] !== "number" ||
    typeof parsed[1] !== "number" ||
    typeof parsed[2] !== "string"
  ) {
    throw new TypeError(
      "read-model query: malformed cursor — pass back the nextCursor a prior page returned"
    );
  }
  return parsed as QueryCursor;
}

/**
 * The read-model store SPI — a dumb indexed row store. All model knowledge
 * (kinds, extractors) lives above, in {@link ReadModelService}. Conformance:
 * `runReadModelStoreConformance` in `@loom/conformance`.
 */
export interface ReadModelStore {
  /**
   * Apply rows and advance the (modelId, executionId) watermark to
   * `upToSequence` — MONOTONIC (a lower value never regresses it) and
   * IDEMPOTENT per row (a rowId already applied is a no-op). Rows may be empty
   * (events scanned, none matched) — the watermark still advances.
   */
  apply(
    modelId: string,
    executionId: string,
    upToSequence: number,
    rows: readonly ReadModelRow[]
  ): Promise<void>;
  /** Highest applied sequence for (modelId, executionId), or null if never seen. */
  watermark(modelId: string, executionId: string): Promise<number | null>;
  /** Executions this model has watermarks for (drives incremental catch-up). */
  watermarkedExecutions(modelId: string): Promise<string[]>;
  query(modelId: string, q?: ReadModelQuery): Promise<ReadModelPage>;
  /**
   * RM-2 — drop ALL rows and watermarks for the model (rebuild support). Idempotent.
   *
   * Whole-model is deliberate (a cache, not an authority), and it is also the ONLY
   * erasure path a read model has: a crypto-shred erases the log and leaves every
   * derived row holding the plaintext the extractor copied out beforehand. Invalidating
   * one subject therefore means `clear` + re-scan — *O(log)*, not *O(subject)* — through
   * a source that tolerates shredded payloads, because the authoritative read of a
   * shredded subject throws. See `docs/compliance.md` and `erasure.test.ts`; a
   * row-granular purge is deferred behind a measured cost
   * (ADR 0092 D6).
   */
  clear(modelId: string): Promise<void>;
  close?(): Promise<void>;
}

/** Structural read surface of an event store — live store or K10.1 archive (RM-4). */
export interface ReadModelEventSource {
  listExecutions?(): Promise<string[]>;
  /** SP-2 — preferred when present: bounded-memory keyset enumeration (SPI 1.2.0). */
  listExecutionsPage?(opts?: {
    cursor?: string;
    limit?: number;
  }): Promise<{ executionIds: string[]; nextCursor?: string }>;
  readFrom(executionId: string, fromSequence: number): Promise<EventEnvelope[]>;
}

export interface CatchUpReport {
  executionsScanned: number;
  eventsScanned: number;
  rowsApplied: number;
}
