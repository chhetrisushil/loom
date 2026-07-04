import type { EventEnvelope } from "@loom/core";

export type { EventEnvelope };

export interface EventStore {
  append(envelope: EventEnvelope): void;
  read(executionId: string): EventEnvelope[];
  readFrom(executionId: string, fromSequence: number): EventEnvelope[];
  subscribe(executionId: string, handler: (event: EventEnvelope) => void): () => void;
  nextSequence(executionId: string): number;
  close(): void;
}

export interface EventStoreOptions {
  dbPath: string;
}
