import type { EventEnvelope } from "@loom/core";
import {
  type DecoratorPlan,
  type EventStore,
  type OptionalEventStoreMethod,
  type SealMarker,
  type SealingCapability,
  installOptional,
  isKeyUnavailable,
  isReservedStream,
} from "@loom/event-runtime";
import type { OptionalSnapshotStoreMethod, Snapshot, SnapshotStore } from "@loom/snapshot-runtime";
import { UNKNOWN_OWNER_REASON } from "./executionAccessPolicy";
import { assertNotTransientFold } from "./transientFold";
import { ExecutionDeniedError, type ExecutionOp, SealedPayloadUnreadableError } from "./types";

// ── ADR 0130 residuals D7 - the stream-level seal guard ──────────────────────────────────────
//
// A sealing store decorator (the crypto plugin) stamps `metadata.seal` on every envelope in which
// it sealed a field. The kernel checks that marker BEFORE anything is folded, replayed, handed to a
// flow or authorised against, at the one funnel every stored envelope passes through:
// `SealGuardedEventStore`, which `WorkflowRuntime` puts over the configured store. A marker this
// node cannot open (or a key it does not hold) is a refusal that LOOKS LIKE AN ORDINARY DENIAL.

/** The brand `isSealedUnreadable` tests: true for BOTH sealed refusals, which share no base class. */
export const SEALED_UNREADABLE: unique symbol = Symbol.for("loom.sealedUnreadable") as never;

/** Why this node cannot read a stream. Operator-only; never a caller-visible property. */
export interface SealedDetail {
  readonly reason: "marker-unopenable" | "key-unavailable";
  readonly sequence?: number;
  readonly covers?: readonly string[];
  /**
   * The stream's workflow id, read from the PLAINTEXT `EventEnvelope.workflowId` column (or the
   * snapshot index field) that raised the refusal, so the refusal can be worded as the ordinary
   * call of that workflow (an `allowWorkflows` policy must not tell a sealed id from an ordinary one).
   */
  readonly workflowId?: string;
  /** True only when the refusal came from a CHECKPOINT (snapshot state), so `sequence` is its sequence. */
  readonly checkpoint?: true;
}

const details = new WeakMap<object, SealedDetail>();

/**
 * A stream-level refusal: this node cannot open a stream (a marker it cannot open, or a key it does
 * not hold). To the CALLER it is an ordinary unknown-owner denial: an `ExecutionDeniedError` built
 * with {@link UNKNOWN_OWNER_REASON}, `name` NOT overridden, and no extra own property, so it reveals
 * nothing about whether the id exists or is sealed. The true cause is in a module-private WeakMap,
 * read only through `sealedDetailOf` (the `@loom/workflow-runtime/operator` entry).
 */
export class SealedStreamUnreadableError extends ExecutionDeniedError {
  constructor(
    op: ExecutionOp,
    executionId: string,
    detail: SealedDetail,
    /** Caller-visible wording only (see `WorkflowRuntime.sealedOp`); never changes whether it refuses. */
    reason: string = UNKNOWN_OWNER_REASON
  ) {
    super(op, executionId, reason);
    // The parent resets the prototype to its own; restore this class's (name stays the parent's).
    Object.setPrototypeOf(this, SealedStreamUnreadableError.prototype);
    details.set(this, detail);
  }
}

Object.defineProperty(SealedStreamUnreadableError.prototype, SEALED_UNREADABLE, {
  value: true,
  enumerable: false,
});
Object.defineProperty(SealedPayloadUnreadableError.prototype, SEALED_UNREADABLE, {
  value: true,
  enumerable: false,
});

/** True for either sealed refusal (`SealedStreamUnreadableError`, `SealedPayloadUnreadableError`). */
export function isSealedUnreadable(e: unknown): e is Error {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as Record<symbol, unknown>)[SEALED_UNREADABLE] === true
  );
}

/** Operator-only: the real cause behind a {@link SealedStreamUnreadableError}. */
export function sealedDetailOf(err: unknown): SealedDetail | undefined {
  return typeof err === "object" && err !== null ? details.get(err) : undefined;
}

/** Copy the operator detail from one refusal to a re-built one (op rewritten at the public API). */
export function withSealedDetail(
  op: ExecutionOp,
  executionId: string,
  from: SealedStreamUnreadableError,
  reason?: string
): SealedStreamUnreadableError {
  return new SealedStreamUnreadableError(
    op,
    executionId,
    sealedDetailOf(from) ?? { reason: "marker-unopenable" },
    reason
  );
}

