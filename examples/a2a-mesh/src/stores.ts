import type { EventEnvelope } from "@loom/core";
import type { EventStore } from "@loom/event-runtime";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";

// Minimal in-memory stores so the mesh demo runs with zero external services.
export class InMemoryEventStore implements EventStore {
  private readonly events = new Map<string, EventEnvelope[]>();

  async append(e: EventEnvelope): Promise<void> {
    const list = this.events.get(e.executionId) ?? [];
    list.push(e);
    this.events.set(e.executionId, list);
  }
  async read(id: string): Promise<EventEnvelope[]> {
    return this.events.get(id) ?? [];
  }
  async readFrom(id: string, from: number): Promise<EventEnvelope[]> {
    return (await this.read(id)).filter((e) => e.sequence >= from);
  }
  async subscribe(): Promise<() => void> {
    return () => {};
  }
  async close(): Promise<void> {}
}

export class InMemorySnapshotStore implements SnapshotStore {
  private readonly snaps = new Map<string, Snapshot[]>();

  async save(s: Snapshot): Promise<void> {
    const list = this.snaps.get(s.executionId) ?? [];
    list.push(s);
    this.snaps.set(s.executionId, list);
  }
  async loadLatest(id: string): Promise<Snapshot | null> {
    const list = this.snaps.get(id);
    return list && list.length > 0 ? (list[list.length - 1] ?? null) : null;
  }
  async loadAt(id: string, sequence: number): Promise<Snapshot | null> {
    const list = this.snaps.get(id);
    if (!list) return null;
    const c = list.filter((s) => s.sequence <= sequence);
    return c[c.length - 1] ?? null;
  }
  async loadLatestBefore(id: string, sequence: number): Promise<Snapshot | null> {
    return this.loadAt(id, sequence);
  }
  async close(): Promise<void> {}
}
