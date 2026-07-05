import type { EventEnvelope } from "@loom/core";
import type { EventStore } from "@loom/event-runtime";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";

// Minimal in-memory stores so the mesh demo runs with zero external services.
export class InMemoryEventStore implements EventStore {
  private readonly events = new Map<string, EventEnvelope[]>();

  append(e: EventEnvelope): void {
    const list = this.events.get(e.executionId) ?? [];
    list.push(e);
    this.events.set(e.executionId, list);
  }
  read(id: string): EventEnvelope[] {
    return this.events.get(id) ?? [];
  }
  readFrom(id: string, from: number): EventEnvelope[] {
    return this.read(id).filter((e) => e.sequence >= from);
  }
  subscribe(): () => void {
    return () => {};
  }
  nextSequence(id: string): number {
    const list = this.events.get(id);
    if (!list || list.length === 0) return 0;
    return (list[list.length - 1]?.sequence ?? -1) + 1;
  }
  close(): void {}
}

export class InMemorySnapshotStore implements SnapshotStore {
  private readonly snaps = new Map<string, Snapshot[]>();

  save(s: Snapshot): void {
    const list = this.snaps.get(s.executionId) ?? [];
    list.push(s);
    this.snaps.set(s.executionId, list);
  }
  loadLatest(id: string): Snapshot | null {
    const list = this.snaps.get(id);
    return list && list.length > 0 ? (list[list.length - 1] ?? null) : null;
  }
  loadAt(id: string, sequence: number): Snapshot | null {
    const list = this.snaps.get(id);
    if (!list) return null;
    const c = list.filter((s) => s.sequence <= sequence);
    return c[c.length - 1] ?? null;
  }
  loadLatestBefore(id: string, sequence: number): Snapshot | null {
    return this.loadAt(id, sequence);
  }
  close(): void {}
}
