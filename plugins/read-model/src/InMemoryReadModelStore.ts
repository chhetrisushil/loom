import type {
  ReadModelPage,
  ReadModelQuery,
  ReadModelRow,
  ReadModelScalar,
  ReadModelStore,
} from "./types";
import { clampQueryLimit, parseQueryCursor } from "./types";

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
  }
}

export type { ReadModelScalar };
