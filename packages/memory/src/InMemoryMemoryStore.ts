import type { MemoryEntry, MemoryStore } from "./types";

export class InMemoryMemoryStore implements MemoryStore {
  private readonly entries = new Map<string, MemoryEntry[]>();

  append(key: string, entry: MemoryEntry): void {
    const list = this.entries.get(key) ?? [];
    list.push(entry);
    this.entries.set(key, list);
  }

  read(key: string): MemoryEntry[] {
    return this.entries.get(key) ?? [];
  }

  clear(key: string): void {
    this.entries.delete(key);
  }
}
