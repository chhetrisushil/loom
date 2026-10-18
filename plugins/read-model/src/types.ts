import type { EventEnvelope, ProjectionDefinition } from "@loom/core";

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
  /**
   * ADR 0095 — the declared semantics of {@link ReadModelDefinition.extract}.
   *
   * Changing an extractor is silent by construction: the rows the old one wrote stay, the
   * `(modelId, executionId)` watermark is already past the events that produced them, so
   * catch-up never revisits them, and one `query` then answers from two extractors at once.
   * `rebuild()` is the exit — this is what lets a caller find out it is needed, by comparing
   * the version a derived artifact recorded against {@link ReadModelService.pins}.
   *
   * Bump it when what a row MEANS changes (different fields, different value, different
   * filter); a refactor that produces identical rows is not a new version. Declared rather
   * than derived, for the reason `flowContentHash` excludes handler code.
   */
  version?: string;
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

/**
 * The {@link ReadModelStore} SPI contract version (ADR 0093).
 *
 * - `1.0.0`: `apply` / `watermark` / `watermarkedExecutions` / `query` / `clear`, plus
 *   optional `close`.
 * - `1.1.0`: optional {@link ReadModelStore.purge} — row-granular deletion by
 *   indexed-field equality. MINOR because a backend that omits it behaves exactly as
 *   before: callers reach it through `ReadModelService.purge`, which REFUSES loudly
 *   when the backend cannot do it rather than deleting nothing and returning, which is
 *   the one behaviour an erasure path must never have.
 * - `1.2.0`: five optional folded-state methods (ADR 0132); clear() also drops folded state.
 */
export const READ_MODEL_STORE_SPI_VERSION = "1.2.0";

/**
 * Raised when a purge is asked of a backend that does not implement it. Typed rather
 * than a bare `TypeError` so a compliance caller can catch it and fall back to
 * `clear` + rebuild deliberately — the fallback is correct but *O(log)*, so choosing it
 * should be a decision in the caller's code, not a surprise.
 */
export class PurgeUnsupportedError extends Error {
  readonly name = "PurgeUnsupportedError";
  constructor(readonly modelId: string) {
    super(
      `read model "${modelId}": this backend does not implement purge (ReadModelStore SPI ${READ_MODEL_STORE_SPI_VERSION}). Erase by clear(modelId) + rebuild from the log, or use a backend that implements it.`
    );
  }
}

/**
 * Validate a purge filter. Backends MUST call this — contract, not hygiene.
 *
 * An EMPTY filter is refused rather than read as match-all. Match-all is `clear`, which
 * a caller has to name explicitly; a filter is something a caller COMPUTES — from a
 * subject id, a tenant, a lookup that returned nothing — and the empty case is exactly
 * the one arrived at by accident. Reading it as "every row" turns a no-op into a silent
 * wipe of the model, and reading it as "no rows" turns an erasure into a lie. Refusing
 * is the only answer that is safe in both directions.
 */
