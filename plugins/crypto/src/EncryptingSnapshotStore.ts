import type { ExecutionState } from "@loom/core";
import { type DecoratorPlan, installOptional } from "@loom/event-runtime";
import type { OptionalSnapshotStoreMethod, Snapshot, SnapshotStore } from "@loom/snapshot-runtime";
import { decryptValue, encryptValue, hasEnvelope, mapPaths } from "./crypto";
import { PayloadShreddedError } from "./errors";
import type { KeyStore } from "./keystore";

function isWholeStateEnvelope(state: unknown): boolean {
  return typeof state === "object" && state !== null && "__loomEnc" in state;
}

function openAll(v: unknown, key: Buffer): unknown {
  if (isWholeStateEnvelope(v)) return decryptValue(key, v);
  if (Array.isArray(v)) return v.map((x) => openAll(x, key));
  if (typeof v === "object" && v !== null) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, openAll(x, key)]));
  }
  return v;
}

export interface EncryptingSnapshotStoreOptions {
  /**
   * ADR 0130 D8 — seal the WHOLE folded state as ONE envelope under the subject key (so a shred
   * erases it with the events). The only mode that covers the dynamic
   * `variables._waitAnswers.<waitId>` keys, which no static path can name. Stored as
   * `{ id, executionId, workflowId, sequence, createdAt, state: { __loomEnc… } }`: the index
   * fields stay in the clear (none is payload). Mutually exclusive with {@link sensitive}.
   *
   * A snapshot written without it (plaintext or static-path) still loads, and is re-sealed by
   * the next `save`; snapshots already at rest are never rewritten. The store exposes the
   * structural marker `sealsWholeState: true`, read by `loom doctor` (and the kernel).
   */
  sealState?: true;
  /**
   * Sensitive dot-paths into the folded `ExecutionState` (typically under
   * `variables`, e.g. `["variables._input.ssn"]`). Snapshots fold plaintext, so
   * WITHOUT this a shredded execution's secret survives in its snapshot — the
   * A1 "erasure theater" hole. These are encrypted under the SAME subject key as
   * the events, so destroying the key erases both.
   */
  sensitive?: readonly string[];
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
  readonly deleteExecution?: NonNullable<SnapshotStore["deleteExecution"]>;
  /**
   * ADR 0130 D8 — structural marker: the WHOLE folded state is sealed (not just static paths).
   * A plain property so neither `loom doctor` nor the kernel depends on @loom/plugin-crypto.
   * Absent (not `false`) in static-path mode.
   */
  readonly sealsWholeState?: true;
  private sensitive: readonly string[];
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
    if (options.sealState === true) {
      if (options.sensitive !== undefined) {
        throw new TypeError(
          "EncryptingSnapshotStore: `sealState` and `sensitive` are mutually exclusive. `sealState` seals the whole folded state (including the dynamic _waitAnswers keys); drop `sensitive`."
        );
      }
      this.sealsWholeState = true;
    } else if (options.sensitive === undefined) {
      throw new TypeError(
        "EncryptingSnapshotStore: pass `sealState: true` (recommended) or a `sensitive` path list."
      );
    }
    this.sensitive = [...(options.sensitive ?? [])];
    this.subjectOf = options.subjectOf ?? ((s) => s.executionId);
    const plan = {
      // Deleting ciphertext only reduces data — and without it a retention sweep over an
      // encrypted snapshot store orphaned every snapshot it should have removed.
      deleteExecution: "forward",
    } satisfies DecoratorPlan<
      SnapshotStore,
      Exclude<OptionalSnapshotStoreMethod, "loadLatestSealed">
    >;
    // `loadLatestSealed` is this class's own method (below), offered whatever the inner has:
    // sealing at rest is exactly what this decorator adds.
    installOptional<SnapshotStore, Exclude<OptionalSnapshotStoreMethod, "loadLatestSealed">>(
      this,
      inner,
      plan
    );
  }

  /**
   * R3k (ADR 0111 D1) — add sensitive dot-paths into the folded state AFTER construction
   * (union). The fold carries the recorded principal at `variables._principal`, so `defineConfig`
   * registers `variables._principal.identity.*` here alongside the event store's
   * `principal.identity.*`: a snapshot must not keep the identity a shredded log no longer has.
   */
  registerSensitive(paths: readonly string[]): void {
    if (this.sealsWholeState === true) return; // the whole state is already sealed
    this.sensitive = [...new Set([...this.sensitive, ...paths])];
  }

  async save(snapshot: Snapshot): Promise<void> {
    if (this.sealsWholeState !== true && this.sensitive.length === 0) {
      return this.inner.save(snapshot);
    }
    const subject = this.subjectOf(snapshot);
    if (subject === "") {
      // As EncryptingEventStore: every such snapshot would share one guessable key that erasing the
      // real subject misses. Refuse rather than seal.
      throw new TypeError(
        `EncryptingSnapshotStore: the subject for "${snapshot.executionId}" resolved to "" and the crypto layer refuses to seal under it. Fix \`subjectOf\`.`
      );
    }
    const key = await this.keys.getOrCreate(subject);
    if (this.sealsWholeState === true) {
      return this.inner.save({ ...snapshot, state: encryptValue(key, snapshot.state) as never });
    }
    const state = mapPaths(snapshot.state, this.sensitive, (v) => encryptValue(key, v));
    return this.inner.save({ ...snapshot, state: state as ExecutionState });
  }

  private async decrypt(snapshot: Snapshot | null): Promise<Snapshot | null> {
    if (snapshot === null || !hasEnvelope(snapshot.state)) return snapshot;
    const subjectId = this.subjectOf(snapshot);
    const key = await this.keys.get(subjectId);
    if (key === null) throw new PayloadShreddedError(subjectId, snapshot.executionId);
    // A whole-state envelope is opened by EITHER mode (same keys): a store switched back to
    // static paths must not hand the kernel a half-state.
    if (isWholeStateEnvelope(snapshot.state)) {
      return { ...snapshot, state: decryptValue(key, snapshot.state) as ExecutionState };
    }
    // A snapshot written by a static-path store has no whole-state envelope; its paths are not
    // ours to know in sealState mode, so open every nested envelope instead.
    const state =
      this.sealsWholeState === true
        ? openAll(snapshot.state, key)
        : mapPaths(snapshot.state, this.sensitive, (v) => decryptValue(key, v));
    return { ...snapshot, state: state as ExecutionState };
  }

  async loadLatest(executionId: string): Promise<Snapshot | null> {
    return this.decrypt(await this.inner.loadLatest(executionId));
  }

  /**
   * ADR 0106 (SnapshotStore SPI 1.1.0) — the latest snapshot as stored at rest: sensitive
   * fields stay ciphertext envelopes, nothing is decrypted, so it answers after the subject's
   * key is destroyed. `shredSubject`'s retry reads the sequence and `variables._shredded`
   * (never a sensitive path) from it.
   */
  async loadLatestSealed(executionId: string): Promise<Snapshot | null> {
    return this.inner.loadLatestSealed !== undefined
      ? this.inner.loadLatestSealed(executionId)
      : this.inner.loadLatest(executionId);
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
