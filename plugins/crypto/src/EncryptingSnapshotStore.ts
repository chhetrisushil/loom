import type { ExecutionState } from "@loom/core";
import {
  type DecoratorPlan,
  type EventStore,
  KeyUnavailableError,
  installOptional,
} from "@loom/event-runtime";
import type { OptionalSnapshotStoreMethod, Snapshot, SnapshotStore } from "@loom/snapshot-runtime";
import {
  type IvSource,
  assertIvSourceAllowed,
  decryptValue,
  encryptValue,
  envelopeAad,
  hasEnvelope,
  mapPaths,
} from "./crypto";
import {
  PayloadShreddedError,
  PlaintextSnapshotRefusedError,
  SnapshotUndecryptableError,
} from "./errors";
import type { KeyStore } from "./keystore";
import { recordsShred } from "./shred";
import { SNAP_AAD_V, isWholeStateEnvelope, slotOf } from "./snapshotSeal";

/**
 * Legacy opening (a snapshot written by a static-path store). In sealState mode the previous
 * configuration's paths are unknown, so every envelope-shaped value is a candidate; a value that
 * does not open under the subject key (an application's own ciphertext under another key) is left
 * exactly as stored rather than failing the load with a raw GCM error. Residual, stated: an
 * application value sealed with this same subject key by the same helper IS opened. Naming the
 * old paths with `legacySensitive` removes that residual (only those paths are opened).
 */
