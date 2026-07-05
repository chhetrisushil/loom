import type { EventEnvelope } from "@loom/core";
import type { EventStore } from "@loom/event-runtime";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";

// Browser-safe, in-memory implementations of the durable stores. In a Node
// deployment these become SqliteEventStore / SqliteSnapshotStore with no other
// code changes — the WorkflowRuntime only depends on the interfaces.

export class InMemoryEventStore implements EventStore {
  private readonly events = new Map<string, EventEnvelope[]>();
  private readonly subscribers = new Map<string, Set<(e: EventEnvelope) => void>>();

  async append(envelope: EventEnvelope): Promise<void> {
    const list = this.events.get(envelope.executionId) ?? [];
    list.push(envelope);
    this.events.set(envelope.executionId, list);
    this.subscribers.get(envelope.executionId)?.forEach((fn) => fn(envelope));
  }

  async read(executionId: string): Promise<EventEnvelope[]> {
    return this.events.get(executionId) ?? [];
  }

  async readFrom(executionId: string, fromSequence: number): Promise<EventEnvelope[]> {
    return (await this.read(executionId)).filter((e) => e.sequence >= fromSequence);
  }

  async subscribe(executionId: string, handler: (e: EventEnvelope) => void): Promise<() => void> {
    const set = this.subscribers.get(executionId) ?? new Set();
    set.add(handler);
    this.subscribers.set(executionId, set);
    return () => set.delete(handler);
  }

  async close(): Promise<void> {}
}

export class InMemorySnapshotStore implements SnapshotStore {
  private readonly snapshots = new Map<string, Snapshot[]>();

  async save(snapshot: Snapshot): Promise<void> {
    const list = this.snapshots.get(snapshot.executionId) ?? [];
    list.push(snapshot);
    this.snapshots.set(snapshot.executionId, list);
  }

  async loadLatest(executionId: string): Promise<Snapshot | null> {
    const list = this.snapshots.get(executionId);
    if (!list || list.length === 0) return null;
    return list[list.length - 1] ?? null;
  }

  async loadAt(executionId: string, sequence: number): Promise<Snapshot | null> {
    const list = this.snapshots.get(executionId);
    if (!list) return null;
    const candidates = list.filter((s) => s.sequence <= sequence);
    return candidates[candidates.length - 1] ?? null;
  }

  async loadLatestBefore(executionId: string, sequence: number): Promise<Snapshot | null> {
    return this.loadAt(executionId, sequence);
  }

  async close(): Promise<void> {}
}
