import type { EventEnvelope } from "@loom/core";
import type { EventStore } from "@loom/event-runtime";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";

export class InMemoryEventStore implements EventStore {
  private readonly events = new Map<string, EventEnvelope[]>();
  private readonly subs = new Map<string, Set<(e: EventEnvelope) => void>>();

  append(envelope: EventEnvelope): void {
    const list = this.events.get(envelope.executionId) ?? [];
    list.push(envelope);
    this.events.set(envelope.executionId, list);
    this.subs.get(envelope.executionId)?.forEach((fn) => fn(envelope));
  }
  read(id: string): EventEnvelope[] {
    return this.events.get(id) ?? [];
  }
  readFrom(id: string, from: number): EventEnvelope[] {
    return this.read(id).filter((e) => e.sequence >= from);
  }
  subscribe(id: string, handler: (e: EventEnvelope) => void): () => void {
    const set = this.subs.get(id) ?? new Set();
    set.add(handler);
    this.subs.set(id, set);
    return () => set.delete(handler);
  }
  nextSequence(id: string): number {
    const list = this.events.get(id);
    return list && list.length > 0 ? (list[list.length - 1]?.sequence ?? -1) + 1 : 0;
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
  loadAt(id: string, seq: number): Snapshot | null {
    const candidates = (this.snaps.get(id) ?? []).filter((s) => s.sequence <= seq);
    return candidates[candidates.length - 1] ?? null;
  }
  loadLatestBefore(id: string, seq: number): Snapshot | null {
    return this.loadAt(id, seq);
  }
  close(): void {}
}