function openAll(v: unknown, key: Buffer): unknown {
  if (isWholeStateEnvelope(v)) {
    try {
      return decryptValue(key, v);
    } catch {
      return v;
    }
  }
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
   * `sealState` only. What to do with a loaded state that is NOT a whole-state envelope
   * (a pre-sealState plaintext or static-path snapshot, or one swapped in by someone with write
   * access to the snapshot table): `"load"` (default, ADR 0130 D8 keeps old snapshots readable)
   * returns it; `"refuse"` throws {@link PlaintextSnapshotRefusedError}. Use `"refuse"` once
   * nothing legacy remains at rest, so a plaintext row cannot be substituted for a sealed one.
   */
  legacyPlaintext?: "load" | "refuse";
  /**
   * `sealState` only. The dot-paths a previous static-path configuration sealed. When given,
   * legacy snapshots open ONLY those paths (any other envelope-shaped value is left as stored);
   * when absent, every envelope-shaped value is tried and left as stored if it does not open.
   */
  legacySensitive?: readonly string[];
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
  /**
   * Deterministic cipher seam (ADR 0130 residuals D7, simulation only): see
   * `EncryptingEventStoreOptions.ivSource`. Build one with `seededIvSource` from
   * `@loom/plugin-crypto/testing`. Allowed only under `NODE_ENV=test` or `VITEST` (fail closed).
   */
  ivSource?: IvSource;
  /**
   * The RAW event store beside this snapshot store. When a subject's key is gone, the log decides
   * whether it was a real shred (a `PAYLOAD_SHREDDED` tombstone, which always sits ABOVE the latest
   * snapshot) or this node merely lacks the key (`KeyUnavailableError`, ADR 0130 residuals D7).
   * Optional: without it only a shred folded into the snapshot is recognised, any other absent key
   * reads as `KeyUnavailableError` (a denial in the kernel, whose own probe reads the log and
   * surfaces a real shred as `PayloadShreddedError`). A caller outside the kernel that needs the
   * exact error (the content GC, a tool reading snapshots directly) passes it.
   */
  events?: EventStore;
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
  readonly pruneSnapshots?: NonNullable<SnapshotStore["pruneSnapshots"]>;
  /**
   * ADR 0130 D8 — structural marker: the WHOLE folded state is sealed (not just static paths).
   * A plain property so neither `loom doctor` nor the kernel depends on @loom/plugin-crypto.
   * Absent (not `false`) in static-path mode.
   */
  readonly sealsWholeState?: true;
  private sensitive: readonly string[];
  private readonly legacyPlaintext: "load" | "refuse";
  private readonly legacySensitive: readonly string[] | undefined;
  private readonly subjectOf: (s: Pick<Snapshot, "executionId" | "workflowId">) => string;
  private readonly ivSource: IvSource | undefined;
  private readonly events: EventStore | undefined;

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
    } else if (options.legacyPlaintext !== undefined || options.legacySensitive !== undefined) {
      throw new TypeError(
        "EncryptingSnapshotStore: `legacyPlaintext` and `legacySensitive` only apply with `sealState: true`."
      );
    }
    if (options.sealState !== true && options.sensitive === undefined) {
      throw new TypeError(
        "EncryptingSnapshotStore: pass `sealState: true` (recommended) or a `sensitive` path list."
      );
    }
    this.sensitive = [...(options.sensitive ?? [])];
    this.legacyPlaintext = options.legacyPlaintext ?? "load";
    this.legacySensitive = options.legacySensitive;
    this.subjectOf = options.subjectOf ?? ((s) => s.executionId);
    assertIvSourceAllowed(options.ivSource, "EncryptingSnapshotStore");
    this.ivSource = options.ivSource;
    this.events = options.events;
    const plan = {
      // Deleting ciphertext only reduces data — and without it a retention sweep over an
      // encrypted snapshot store orphaned every snapshot it should have removed.
      deleteExecution: "forward",
      // ADR 0134 — a range delete over ciphertext rows: no key is read, no plaintext produced.
      pruneSnapshots: "forward",
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
      const sealed = encryptValue(
        key,
        snapshot.state,
        { v: SNAP_AAD_V, bind: slotOf(snapshot) },
        this.ivSource?.({
          streamId: snapshot.executionId,
          sequence: snapshot.sequence,
          path: "state",
        })
      );
      return this.inner.save({ ...snapshot, state: sealed as never });
    }
    let n = 0;
    const state = mapPaths(snapshot.state, this.sensitive, (v) =>
      encryptValue(
        key,
        v,
        undefined,
        this.ivSource?.({
          streamId: snapshot.executionId,
          sequence: snapshot.sequence,
          path: `state#${n++}`,
        })
      )
    );
    return this.inner.save({ ...snapshot, state: state as ExecutionState });
  }

  private async decrypt(snapshot: Snapshot | null): Promise<Snapshot | null> {
    if (snapshot === null) return snapshot;
    if (
      this.sealsWholeState === true &&
      this.legacyPlaintext === "refuse" &&
      !isWholeStateEnvelope(snapshot.state)
    ) {
      throw new PlaintextSnapshotRefusedError(snapshot.executionId, snapshot.sequence);
    }
    if (!hasEnvelope(snapshot.state)) return snapshot;
    const subjectId = this.subjectOf(snapshot);
    const key = await this.keys.get(subjectId);
    if (key === null) throw await this.keyGone(snapshot, subjectId);
    // A whole-state envelope is opened by EITHER mode (same keys): a store switched back to
    // static paths must not hand the kernel a half-state. It is bound to its slot (executionId +
    // sequence), and an envelope WITHOUT the binding marker is refused, never opened bare.
    if (isWholeStateEnvelope(snapshot.state)) {
      try {
        if (envelopeAad(snapshot.state) !== SNAP_AAD_V) throw new Error("missing AAD binding");
        return {
          ...snapshot,
          state: decryptValue(key, snapshot.state, slotOf(snapshot)) as ExecutionState,
        };
      } catch (err) {
        throw new SnapshotUndecryptableError(
          subjectId,
          snapshot.executionId,
          snapshot.sequence,
          err
        );
      }
    }
    // A snapshot written by a static-path store has no whole-state envelope.
    let state: unknown;
    if (this.sealsWholeState !== true) {
      state = mapPaths(snapshot.state, this.sensitive, (v) => decryptValue(key, v));
    } else if (this.legacySensitive !== undefined) {
      state = mapPaths(snapshot.state, this.legacySensitive, (v) => openAll(v, key));
    } else {
      state = openAll(snapshot.state, key);
    }
    return { ...snapshot, state: state as ExecutionState };
  }

  /**
   * ADR 0130 residuals D7. Key gone is a real shred only when it can be PROVED: the folded state
   * records it (compaction folds the tombstone in), or the log holds a `PAYLOAD_SHREDDED` tombstone
   * (needs `events`). Otherwise it is `KeyUnavailableError` (this node cannot open it), which the
   * kernel turns into the generic denial: a merely-absent key must never read as an erasure of a
   * LIVE execution. Without `events` this store cannot see a tombstone ABOVE the snapshot, so a
   * snapshot taken before a real shred reads as key-unavailable here; the kernel's own probe reads
   * the whole log first and surfaces the real `PayloadShreddedError` (and the content GC accepts
   * either error, but only beside the execution's own tombstone). `events` is an optimisation that
   * lets a caller without that probe get the exact error.
   *
   * Cost: with `events`, each key-unavailable read does a full `events.read` of the stream. It is
   * bounded by the kernel's back-off on a refused stream; there is deliberately no cache.
   */
  private async keyGone(snapshot: Snapshot, subjectId: string): Promise<Error> {
    if (
      recordsShred(snapshot.state, subjectId) ||
      (await this.logRecordsShred(snapshot.executionId, subjectId))
    ) {
      return new PayloadShreddedError(subjectId, snapshot.executionId);
    }
    return new KeyUnavailableError(subjectId, snapshot.executionId, snapshot.workflowId);
  }

  private async logRecordsShred(executionId: string, subjectId: string): Promise<boolean> {
    if (this.events === undefined) return false;
    return (await this.events.read(executionId)).some(
      (e) =>
        e.eventType === "PAYLOAD_SHREDDED" &&
        (e.payload as { subjectId?: unknown } | null)?.subjectId === subjectId
    );
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
