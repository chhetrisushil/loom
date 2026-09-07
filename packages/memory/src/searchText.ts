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
 * The text a store indexes for an entry: its `content`'s string and number LEAVES,
 * whitespace-joined.
 *
 * - `role` and `timestamp` are metadata, not content. Indexing them would make every
 *   assistant turn a hit for "assistant".
 * - object KEYS are schema, not content: indexing them makes "latency" match a record
 *   that merely *has* a latency field and says nothing about latency.
 * - numbers are kept, because "500" and "2026" are things people search for.
 */
export function searchableText(entry: MemoryEntry): string {
  const out: string[] = [];
  collect(entry.content, out);
  return out.join(" ");
}

function collect(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "number" && Number.isFinite(value)) out.push(String(value));
  else if (Array.isArray(value)) for (const item of value) collect(item, out);
  else if (value !== null && typeof value === "object")
    for (const item of Object.values(value)) collect(item, out);
}
