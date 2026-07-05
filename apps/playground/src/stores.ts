import type { EventEnvelope } from "@loom/core";
import type { EventStore } from "@loom/event-runtime";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";

export class InMemoryEventStore implements EventStore {
  private readonly events = new Map<string, EventEnvelope[]>();
  private readonly subs = new Map<string, Set<(e: EventEnvelope) => void>>();

  async append(envelope: EventEnvelope): Promise<void> {
    const list = this.events.get(envelope.executionId) ?? [];
    list.push(envelope);
    this.events.set(envelope.executionId, list);
    this.subs.get(envelope.executionId)?.forEach((fn) => fn(envelope));
  }
  async read(id: string): Promise<EventEnvelope[]> {
    return this.events.get(id) ?? [];
  }
  async readFrom(id: string, from: number): Promise<EventEnvelope[]> {
    return (await this.read(id)).filter((e) => e.sequence >= from);
  }
  async subscribe(id: string, handler: (e: EventEnvelope) => void): Promise<() => void> {
    const set = this.subs.get(id) ?? new Set();
    set.add(handler);
    this.subs.set(id, set);
    return () => set.delete(handler);
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
  async loadAt(id: string, seq: number): Promise<Snapshot | null> {
    const candidates = (this.snaps.get(id) ?? []).filter((s) => s.sequence <= seq);
    return candidates[candidates.length - 1] ?? null;
  }
  async loadLatestBefore(id: string, seq: number): Promise<Snapshot | null> {
    return this.loadAt(id, seq);
  }
  async close(): Promise<void> {}
}
