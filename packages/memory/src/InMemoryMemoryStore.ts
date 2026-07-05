import type { MemoryEntry, MemoryStore } from "./types";

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
}
