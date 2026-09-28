/**
 * The ONE order of executionIds that `listExecutionsPage` promises (EventStore SPI 2.0.0, ADR 0108):
 * Unicode code point order — the same as UTF-8 byte order, SQL `COLLATE "C"` and SQLite's
 * BINARY collation, so a SQL backend can serve it from a plain b-tree.
 *
 * Not JavaScript's default string order: `<` and `Array.prototype.sort()` compare UTF-16
 * code UNITS, which agree with code points everywhere except that an astral character (a
 * surrogate pair, 0xD800–0xDFFF) sorts BELOW U+E000–U+FFFF by code unit and ABOVE them by
 * code point. `ShardedEventStore` merges shard pages with this comparator and resumes every
 * shard from the merged page's last id, so it and every store must agree exactly — a store
 * paging in any other order (a Postgres database collation, say) silently skips ids.
 *
 * The parity with UTF-8 byte order holds for WELL-FORMED ids only. A lone surrogate has no
 * UTF-8 encoding: node-postgres sends it as U+FFFD, so a Postgres store neither keeps nor
 * orders such an id the way this function does. Execution ids should be well-formed Unicode
 * (every id generator loom ships produces ASCII).
 *
 * O(length of the common prefix), no allocation.
 */
export function compareExecutionIds(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    // Below 0xD800 code-unit order is code-point order. When both units are at or above it,
    // lift the surrogates above U+E000–U+FFFF (and lower those to make room), which is
    // exactly where their code points sit. (A lone surrogate gets a consistent position here,
    // but no store is obliged to agree: it cannot round-trip through UTF-8.)
    if (x >= 0xd800 && y >= 0xd800) return surrogateLast(x) - surrogateLast(y);
    return x - y;
  }
  return a.length - b.length;
}

function surrogateLast(unit: number): number {
  return unit >= 0xe000 ? unit - 0x800 : unit + 0x2000;
}