/** A plain object with an own string `__loomEnc`: a crypto-plugin ciphertext envelope (O(1)). */
export function isCipherEnvelope(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as { __loomEnc?: unknown }).__loomEnc === "string" &&
    Object.hasOwn(v, "__loomEnc")
  );
}

/** A {@link isCipherEnvelope} whose `__loomEnc` is a KNOWN kernel cipher id (not merely shaped like one). */
export function isKernelCipherEnvelope(v: unknown): boolean {
  return isCipherEnvelope(v) && KNOWN_ENVELOPE_CIPHERS.has((v as { __loomEnc: string }).__loomEnc);
}

/**
 * Defence in depth for the transient quarantine fold (independent of its brand, which a spread copy
 * loses): a real fold's `variables._waitAnswers` never holds a ciphertext envelope (a node that
 * folds it has opened it), so a state that does is a fold past sealed payloads and must not be
 * persisted, whether or not the snapshot store seals (it would store ciphertext as a value).
 * Bounded walk: depth <= 8, 10 000 nodes.
 *
 * Only a KNOWN kernel cipher id ({@link KNOWN_ENVELOPE_CIPHERS}, "loom/aes-256-gcm") counts: user
 * data that is merely `__loomEnc`-shaped with another value saves. Residual (ADR 0130 D9): an app
 * value that carries the kernel cipher id in a wait answer is refused too.
 */
export function assertNoCipherAnswers(state: unknown, where: string): void {
  const answers = (state as { variables?: { _waitAnswers?: unknown } } | null | undefined)
    ?.variables?._waitAnswers;
  if (typeof answers !== "object" || answers === null) return;
  let budget = 10_000;
  const walk = (v: unknown, depth: number): boolean => {
    if (budget-- <= 0 || typeof v !== "object" || v === null) return false;
    if (isKernelCipherEnvelope(v)) return true;
    if (depth >= 8) return false;
    for (const c of Array.isArray(v) ? v : Object.values(v)) if (walk(c, depth + 1)) return true;
    return false;
  };
  if (walk(answers, 0)) {
    throw new Error(
      `a state holding a sealed (ciphertext) wait answer cannot be used for ${where}; it is a fold past sealed payloads and only decides an operator verb`
    );
  }
}

/**
 * ADR 0130 residuals D7, backstop (b): is the recorded principal of this sequence-0 envelope ITSELF
 * a ciphertext envelope (or carry one in its identity / delegation)? A marked stream never reaches
 * here (the guard refused it at the read); this catches an UNMARKED legacy stream sealed by a writer
 * that did not stamp. O(1) on the small record, never a payload walk. A plaintext principal is
 * never refused.
 */
export function principalLooksSealed(first: EventEnvelope | undefined): boolean {
  if (first === undefined) return false;
  const rec = (v: unknown): boolean =>
    isCipherEnvelope(v) ||
    (typeof v === "object" &&
      v !== null &&
      (isCipherEnvelope((v as { identity?: unknown }).identity) ||
        isCipherEnvelope((v as { delegation?: unknown }).delegation)));
  const payload = first.payload as { principal?: unknown } | null | undefined;
  return rec(payload?.principal) || rec(first.metadata?.forkedBy);
}

function markerOf(e: EventEnvelope): SealMarker | undefined | "malformed" {
  const m = e.metadata?.seal;
  if (m === undefined) return undefined;
  const o = m as Partial<SealMarker> | null;
  if (
    typeof o !== "object" ||
    o === null ||
    o.v !== 1 ||
    typeof o.cipher !== "string" ||
    !Array.isArray(o.covers) ||
    !o.covers.every((c) => typeof c === "string")
  ) {
    return "malformed";
  }
  return o as SealMarker;
}

/**
 * ADR 0130 residuals D7 - throw {@link SealedStreamUnreadableError} if any envelope carries a
 * `metadata.seal` marker the store's live capability cannot open. O(1) per envelope (a property
 * read plus a few set lookups for a MARKED one); an UNMARKED envelope makes no claim and is never
 * refused. A reserved control stream (inbox, quarantine, lifecycle) is exempt: its payloads are
 * guarded by the delivery guard (ADR 0130 D2-D4), which parks instead of failing.
 */
