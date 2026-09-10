import { isTainted } from "@loom/classify";
import type { MemoryEntry } from "./types";

/**
 * The searchable projection of an entry, and the tokenizer over it.
 *
 * Both live here, and every backend uses them, because "what text is indexed" and
 * "what counts as a term" ARE the search contract. A backend that indexed something
 * else would still pass a kit that only asked whether a match came back — it would
 * just quietly answer a different question than the one the app asked.
 */

// Split on anything that is not a letter or a number, so non-Latin content survives
// (the `u` flag matters: without it "χ" is not a letter). No stemming and no stopword
// list — deterministic and language-neutral, and close to what SQLite's `unicode61`
// and Postgres's `simple` configuration do, so the three backends tokenize alike.
const SEPARATOR = /[^\p{L}\p{N}]+/u;

/** Lowercased terms of a query or a document. Terms are alphanumeric, so a term can never
 *  carry FTS5 / tsquery syntax — which is what makes it safe to build a query from them. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(SEPARATOR)
    .filter((t) => t.length > 0);
}

/**
 * How many distinct terms of a QUERY a backend may search for.
 *
 * A question is an input, and this is the bound on the work one can buy. 256 distinct
 * terms is far past any real question — a 500-word paste is under it — and it holds the
 * pathological case to a millisecond.
 */
export const MAX_QUERY_TERMS = 256;

/**
 * The terms a backend searches for: {@link tokenize}, DEDUPLICATED and capped.
 *
 * Both halves are load-bearing, and both were measured on the 1P backends before this
 * existed:
 *
 * - **Dedupe.** Terms are OR-ed, so a repeated term is the same term — it cannot change
 *   which entries match, only how long the store takes to say so. A 128 KB query repeating
 *   one word 20,000 times built a 20,000-clause `MATCH` and took SQLite **32.7 seconds**;
 *   deduplicated it is one clause and sub-millisecond. That is a denial of service bought
 *   with a text box.
 * - **Cap.** Distinct terms cost linearly (4,096 terms ≈ 19 ms on SQLite, ≈ 238 ms on the
 *   reference scorer over 2,000 entries), so an unbounded query is an unbounded scan.
 *
 * It DEGRADES rather than refuses — the same choice `searchableText`'s depth limit makes.
 * A query is a relevance hint, not a validated payload, and a store that threw on a long
 * question would fail a caller who did nothing wrong. First-seen order is preserved so the
 * terms that survive are the ones the asker led with.
 */
export function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const term of tokenize(query)) {
    seen.add(term);
    if (seen.size >= MAX_QUERY_TERMS) break;
  }
  return [...seen];
}

/**
 * The text a store indexes for an entry: its `content`'s string and number LEAVES,
 * whitespace-joined.
 *
 * - `role` and `timestamp` are metadata, not content. Indexing them would make every
 *   assistant turn a hit for "assistant".
 * - object KEYS are schema, not content: indexing them makes "latency" match a record
 *   that merely *has* a latency field and says nothing about latency.
 * - numbers are kept, because "500" and "2026" are things people search for.
 * - a TAINTED value (ADR 0085) is indexed as its inner content. The wrapper's
 *   `origin` is provenance, and provenance is metadata by the same rule that
 *   excludes `role`: an ingested corpus taints every entry, so indexing the label
 *   makes one query term ("runbook", "mcp", the tool's name) match the entire
 *   corpus at once — it widens the match SET on an FTS backend, not merely the
 *   ranking. Only this wrapper is unwrapped, because it is the only framework
 *   wrapper an entry's content is known to carry.
 */
export function searchableText(entry: MemoryEntry): string {
  const out: string[] = [];
  collect(entry.content, out);
  return out.join(" ");
}

/**
 * How deep the walk descends before it stops.
 *
 * `content` is whatever was ingested, and a corpus is edited by whoever can edit the
 * source. Recursion here was unbounded, which made two ordinary values fatal: a nesting
 * depth of 5,000 — still perfectly JSON-serializable, so it satisfies the documented
 * `content` contract and every durable backend's own `JSON.stringify` — blew the call
 * stack, and a cyclic object never terminated. The in-memory store made that worse by
 * accepting such an entry on `append` and throwing later, on an unrelated `search`.
 */
const MAX_DEPTH = 512;

/**
 * Iterative, with an explicit stack, so no input depth can exhaust the call stack — the
 * same shape `blueprint-runtime`'s widget walk uses, and a depth cap like `schemaHash`'s.
 *
 * Over-deep content is INDEXED AS FAR AS THE CAP rather than refused. This is an index,
 * not a validator: the entry is still stored and still findable by the text above the
 * cap, where refusing would make legal content unstorable. The cap also terminates a
 * cycle, since following one only ever increases depth.
 */
function collect(root: unknown, out: string[]): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const { value, depth } = frame;
    if (isTainted(value)) {
      if (depth < MAX_DEPTH) stack.push({ value: value.value, depth: depth + 1 });
      continue;
    }
    if (typeof value === "string") {
      out.push(value);
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      out.push(String(value));
      continue;
    }
    if (depth >= MAX_DEPTH) continue;
    // Pushed in reverse so the walk still emits terms in source order — the projection
    // is compared verbatim in tests, and an FTS index should not depend on walk order.
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) {
        stack.push({ value: value[i], depth: depth + 1 });
      }
      continue;
    }
    if (value !== null && typeof value === "object") {
      const values = Object.values(value);
      for (let i = values.length - 1; i >= 0; i--) {
        stack.push({ value: values[i], depth: depth + 1 });
      }
    }
  }
}
