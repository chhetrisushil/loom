import { searchableText, tokenize } from "./searchText";
import { clampSearchLimit } from "./types";
import type { MemoryEntry, MemorySearchOptions, MemoryStore } from "./types";

export class InMemoryMemoryStore implements MemoryStore {
  private readonly entries = new Map<string, MemoryEntry[]>();

  async append(key: string, entry: MemoryEntry): Promise<void> {
    const list = this.entries.get(key) ?? [];
    list.push(entry);
    this.entries.set(key, list);
  }

  async read(key: string): Promise<MemoryEntry[]> {
    return this.entries.get(key) ?? [];
  }

  async clear(key: string): Promise<void> {
    this.entries.delete(key);
  }

  /**
   * Reference relevance search: sum of the IDF of the query terms an entry contains,
   * ties broken by recency. Deliberately simple and deliberately NOT a hidden search
   * engine — it exists so `recallRelevant` works on the default store and so the kit
   * runs against three independent rankers rather than one implementation twice. IDF
   * (rather than a raw match count) is what stops a term present in every entry from
   * deciding the order; a real corpus belongs in SqliteMemoryStore/PostgresMemoryStore,
   * whose indexes do this properly and without scanning.
   */
  async search(key: string, query: string, opts: MemorySearchOptions = {}): Promise<MemoryEntry[]> {
    const terms = new Set(tokenize(query));
    const entries = this.entries.get(key) ?? [];
    if (terms.size === 0 || entries.length === 0) return [];

    // One pass to the document-frequency table, one to score: O(entries × terms).
    const documents = entries.map((entry) => new Set(tokenize(searchableText(entry))));
    const documentFrequency = new Map<string, number>();
    for (const document of documents) {
      for (const term of terms) {
        if (document.has(term)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }

    const scored: { entry: MemoryEntry; index: number; score: number }[] = [];
    for (const [index, document] of documents.entries()) {
      let score = 0;
      for (const term of terms) {
        const frequency = documentFrequency.get(term);
        if (frequency !== undefined && document.has(term)) {
          score += Math.log(1 + entries.length / frequency);
        }
      }
      if (score > 0) scored.push({ entry: entries[index] as MemoryEntry, index, score });
    }

    // Descending score; a tie goes to the more recently appended entry.
    scored.sort((a, b) => b.score - a.score || b.index - a.index);
    return scored.slice(0, clampSearchLimit(opts.limit)).map((s) => s.entry);
  }
}
