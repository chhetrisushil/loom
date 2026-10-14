import type { EventEnvelope } from "@loom/core";
import {
  type AtRestEventReader,
  type EventStore,
  InMemoryAsyncEventStore,
  OPTIONAL_EVENT_STORE_METHODS,
  type OptionalEventStoreMethod,
  type SealMarker,
  type SealingCapability,
  refusalsOf,
} from "@loom/event-runtime";
import {
  InMemoryAsyncSnapshotStore,
  OPTIONAL_SNAPSHOT_STORE_METHODS,
  type OptionalSnapshotStoreMethod,
  type SnapshotStore,
} from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { runEventStoreConformance, runSnapshotStoreConformance } from "./index.js";

// ── Store DECORATOR conformance (ADR 0074 Amendment, L1) ─────────────────────
//
// A decorator (tenant scoping, encryption, content resolution, the audit chain, a fault
// injector…) wraps a store and must hand every OPTIONAL SPI method through — or say, with a
// reason, why it does not. A decorator that silently drops one takes the capability away from
// everything above it: `Coalescing(TenantScoped(backend))` lost every batch that way, and an
// encrypted log could be neither retained nor compacted. `runEventStoreConformance` alone
// cannot see this, because it SKIPS an optional case when the method is absent — exactly the
// vacuous-check shape. This kit wraps a store that has every optional method, so an absence
// can only be the decorator's doing.

export interface DecoratorConformanceOptions<M extends string, S = unknown> {
  /**
   * The store to wrap, fresh per case. Default: the in-memory reference store. Pass a real
   * backend (Postgres, SQLite) to run the whole suite through the decorator over it — it must
   * offer every optional method, which the kit checks first.
   */
  inner?: () => S;
  /**
   * Optional methods this decorator deliberately does not offer, each with its reason. A
   * decorator built on `installOptional` records its `{ refuse }` entries itself; list one here
   * only for a decorator that does not use the helper.
   */
  refused?: Partial<Record<M, string>>;
}

/**
 * The problems with a decorated store's optional surface, given a full-capability inner.
 * Empty means every optional method survived or was refused with a reason. Exported from this
 * module (not the package) so the kit's own negative test can prove it fires.
 */
export function optionalSurfaceProblems(
  label: string,
  store: object,
  methods: readonly string[],
  refused: Partial<Record<string, string>> = {}
): string[] {
  const problems: string[] = [];
  const recorded = refusalsOf(store);
  for (const method of methods) {
    const present = typeof (store as Record<string, unknown>)[method] === "function";
    const reason = refused[method] ?? recorded.get(method);
    if (reason === undefined) {
      if (!present) {
        problems.push(
          `${label} silently drops ${method}: the inner store has it, the decorator does not (forward it, override it, or refuse it with a reason)`
        );
      }
    } else if (reason.trim() === "") {
      problems.push(`${label} refuses ${method} without a reason`);
    } else if (present) {
      problems.push(`${label} declares ${method} refused ("${reason}") but still exposes it`);
    }
  }
  return problems;
}

/**
 * The reference inner store of the EventStore decorator kit: the in-memory store PLUS `storeNow()`
 * (SPI 2.4.0), so "every optional method" really is every one and a decorator that drops the clock is
 * caught. The in-memory store itself omits it (a single process has one clock: callers fall back to
 * their injected one).
 */
export class ReferenceEventStore extends InMemoryAsyncEventStore {
  storeNow(): Promise<number> {
    return Promise.resolve(Date.now());
  }

  /**
   * SPI 2.5.0 (ADR 0130 residuals D7): a DEFINED capability, so a decorator that drops the method or
   * swallows its value is caught (an in-memory store really seals nothing; this is a fixture).
   */
  sealingCapability(): SealingCapability {
    return REFERENCE_SEALING;
  }

  /** SPI 2.5.0 (ADR 0130 D9): an in-memory store keeps envelopes as appended, so its at-rest view is its own reads. */
  readAtRest(): AtRestEventReader {
    return {
      read: (id) => this.read(id),
      readFrom: (id, from) => this.readFrom(id, from),
      readRange: (id, a, b) => this.readRange(id, a, b),
      head: (id) => this.head(id),
    };
  }
}