export function assertStreamReadable(
  executionId: string,
  events: readonly EventEnvelope[],
  capability: () => SealingCapability | undefined,
  op: ExecutionOp = "query"
): void {
  if (isReservedStream(executionId)) return;
  let cap: SealingCapability | undefined;
  let resolved = false;
  for (const e of events) {
    const marker = markerOf(e);
    if (marker === undefined) continue;
    if (!resolved) {
      cap = capability();
      resolved = true;
    }
    if (marker !== "malformed" && cap?.opens(marker) === true) continue;
    throw new SealedStreamUnreadableError(op, executionId, {
      reason: "marker-unopenable",
      sequence: e.sequence,
      covers: marker === "malformed" ? [] : [...marker.covers],
      workflowId: e.workflowId,
    });
  }
}

// ── User ruling 2026-10-14: the quarantine verbs read PAST sealed payload values ─────────────
//
// The fold copies `MESSAGE_CONSUMED.payload` into `_waitAnswers` and never interprets it; every
// field the inbox / quarantine / park / dedupe / cursor / status fold reads (`waitId`, `topic`,
// `messageId`, `inboxSeq`, `key`, `heldAt`, `operator`, `disposition`, ...) is plaintext. So a marker
// whose `covers` is exactly a subset of `<its own event type>.payload[.…]` on a MESSAGE_CONSUMED
// envelope can be read as an OPAQUE value. Anything else covered (an event type other than
// MESSAGE_CONSUMED, any other path, an empty or malformed marker) is still refused.

/** The event types and payload value path whose sealing the quarantine fold can step over. */
const OPAQUE_OK_TYPE = "MESSAGE_CONSUMED";
const OPAQUE_OK_PATH = `${OPAQUE_OK_TYPE}.payload`;
/** The routing fields the fold interprets: if any is a ciphertext envelope the marker lied. */
const FOLD_READ_FIELDS = ["waitId", "topic", "messageId", "inboxSeq"] as const;

/**
 * The envelope ciphers whose sealed VALUE has the shape the fold copies without reading: a plain
 * object with a string `__loomEnc` (see {@link isCipherEnvelope}). The marker's `cipher` is
 * attacker-influenced metadata, so an unknown cipher is never stepped over: it is the ordinary
 * refusal. Add an id here only for a cipher that seals values as such an opaque envelope.
 */
const KNOWN_ENVELOPE_CIPHERS: ReadonlySet<string> = new Set(["loom/aes-256-gcm"]);

/** May the quarantine fold step over this MARKED envelope without opening it? */
export function opaqueToQuarantineFold(e: EventEnvelope, marker: SealMarker): boolean {
  if (!KNOWN_ENVELOPE_CIPHERS.has(marker.cipher)) return false;
  if (e.eventType !== OPAQUE_OK_TYPE) return false;
  if (marker.covers.length === 0) return false;
  for (const c of marker.covers) {
    if (c !== OPAQUE_OK_PATH && !c.startsWith(`${OPAQUE_OK_PATH}.`)) return false;
  }
  const p = e.payload as Record<string, unknown> | null | undefined;
  if (typeof p !== "object" || p === null) return false;
  return !FOLD_READ_FIELDS.some((f) => isCipherEnvelope(p[f]));
}

/**
 * The narrow, READ-ONLY reader the quarantine verbs get (no append, truncate, subscribe, fence):
 * the only surface the owner-log walks (`classifyTip`, `locatePark`, `findReleaseFact[Back]`, the
 * fold) need. `headOf` / `readRangeOf` accept it as is.
 */
export type QuarantineEventReader = Pick<EventStore, "read" | "readFrom" | "readRange" | "head">;

/**
 * The inner store's AT-REST view (EventStore SPI 2.5.0 `readAtRest`): envelopes exactly as stored,
 * never decrypted. The quarantine view prefers it when every marked envelope of a read is one the
 * opaque rule admits, so the KeyStore is never consulted for an event the rule steps over (a node
 * WITHOUT the key must not even ask). A store without it just falls back to the decrypting read.
 */
function rawReaderOf(store: EventStore): QuarantineEventReader | undefined {
  return store.readAtRest?.();
}

/** Event arrays the view returned with sealed values LEFT in place (never decrypted). */
const leftOpaque = new WeakSet<object>();

/** True iff `events` came from the quarantine view with at least one sealed value left in place. */
export function readLeftOpaque(events: readonly EventEnvelope[]): boolean {
  return leftOpaque.has(events);
}

