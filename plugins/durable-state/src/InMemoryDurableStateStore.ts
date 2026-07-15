import { RevisionConflictError } from "./errors";
import type { DurableStateRecord, DurableStateStore } from "./types";

/**
 * Reference in-memory backend — the conformance baseline, and the test/dev
 * default. Deep-clones on both write and read so callers can never alias the
 * stored record (matching the value semantics of the durable backends, where
 * a JSON round-trip breaks aliasing anyway).
 */
export class InMemoryDurableStateStore implements DurableStateStore {
  private readonly records = new Map<string, DurableStateRecord>();

  async load(key: string): Promise<DurableStateRecord | null> {
    const record = this.records.get(key);
    return record === undefined ? null : structuredClone(record);
  }

  async save(
    key: string,
    value: { contractVersion: number; payload: unknown },
    expectedRevision: number
  ): Promise<DurableStateRecord> {
    const actual = this.records.get(key)?.revision ?? 0;
    if (expectedRevision !== actual) {
      throw new RevisionConflictError(key, expectedRevision, actual);
    }
    const record: DurableStateRecord = {
      contractVersion: value.contractVersion,
      revision: actual + 1,
      payload: structuredClone(value.payload),
    };
    this.records.set(key, record);
    return structuredClone(record);
  }

  async clear(key: string): Promise<void> {
    this.records.delete(key);
  }
}