/**
 * Problems with a decorator over {@link ReferenceEventStore} that is supposed to FORWARD `readAtRest`:
 * the view must exist and hand back what was appended (a decorator that forwards the method but
 * returns a transformed or empty view would hide the stored bytes from the caller).
 */
export async function atRestForwardingProblems(
  label: string,
  store: Pick<EventStore, "readAtRest" | "append">
): Promise<string[]> {
  if (store.readAtRest === undefined) return [`${label} has no readAtRest()`];
  const id = "at-rest-fwd";
  const e = {
    id: `${id}-0`,
    executionId: id,
    workflowId: "w",
    sequence: 0,
    eventType: "EXECUTION_STARTED",
    timestamp: 1,
    payload: { marker: "at-rest" },
  } as EventEnvelope;
  await store.append(e);
  const got = await store.readAtRest().read(id);
  return got.length === 1 && JSON.stringify(got[0]?.payload) === JSON.stringify(e.payload)
    ? []
    : [`${label} altered or dropped the envelopes in readAtRest().read()`];
}

/**
 * Problems with a decorator over {@link ReferenceEventStore} that is supposed to FORWARD
 * `sealingCapability` unchanged: it must answer the reference capability's cipher, covers and
 * `opens()` verdicts. Catches a decorator that forwards the method but swallows or alters its value
 * (the drop case is `optionalSurfaceProblems`); either would make a sealing store read as plain.
 */
export function sealingForwardingProblems(
  label: string,
  store: Pick<EventStore, "sealingCapability">
): string[] {
  const got = store.sealingCapability?.();
  const problems: string[] = [];
  if (got === undefined) {
    return [
      `${label} returned no sealingCapability() over an inner store that has one (swallowed)`,
    ];
  }
  if (got.cipher !== REFERENCE_SEALING.cipher) {
    problems.push(`${label} altered sealingCapability().cipher (${String(got.cipher)})`);
  }
  if (JSON.stringify(got.covers) !== JSON.stringify(REFERENCE_SEALING.covers)) {
    problems.push(`${label} altered sealingCapability().covers (${JSON.stringify(got.covers)})`);
  }
  const probes: [SealMarker, boolean][] = [
    [{ v: 1, cipher: "loom/reference", covers: [] }, true],
    [{ v: 1, cipher: "other", covers: [] }, false],
  ];
  for (const [marker, want] of probes) {
    if (got.opens(marker) !== want) {
      problems.push(`${label} altered sealingCapability().opens() for cipher ${marker.cipher}`);
    }
  }
  return problems;
}

const REFERENCE_SEALING: SealingCapability = {
  cipher: "loom/reference",
  covers: ["STEP_COMPLETED.output"],
  opens: (marker) =>
    marker.cipher === "loom/reference" &&
    marker.covers.every((entry) => entry === "STEP_COMPLETED.output"),
};

/** EventStore decorator kit options: the shared ones plus how the decorator treats `sealingCapability`. */
export interface EventDecoratorConformanceOptions
  extends DecoratorConformanceOptions<OptionalEventStoreMethod, EventStore> {
  /**
   * `"forwards"` (default): the decorator seals nothing itself, so `sealingCapability()` over the
   * reference store must return the reference's own cipher and `covers`, and `opens` must agree.
   * `"own"`: the decorator computes its own capability (an encrypting store); only its presence is
   * checked here, its value is the decorator's own tests'.
   */
  sealing?: "forwards" | "own";
}

/** Whether `store` carries the structural encryption marker (`keys`) an encrypting store has. */
function hasEncryptionMarker(store: object): boolean {
  const keys = (store as { keys?: unknown }).keys;
  return typeof keys === "object" && keys !== null;
}

/** A full-capability reference store that also carries an encryption marker. */
function markedInner<T extends object>(inner: T): T {
  return Object.assign(inner, { keys: { durable: true } });
}