export function assertPurgeFilter(where: Record<string, ReadModelScalar>): void {
  if (Object.keys(where).length === 0) {
    throw new TypeError(
      "read-model purge: the filter must name at least one field — an empty filter is not 'every row' (that is `clear`), and silently matching nothing would report an erasure that did not happen"
    );
  }
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
   * OPTIONAL row-granular delete (SPI 1.1.0, ADR 0093). Remove every row of `modelId`
   * whose declared indexed fields all equal `where` — the same equality semantics
   * `query` uses, ANDed. Returns how many rows were deleted.
   *
   * It exists for erasure. A crypto-shred erases the log and leaves derived rows holding
   * the plaintext an extractor copied out beforehand, and until this method the only
   * removal verb was {@link ReadModelStore.clear} — the whole model, re-scanned from the
   * log, *O(log)* per subject (see `docs/compliance.md`).
   *
   * Contract a backend MUST honour:
   * - **Watermarks are NOT touched.** Purge says "these rows are erased", not "re-read
   *   this history": advancing or clearing a watermark would make the next catch-up
   *   re-derive the very rows just deleted, from a log that may still hold them.
   * - **An empty filter is refused**, never read as match-all — route it through
   *   {@link assertPurgeFilter}, and see there for why.
   * - **Idempotent**, and a filter matching nothing returns `0` rather than throwing: an
   *   erasure is commonly retried, and the second run legitimately finds nothing.
   * - **Scoped to one model.** Another model's rows with identical field values stay.
   *
   * A store that omits it is unchanged; `ReadModelService.purge` then raises
   * {@link PurgeUnsupportedError} rather than reporting an erasure that never happened.
   */
  purge?(modelId: string, where: Record<string, ReadModelScalar>): Promise<number>;

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
   * (ADR 0092 D6). Also drops the model's folded states and fold header.
   */
  clear(modelId: string): Promise<void>;
  /**
   * OPTIONAL folded-state methods (SPI 1.2.0, ADR 0132). All five or none.
   * `beginFold`: create the model header, or — if `foldVersion` differs from the stored one —
   * delete the model's folded states and swap the header in ONE transaction (`rebuilt: true`).
   */
  beginFold?(modelId: string, foldVersion: string): Promise<{ rebuilt: boolean }>;
  /** Monotonic compare-and-set of one execution's state + watermark. See ADR 0132 D3. */
  applyFolded?(a: FoldedApply): Promise<FoldedApplyResult>;
  /** Records for the given executions (absent ones omitted), input order. Routes through `assertManyKeys`. */
  getFolded?(modelId: string, executionIds: readonly string[]): Promise<FoldedRecord[]>;
  /** Records whose `key` is in `keys`, ordered by executionId in byte (code-point) order. Routes through `assertManyKeys`. */
  getFoldedByKey?(modelId: string, keys: readonly string[]): Promise<FoldedRecord[]>;
  /** Tombstone (`state = NULL, erased = true`, sequence KEPT); returns newly tombstoned count. */
  purgeFolded?(modelId: string, selector: FoldedSelector): Promise<number>;
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

// ── ADR 0132 — folded-state read models ──────────────────────────────────────

/** A folded model: the `projection$` fold plus pure id-derived key/scope (D1, D2). */
export interface FoldedReadModelDefinition<TState = unknown> {
  /** id, version (REQUIRED here), initialState, handlers — straight from `projection$`. */
  projection: ProjectionDefinition<TState>;
  /** App key (e.g. documentId) derived from the executionId ONLY — never from event data. */
  keyOf?: (executionId: string) => string | undefined;
  /** Tenant/RLS scope derived from the executionId ONLY. */
  scopeOf?: (executionId: string) => string | undefined;
  /** Payload dot-paths a handler must never see (ADR 0132 D11); unioned with the service's `sensitive`. */
  sensitive?: SensitiveMap;
}

/** eventType -> payload dot-paths (`[]` wildcards allowed): the shape of `EncryptingEventStore`'s `sensitive` option. */
export type SensitiveMap = Readonly<Record<string, readonly string[]>>;

/** One stored folded state. `state === null` means "no handled event yet" or erased. */
export interface FoldedRecord {
  executionId: string;
  key: string | null;
  scope: string | null;
  /** The watermark: highest sequence folded into `state`. */
  sequence: number;
  state: unknown | null;
  erased: boolean;
}

/** What a fold starts from: a stored record, or a cached copy of one (ADR 0132 D15). */
export type FoldBase = Pick<FoldedRecord, "sequence" | "state" | "erased">;

export interface FoldedApply {
  modelId: string;
  executionId: string;
  upToSequence: number;
  state: unknown | null;
  key: string | null;
  scope: string | null;
  /** The writer's fold version; refused when the model header says otherwise. */
  foldVersion: string;
}

/** `stale` = an equal-or-lower sequence (idempotent re-apply or a lost race). */
export type FoldedApplyResult = "applied" | "stale" | "version-mismatch";

export type FoldedSelector = { executionId: string } | { key: string } | { scope: string };

/** What `getMany` / `getManyByKey` return per execution. */
export interface FoldedState<TState = unknown> {
  executionId: string;
  key: string | null;
  sequence: number;
  state: TState;
}

/** Hard ceiling on keys per batch read. */
export const MAX_GET_MANY = 1_000;

/** Validate a batch-read key list. Backends MUST route through this (SPI contract). */
export function assertManyKeys(keys: readonly string[], what: string): void {
  if (keys.length > MAX_GET_MANY) {
    throw new RangeError(
      `read-model ${what}: at most ${MAX_GET_MANY} keys per call (got ${keys.length})`
    );
  }
  for (const k of keys) {
    if (typeof k !== "string" || k === "") {
      throw new TypeError(`read-model ${what}: keys must be non-empty strings`);
    }
  }
}

/** Per-node state cache for the live apply path (ADR 0132 D15). */
export interface FoldCacheOptions {
  /** Max (model, execution) entries on this node. 0 disables. Default {@link DEFAULT_FOLD_CACHE_ENTRIES}. */
  maxEntries?: number;
}
export const DEFAULT_FOLD_CACHE_ENTRIES = 1_024;

/** Everything the engine needs beyond the store and `onError`. */
export interface FoldedEngineOptions {
  /** Fills a gap in the live tail (D4) — normally this node's own event store. */
  liveSource?: ReadModelEventSource;
  /** Service-wide sensitive paths (D11); unioned with each model's own. */
  sensitive?: SensitiveMap;
  /** `false` disables the state cache (D15). */
  cache?: FoldCacheOptions | false;
}

/** Options shared by `getMany` / `getManyByKey` (engine and service). */
export interface FoldedReadOptions {
  /** Fold each execution's log tail past its watermark first (read-your-writes, D8). */
  refreshFrom?: readonly ReadModelEventSource[];
  /** Executions refreshed in parallel. Default 8. */
  concurrency?: number;
}

/** The options object of `refresh` (ADR 0132 D8). */
export interface RefreshOptions {
  /** Executions refreshed in parallel. Default 8. */
  concurrency?: number;
}

/** The one column a purge selector names, with its value. Backends use it so the mapping lives in one place. */
export function foldedSelectorColumn(
  selector: FoldedSelector
): readonly ["execution_id" | "app_key" | "scope", string] {
  if ("executionId" in selector) return ["execution_id", selector.executionId];
  if ("key" in selector) return ["app_key", selector.key];
  return ["scope", selector.scope];
}

export class FoldedUnsupportedError extends Error {
  readonly name = "FoldedUnsupportedError";
  constructor(readonly modelId: string) {
    super(
      `read model "${modelId}": this backend does not implement the folded-state methods (ReadModelStore SPI ${READ_MODEL_STORE_SPI_VERSION}) — use InMemory/Sqlite/Postgres or implement beginFold/applyFolded/getFolded/getFoldedByKey/purgeFolded`
    );
  }
}

/** A gap in a live tail with no `liveSource` to fill it; the next catch-up heals it. */
export class FoldGapError extends Error {
  readonly name = "FoldGapError";
  constructor(
    readonly modelId: string,
    readonly executionId: string,
    readonly watermark: number,
    readonly sequence: number
  ) {
    super(
      `folded model "${modelId}": execution "${executionId}" is at ${watermark} but event ${sequence} arrived — run catchUp() or configure a liveSource`
    );
  }
}

/** This node's fold version is not the model's current one (a rolling deploy's old node). */
export class FoldVersionMismatchError extends Error {
  readonly name = "FoldVersionMismatchError";
  constructor(
    readonly modelId: string,
    readonly version: string
  ) {
    super(
      `folded model "${modelId}": version "${version}" is not the store's current fold version — this node's apply was refused`
    );
  }
}
