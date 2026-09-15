import type { ExecutionState } from "@loom/core";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";
import { decryptValue, encryptValue, hasEnvelope, mapPaths } from "./crypto";
import { PayloadShreddedError } from "./errors";
import type { KeyStore } from "./keystore";

export interface EncryptingSnapshotStoreOptions {
  /**
   * Sensitive dot-paths into the folded `ExecutionState` (typically under
   * `variables`, e.g. `["variables._input.ssn"]`). Snapshots fold plaintext, so
   * WITHOUT this a shredded execution's secret survives in its snapshot — the
   * A1 "erasure theater" hole. These are encrypted under the SAME subject key as
   * the events, so destroying the key erases both.
   */
  sensitive: readonly string[];
  /** The erasure subject for a snapshot; default the executionId (matches the event store). */
  subjectOf?: (snapshot: Pick<Snapshot, "executionId" | "workflowId">) => string;
}

/**
 * K10.2 / A1 — wraps any {@link SnapshotStore} so the SAME sensitive fields that
 * are crypto-shredded in the event log are also encrypted in the folded
 * snapshot state. Without this, replay-from-snapshot of a shredded execution
 * would silently succeed with the erased data (and compaction would
 * institutionalize it). A load whose key was destroyed throws
 * {@link PayloadShreddedError} — the same loud failure as the event store.
 */
export class EncryptingSnapshotStore implements SnapshotStore {
  private readonly sensitive: readonly string[];
  private readonly subjectOf: (s: Pick<Snapshot, "executionId" | "workflowId">) => string;

  constructor(
    private readonly inner: SnapshotStore,
    /**
     * PUBLIC so a pre-flight check can ask whether these keys outlive the process — see
     * `KeyStore.durable`. `loom doctor` looks for this property structurally, which is how it
     * checks an encrypting store without depending on @loom/plugin-crypto.
     */
    readonly keys: KeyStore,
    options: EncryptingSnapshotStoreOptions
  ) {
    this.sensitive = options.sensitive;
    this.subjectOf = options.subjectOf ?? ((s) => s.executionId);
  }

  async save(snapshot: Snapshot): Promise<void> {
    if (this.sensitive.length === 0) return this.inner.save(snapshot);
    const key = await this.keys.getOrCreate(this.subjectOf(snapshot));
    const state = mapPaths(snapshot.state, this.sensitive, (v) => encryptValue(key, v));
    return this.inner.save({ ...snapshot, state: state as ExecutionState });
  }

  private async decrypt(snapshot: Snapshot | null): Promise<Snapshot | null> {
    if (snapshot === null || !hasEnvelope(snapshot.state)) return snapshot;
    const subjectId = this.subjectOf(snapshot);
    const key = await this.keys.get(subjectId);
    if (key === null) throw new PayloadShreddedError(subjectId, snapshot.executionId);
    const state = mapPaths(snapshot.state, this.sensitive, (v) => decryptValue(key, v));
    return { ...snapshot, state: state as ExecutionState };
  }

  async loadLatest(executionId: string): Promise<Snapshot | null> {
    return this.decrypt(await this.inner.loadLatest(executionId));
  }

  async loadAt(executionId: string, sequence: number): Promise<Snapshot | null> {
    return this.decrypt(await this.inner.loadAt(executionId, sequence));
  }

  async loadLatestBefore(executionId: string, sequence: number): Promise<Snapshot | null> {
    return this.decrypt(await this.inner.loadLatestBefore(executionId, sequence));
  }

  async close(): Promise<void> {
    return this.inner.close();
  }
}
