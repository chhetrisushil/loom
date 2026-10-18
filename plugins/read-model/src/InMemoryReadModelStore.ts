import type {
  FoldedApply,
  FoldedApplyResult,
  FoldedRecord,
  FoldedSelector,
  ReadModelPage,
  ReadModelQuery,
  ReadModelRow,
  ReadModelScalar,
  ReadModelStore,
} from "./types";
import { assertManyKeys, assertPurgeFilter, clampQueryLimit, parseQueryCursor } from "./types";

type Cursor = [timestamp: number, sequence: number, rowId: string];

function keyOf(row: ReadModelRow): Cursor {
  return [row.timestamp, row.sequence, row.rowId];
}

function compareKeys(a: Cursor, b: Cursor): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
}

function matches(row: ReadModelRow, q: ReadModelQuery): boolean {
  if (q.kind !== undefined && row.kind !== q.kind) return false;
  if (q.where !== undefined) {
    for (const [field, expected] of Object.entries(q.where)) {
      if ((row.fields[field] ?? null) !== expected) return false;
    }
  }
  return true;
}

/**
 * Reference in-memory backend — the conformance baseline and the test/dev
 * default. Rows are deep-cloned on write and read (value semantics, matching
 * the JSON round-trip of the durable backends).
 */
export class InMemoryReadModelStore implements ReadModelStore {
  private readonly rows = new Map<string, Map<string, ReadModelRow>>();
  private readonly watermarks = new Map<string, Map<string, number>>();
  private readonly foldVersions = new Map<string, string>();
  private readonly folded = new Map<string, Map<string, FoldedRecord>>();

  async apply(
    modelId: string,
    executionId: string,
    upToSequence: number,
    rows: readonly ReadModelRow[]
  ): Promise<void> {
    let byId = this.rows.get(modelId);
    if (byId === undefined) {
      byId = new Map();
      this.rows.set(modelId, byId);
    }
    for (const row of rows) {
      if (!byId.has(row.rowId)) byId.set(row.rowId, structuredClone(row)); // idempotent
    }
    let marks = this.watermarks.get(modelId);
    if (marks === undefined) {
      marks = new Map();
      this.watermarks.set(modelId, marks);
    }
    const prior = marks.get(executionId);
    if (prior === undefined || upToSequence > prior) marks.set(executionId, upToSequence); // monotonic
  }

  async purge(modelId: string, where: Record<string, ReadModelScalar>): Promise<number> {
    assertPurgeFilter(where);
    const byId = this.rows.get(modelId);
    if (byId === undefined) return 0;
    let deleted = 0;
    // One pass, deleting through the iterator — a Map tolerates delete-during-iteration
    // for the current entry, so this needs no intermediate array of keys.
    for (const [rowId, row] of byId) {
      if (matches(row, { where })) {
        byId.delete(rowId);
        deleted++;
      }
    }
    // Watermarks deliberately untouched: see the SPI contract.
    return deleted;
  }

  async watermark(modelId: string, executionId: string): Promise<number | null> {
    return this.watermarks.get(modelId)?.get(executionId) ?? null;
  }

  async watermarkedExecutions(modelId: string): Promise<string[]> {
    return [...(this.watermarks.get(modelId)?.keys() ?? [])];
  }

  async query(modelId: string, q: ReadModelQuery = {}): Promise<ReadModelPage> {
    const desc = q.order === "desc";
    const limit = clampQueryLimit(q.limit);
    const all = [...(this.rows.get(modelId)?.values() ?? [])]
      .filter((row) => matches(row, q))
      .sort((a, b) => (desc ? -1 : 1) * compareKeys(keyOf(a), keyOf(b)));

    let start = 0;
    if (q.cursor !== undefined) {
      const after = parseQueryCursor(q.cursor);
      start = all.findIndex((row) => (desc ? -1 : 1) * compareKeys(keyOf(row), after) > 0);
      if (start === -1) start = all.length;
    }
    const page = all.slice(start, start + limit).map((row) => structuredClone(row));
    const last = page[page.length - 1];
    return {
      rows: page,
      ...(last !== undefined &&
        start + limit < all.length && { nextCursor: JSON.stringify(keyOf(last)) }),
    };
  }

  async clear(modelId: string): Promise<void> {
    this.rows.delete(modelId);
    this.watermarks.delete(modelId);
    this.folded.delete(modelId);
    this.foldVersions.delete(modelId);
  }

  async beginFold(modelId: string, foldVersion: string): Promise<{ rebuilt: boolean }> {
    const prior = this.foldVersions.get(modelId);
    this.foldVersions.set(modelId, foldVersion);
    if (prior === undefined || prior === foldVersion) return { rebuilt: false };
    this.folded.delete(modelId);
    return { rebuilt: true };
  }

  async applyFolded(a: FoldedApply): Promise<FoldedApplyResult> {
    if (this.foldVersions.get(a.modelId) !== a.foldVersion) return "version-mismatch";
    let byExec = this.folded.get(a.modelId);
    if (byExec === undefined) {
      byExec = new Map();
      this.folded.set(a.modelId, byExec);
    }
    const prev = byExec.get(a.executionId);
    if (prev !== undefined && prev.sequence >= a.upToSequence) return "stale";
    byExec.set(a.executionId, {
      executionId: a.executionId,
      key: a.key ?? prev?.key ?? null,
      scope: a.scope ?? prev?.scope ?? null,
      sequence: a.upToSequence,
      state: prev?.erased === true ? null : structuredClone(a.state),
      erased: prev?.erased ?? false,
    });
    return prev?.erased === true ? "applied-erased" : "applied";
  }

  async getFolded(modelId: string, executionIds: readonly string[]): Promise<FoldedRecord[]> {
    assertManyKeys(executionIds, "getFolded");
    const byExec = this.folded.get(modelId);
    return [...new Set(executionIds)].flatMap((id) => {
      const r = byExec?.get(id);
      return r === undefined ? [] : [structuredClone(r)];
    });
  }

  async getFoldedByKey(modelId: string, keys: readonly string[]): Promise<FoldedRecord[]> {
    assertManyKeys(keys, "getFoldedByKey");
    const wanted = new Set(keys);
    return [...(this.folded.get(modelId)?.values() ?? [])]
      .filter((r) => r.key !== null && wanted.has(r.key))
      .sort((a, b) => (a.executionId < b.executionId ? -1 : a.executionId > b.executionId ? 1 : 0))
      .map((r) => structuredClone(r));
  }

  async purgeFolded(modelId: string, selector: FoldedSelector): Promise<number> {
    let n = 0;
    for (const r of this.folded.get(modelId)?.values() ?? []) {
      const hit =
        "executionId" in selector
          ? r.executionId === selector.executionId
          : "key" in selector
            ? r.key === selector.key
            : r.scope === selector.scope;
      if (hit && !r.erased) {
        r.state = null; // tombstone: sequence KEPT (ADR 0132 D12)
        r.erased = true;
        n++;
      }
    }
    return n;
  }
}

export type { ReadModelScalar };
