import {
  type EventStore,
  InMemoryAsyncEventStore,
  OPTIONAL_EVENT_STORE_METHODS,
  type OptionalEventStoreMethod,
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
  options: DecoratorConformanceOptions<OptionalEventStoreMethod, EventStore> = {}
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