/**
 * May a RAW (undecrypted) read be used as is? Every marked envelope must be one the opaque rule
 * steps over, and no unmarked envelope may carry a ciphertext envelope as a top-level payload field
 * (a pre-marker legacy row the decrypting store would have opened). O(events) property reads.
 *
 * Only TOP-LEVEL payload fields of an UNMARKED legacy row are inspected: a nested sealed path in
 * such a row passes through as ciphertext, and the verb then decides on the ciphertext (it cannot
 * read it, which is a refusal or a step-over, never a leak).
 */
function rawReadAdmissible(events: readonly EventEnvelope[]): boolean {
  let anyMarked = false;
  for (const e of events) {
    const marker = markerOf(e);
    if (marker === undefined) {
      const p = e.payload as Record<string, unknown> | null | undefined;
      if (typeof p === "object" && p !== null) {
        for (const k of Object.keys(p)) if (isCipherEnvelope(p[k])) return false;
      }
      continue;
    }
    if (marker === "malformed" || !opaqueToQuarantineFold(e, marker)) return false;
    anyMarked = true;
  }
  return anyMarked; // nothing marked: the ordinary (decrypting) read is the right one
}

/**
 * Like {@link assertStreamReadable}, except a marked envelope that {@link opaqueToQuarantineFold}
 * admits is left in place as an opaque ciphertext value (never decrypted, never tried). Only the
 * quarantine verbs' read view calls this.
 */
function assertStreamReadableOpaque(
  executionId: string,
  events: readonly EventEnvelope[],
  capability: () => SealingCapability | undefined
): void {
  if (isReservedStream(executionId)) return;
  let stepped = false;
  let cap: SealingCapability | undefined;
  let resolved = false;
  for (const e of events) {
    const marker = markerOf(e);
    if (marker === undefined) continue;
    if (!resolved) {
      cap = capability();
      resolved = true;
    }
    if (marker !== "malformed") {
      if (cap?.opens(marker) === true) continue;
      if (opaqueToQuarantineFold(e, marker)) {
        stepped = true;
        continue;
      }
    }
    throw new SealedStreamUnreadableError("query", executionId, {
      reason: "marker-unopenable",
      sequence: e.sequence,
      covers: marker === "malformed" ? [] : [...marker.covers],
      workflowId: e.workflowId,
    });
  }
  if (stepped) leftOpaque.add(events);
}

/** Translate a crypto store's `KeyUnavailableError` into the denial-shaped refusal; rethrow anything else. */
function translate(executionId: string, err: unknown): never {
  if (isKeyUnavailable(err)) {
    const workflowId = (err as { workflowId?: unknown }).workflowId;
    throw new SealedStreamUnreadableError("query", executionId, {
      reason: "key-unavailable",
      ...(typeof workflowId === "string" && workflowId !== "" && { workflowId }),
    });
  }
  throw err;
}

type GuardedPlan = DecoratorPlan<EventStore, OptionalEventStoreMethod>;

/**
 * The runtime's guarded view of the configured event store: every read that can reach the fold, the
 * replay VM, an authorization decision or a flow passes {@link assertStreamReadable}, and a
 * `KeyUnavailableError` becomes the denial-shaped refusal. Writes and tip queries are forwarded
 * untouched (a tip is a sequence number, not a payload). A live subscription never delivers an
 * envelope this node cannot open.
 */
export class SealGuardedEventStore implements EventStore {
  readonly appendBatch?: NonNullable<EventStore["appendBatch"]>;
  readonly head?: NonNullable<EventStore["head"]>;
  readonly readRange?: NonNullable<EventStore["readRange"]>;
  readonly acquireFence?: NonNullable<EventStore["acquireFence"]>;
  readonly acquireFenceIf?: NonNullable<EventStore["acquireFenceIf"]>;
  readonly appendIfUnchanged?: NonNullable<EventStore["appendIfUnchanged"]>;
  readonly storeNow?: NonNullable<EventStore["storeNow"]>;
  readonly sealingCapability?: NonNullable<EventStore["sealingCapability"]>;
  readonly copyPrefix?: NonNullable<EventStore["copyPrefix"]>;
  readonly deleteExecution?: NonNullable<EventStore["deleteExecution"]>;
  readonly truncatePrefix?: NonNullable<EventStore["truncatePrefix"]>;
  readonly truncatePrefixKeeping?: NonNullable<EventStore["truncatePrefixKeeping"]>;
  readonly listExecutions?: NonNullable<EventStore["listExecutions"]>;
  readonly listExecutionsPage?: NonNullable<EventStore["listExecutionsPage"]>;