/**
 * Prove an {@link EventStore} DECORATOR composes: wrapped around a full-capability
 * `InMemoryAsyncEventStore`, every optional method survives (or is refused with a reason);
 * an encrypting inner store stays visibly encrypting through it; and the whole
 * `runEventStoreConformance` suite passes THROUGH the decorator — so the `appendBatch`
 * atomicity cases, which skip on a store without the method, actually run.
 */
export function runEventStoreDecoratorConformance(
  label: string,
  wrap: (inner: EventStore) => EventStore,
  options: EventDecoratorConformanceOptions = {}
): void {
  const inner = options.inner ?? (() => new ReferenceEventStore());
  describe(`${label} decorator conformance (optional EventStore SPI)`, () => {
    it("the reference inner store offers every optional method, so an absence is the decorator's", async () => {
      const reference = inner();
      expect(
        optionalSurfaceProblems("the inner store", reference, OPTIONAL_EVENT_STORE_METHODS)
      ).toEqual([]);
      await reference.close();
    });

    it("forwards every optional method, or refuses it with a stated reason", async () => {
      const store = wrap(inner());
      expect(
        optionalSurfaceProblems(label, store, OPTIONAL_EVENT_STORE_METHODS, options.refused)
      ).toEqual([]);
      await store.close();
    });

    it("hands the inner store's sealing capability through unchanged unless it owns the answer (SPI 2.5.0)", async () => {
      const store = wrap(inner());
      if (options.sealing === "own" || options.inner !== undefined) {
        // Its own answer (or an inner of the author's choosing): presence was checked above.
        expect(store.sealingCapability === undefined).toBe(false);
      } else {
        expect(sealingForwardingProblems(label, store)).toEqual([]);
      }
      await store.close();
    });

    it("hands the inner store's at-rest view through (SPI 2.5.0)", async () => {
      const store = wrap(inner());
      if (options.refused?.readAtRest !== undefined || refusalsOf(store).has("readAtRest")) {
        // Refused with a reason (checked by the optional-surface test above): it must not be exposed.
        expect(store.readAtRest).toBeUndefined();
      } else if (options.sealing === "own" || options.inner !== undefined) {
        expect(store.readAtRest === undefined).toBe(false);
      } else {
        expect(await atRestForwardingProblems(label, store)).toEqual([]);
      }
      await store.close();
    });

    it("keeps an encrypting inner store visibly encrypting (the `keys` marker survives)", async () => {
      // LogLifecycle's compaction/archive guard and `loom doctor` find encryption by this
      // marker. A decorator that hides it makes an encrypted log look plain — and compaction
      // would then checkpoint the decrypted fold outside the erasure boundary.
      const store = wrap(markedInner(inner()));
      expect(hasEncryptionMarker(store)).toBe(true);
      await store.close();
    });
  });
  runEventStoreConformance(() => wrap(inner()), `${label} (decorated)`);
}

/** The {@link SnapshotStore} counterpart of {@link runEventStoreDecoratorConformance}. */
export function runSnapshotStoreDecoratorConformance(
  label: string,
  wrap: (inner: SnapshotStore) => SnapshotStore,
  options: DecoratorConformanceOptions<OptionalSnapshotStoreMethod, SnapshotStore> = {}
): void {
  const inner = options.inner ?? (() => new InMemoryAsyncSnapshotStore());
  describe(`${label} decorator conformance (optional SnapshotStore SPI)`, () => {
    it("the reference inner store offers every optional method, so an absence is the decorator's", async () => {
      const reference = inner();
      expect(
        optionalSurfaceProblems("the inner store", reference, OPTIONAL_SNAPSHOT_STORE_METHODS)
      ).toEqual([]);
      await reference.close();
    });

    it("forwards every optional method, or refuses it with a stated reason", async () => {
      const store = wrap(inner());
      expect(
        optionalSurfaceProblems(label, store, OPTIONAL_SNAPSHOT_STORE_METHODS, options.refused)
      ).toEqual([]);
      await store.close();
    });

    it("keeps an encrypting inner store visibly encrypting (the `keys` marker survives)", async () => {
      const store = wrap(markedInner(inner()));
      expect(hasEncryptionMarker(store)).toBe(true);
      await store.close();
    });
  });
  runSnapshotStoreConformance(() => wrap(inner()), `${label} (decorated)`);
}
