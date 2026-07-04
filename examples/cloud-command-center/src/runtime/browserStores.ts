import type { EventEnvelope } from "@loom/core";
import type { EventStore } from "@loom/event-runtime";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";

export class InMemoryEventStore implements EventStore {
  private readonly events = new Map<string, EventEnvelope[]>();
  private readonly subscribers = new Map<string, Set<(e: EventEnvelope) => void>>();

  append(envelope: EventEnvelope): void {
    const list = this.events.get(envelope.executionId) ?? [];
    list.push(envelope);
    this.events.set(envelope.executionId, list);
    this.subscribers.get(envelope.executionId)?.forEach((fn) => fn(envelope));
  }

  read(executionId: string): EventEnvelope[] {
    return this.events.get(executionId) ?? [];
  }

  readFrom(executionId: string, fromSequence: number): EventEnvelope[] {
    return this.read(executionId).filter((e) => e.sequence >= fromSequence);
  }

  subscribe(executionId: string, handler: (e: EventEnvelope) => void): () => void {
    const set = this.subscribers.get(executionId) ?? new Set();
    set.add(handler);
    this.subscribers.set(executionId, set);
    return () => set.delete(handler);
  }

  nextSequence(executionId: string): number {
    const list = this.events.get(executionId);
    if (!list || list.length === 0) return 0;
    return (list[list.length - 1]?.sequence ?? -1) + 1;
  }

  close(): void {}
}

export class InMemorySnapshotStore implements SnapshotStore {
  private readonly snapshots = new Map<string, Snapshot[]>();

  save(snapshot: Snapshot): void {
    const list = this.snapshots.get(snapshot.executionId) ?? [];
    list.push(snapshot);
    this.snapshots.set(snapshot.executionId, list);
  }

  loadLatest(executionId: string): Snapshot | null {
    const list = this.snapshots.get(executionId);
    if (!list || list.length === 0) return null;
    return list[list.length - 1] ?? null;
  }

  loadAt(executionId: string, sequence: number): Snapshot | null {
    const list = this.snapshots.get(executionId);
    if (!list) return null;
    const candidates = list.filter((s) => s.sequence <= sequence);
    return candidates[candidates.length - 1] ?? null;
  }

  close(): void {}
}