  constructor(readonly inner: EventStore) {
    const plan = {
      appendBatch: "forward",
      head: "forward",
      readRange: (executionId: string, from: number, to: number) =>
        this.readVia(executionId, (s) => s.readRange!(executionId, from, to)),
      acquireFence: "forward",
      acquireFenceIf: "forward",
      appendIfUnchanged: "forward",
      storeNow: "forward",
      sealingCapability: "forward",
      // REFUSED (ADR 0130 D9): the at-rest view is ciphertext as stored and reading it is a way past the
      // seal guard (D7). Only the quarantine view's own reads reach it, via `this.inner`, never through here.
      readAtRest: {
        refuse:
          "the guarded view never hands out the at-rest (unguarded) reads; the quarantine view reads them from its inner store",
      },
      copyPrefix: "forward", // copies the stored bytes verbatim in the inner store: nothing is read here
      deleteExecution: "forward",
      deleteThrough: "forward",
      truncatePrefix: "forward",
      truncatePrefixKeeping: "forward",
      listExecutions: "forward",
      listExecutionsPage: "forward",
    } satisfies GuardedPlan;
    installOptional<EventStore, OptionalEventStoreMethod>(this, inner, plan);
  }

  private async guarded(
    executionId: string,
    read: Promise<EventEnvelope[]>
  ): Promise<EventEnvelope[]> {
    let events: EventEnvelope[];
    try {
      events = await read;
    } catch (err) {
      return translate(executionId, err);
    }
    this.check(executionId, events);
    return events;
  }

  /** How a read reaches the store; the quarantine view overrides it (and the check) only. */
  protected readVia(
    executionId: string,
    op: (s: EventStore) => Promise<EventEnvelope[]>
  ): Promise<EventEnvelope[]> {
    return this.guarded(executionId, op(this.inner));
  }

  /** The seal check every read passes; the quarantine view overrides it (and only it). */
  protected check(executionId: string, events: readonly EventEnvelope[]): void {
    assertStreamReadable(executionId, events, () => this.inner.sealingCapability?.());
  }

  /**
   * The view the quarantine verbs (and only they) read an owner's log through: it steps
   * over a marker {@link opaqueToQuarantineFold} admits and refuses every other exactly as the
   * guard does. The one place the bypass is reachable; `quarantineReadsFor` in `WorkflowRuntime`
   * is its only caller (pinned by `sealGuardFitness.test.ts`).
   */
  quarantineReadView(): QuarantineEventReader {
    const view = new OpaqueQuarantineEventStore(this.inner);
    // Narrow on purpose: the verbs' walks can read and nothing else (no append, truncate, subscribe).
    const narrow: {
      -readonly [K in keyof QuarantineEventReader]: QuarantineEventReader[K];
    } = {
      read: (id) => view.read(id),
      readFrom: (id, from) => view.readFrom(id, from),
    };
    if (view.readRange !== undefined) narrow.readRange = (id, a, b) => view.readRange!(id, a, b);
    if (view.head !== undefined) narrow.head = (id) => view.head!(id);
    return narrow;
  }

  append(envelope: EventEnvelope): Promise<void> {
    return this.inner.append(envelope);
  }

  read(executionId: string): Promise<EventEnvelope[]> {
    return this.readVia(executionId, (s) => s.read(executionId));
  }

  readFrom(executionId: string, fromSequence: number): Promise<EventEnvelope[]> {
    return this.readVia(executionId, (s) => s.readFrom(executionId, fromSequence));
  }

  subscribe(executionId: string, handler: (event: EventEnvelope) => void): Promise<() => void> {
    return this.inner.subscribe(executionId, (event) => {
      try {
        this.check(executionId, [event]);
      } catch {
        return; // never hand a subscriber an envelope this node cannot open
      }
      handler(event);
    });
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

/**
 * The quarantine verbs' view of the event store (see {@link SealGuardedEventStore.quarantineReadView}):
 * the same guarded decorator except that a marker {@link opaqueToQuarantineFold} admits is left in
 * place as an opaque ciphertext value. Exported for the decorator conformance kit only (not on the package
 * entry); `quarantineReadView` is its one production constructor, reached via `quarantineReadsFor`.
 */
export class OpaqueQuarantineEventStore extends SealGuardedEventStore {
  /**
   * Prefer the RAW envelopes beneath a sealing decorator when every marked one is stepped over: no
   * key is asked for them. Otherwise (a marked envelope the rule does not admit, or no raw reader)
   * the ordinary decrypting read runs, under the opaque check.
   */
  protected override async readVia(
    executionId: string,
    op: (s: EventStore) => Promise<EventEnvelope[]>
  ): Promise<EventEnvelope[]> {
    const raw = isReservedStream(executionId) ? undefined : rawReaderOf(this.inner);
    if (raw !== undefined) {
      const events = await op(raw as EventStore);
      if (rawReadAdmissible(events)) {
        leftOpaque.add(events);
        return events;
      }
    }
    const events = await super.readVia(executionId, op);
    return events;
  }

  protected override check(executionId: string, events: readonly EventEnvelope[]): void {
    assertStreamReadableOpaque(executionId, events, () => this.inner.sealingCapability?.());
  }
}

type SnapshotPlan = DecoratorPlan<SnapshotStore, OptionalSnapshotStoreMethod>;

/**
 * The runtime's guarded view of the snapshot store: a snapshot whose state is itself a sealed
 * envelope (top-level `__loomEnc`, a whole-state-sealing store read by a node that did not open it)
 * is refused instead of seeding a fold with ciphertext, and a `KeyUnavailableError` becomes the
 * denial-shaped refusal. `probe` runs first on a key-unavailable load: a snapshot taken BEFORE a
 * real shred cannot record it, so the log's own answer (`PayloadShreddedError` for a tombstone) wins.
 */
export class SealGuardedSnapshotStore implements SnapshotStore {
  readonly deleteExecution?: NonNullable<SnapshotStore["deleteExecution"]>;
  readonly loadLatestSealed?: NonNullable<SnapshotStore["loadLatestSealed"]>;
  readonly pruneSnapshots?: NonNullable<SnapshotStore["pruneSnapshots"]>;

  constructor(
    readonly inner: SnapshotStore,
    private readonly probe: (executionId: string) => Promise<void>
  ) {
    const plan = {
      deleteExecution: "forward",
      loadLatestSealed: "forward",
      // ADR 0134 — a range delete reads and returns no state, so there is nothing to guard.
      pruneSnapshots: "forward",
    } satisfies SnapshotPlan;
    installOptional<SnapshotStore, OptionalSnapshotStoreMethod>(this, inner, plan);
  }

  private saveGuard?: (snapshot: Snapshot, store: SnapshotStore) => void;

  /**
   * ADR 0130 D8: run `guard` before EVERY save with the store the save goes to. It throws
   * `PlaintextCheckpointError` when the event store seals and the checkpoint would not be sealed;
   * the callers' best-effort checkpoint `catch` surfaces it as `onStorageError`.
   */
  guardSaves(guard: (snapshot: Snapshot, store: SnapshotStore) => void): void {
    this.saveGuard = guard;
  }

  private async check(
    executionId: string,
    load: Promise<Snapshot | null>
  ): Promise<Snapshot | null> {
    let snapshot: Snapshot | null;
    try {
      snapshot = await load;
    } catch (err) {
      if (isKeyUnavailable(err)) {
        await this.probe(executionId); // a real shred surfaces its own (erasure) error here
        return translate(executionId, err);
      }
      throw err;
    }
    if (snapshot !== null && isCipherEnvelope(snapshot.state)) {
      throw new SealedStreamUnreadableError("query", executionId, {
        reason: "marker-unopenable",
        sequence: snapshot.sequence,
        covers: [],
        workflowId: snapshot.workflowId,
        checkpoint: true,
      });
    }
    return snapshot;
  }

  async save(snapshot: Snapshot): Promise<void> {
    assertNotTransientFold(snapshot.state, "a snapshot");
    assertNoCipherAnswers(snapshot.state, "a snapshot");
    this.saveGuard?.(snapshot, this.inner);
    return this.inner.save(snapshot);
  }
  loadLatest(executionId: string): Promise<Snapshot | null> {
    return this.check(executionId, this.inner.loadLatest(executionId));
  }
  loadAt(executionId: string, sequence: number): Promise<Snapshot | null> {
    return this.check(executionId, this.inner.loadAt(executionId, sequence));
  }
  loadLatestBefore(executionId: string, sequence: number): Promise<Snapshot | null> {
    return this.check(executionId, this.inner.loadLatestBefore(executionId, sequence));
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}
