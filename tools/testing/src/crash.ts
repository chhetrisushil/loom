import type { EventEnvelope } from "@loom/core";
import {
  type AppendIfUnchangedResult,
  type DecoratorPlan,
  type EventStore,
  type OptionalEventStoreMethod,
  type TipObservation,
  installOptional,
} from "@loom/event-runtime";

export interface CrashingEventStoreOptions {
  /**
   * The crash trigger: once this returns true for an appended envelope, that
   * envelope AND every subsequent append are silently swallowed — the exact
   * durability shape of a process that performed a side effect but died before
   * its completion event reached the log.
   */
  dropFrom: (envelope: EventEnvelope) => boolean;
}

export interface CrashingEventStore {
  /** The wrapped store to hand to the runtime under test. */
  store: EventStore;
  /** True once the crash has been triggered. */
  crashed: boolean;
  /** Every envelope swallowed by the simulated crash (for assertions). */
  dropped: EventEnvelope[];
  /**
   * "Reboot": stop swallowing appends so the recovery run persists normally.
   * Call before building the fresh runtime that drives recovery.
   */
  restore(): void;
}

/**
 * K9.5 — crash-injection harness. Wraps an EventStore so a test can kill an
 * execution *between an effect completing and its event reaching the log* —
 * the window that makes effect delivery at-least-once — then drive recovery
 * against the surviving prefix and prove the tool's idempotency semantics
 * (converges under `idempotent: true`/undeclared re-runs; parks at
 * EFFECT_INDOUBT under `idempotent: false`).
 *
 * ```ts
 * const crash = crashingEventStore(new InMemoryAsyncEventStore(), {
 *   dropFrom: (e) =>
 *     e.eventType === "STEP_COMPLETED" && (e.payload as { stepId?: string }).stepId === "pay",
 * });
 * // run with crash.store … the pay step's completion never becomes durable
 * crash.restore(); // reboot
 * // build a fresh runtime over crash.store and redispatch → recovery
 * ```
 */
export function crashingEventStore(
  inner: EventStore,
  options: CrashingEventStoreOptions
): CrashingEventStore {
  const dropped: EventEnvelope[] = [];
  let crashed = false;
  let restored = false;

  const store: EventStore = {
    async append(envelope: EventEnvelope): Promise<void> {
      if (!restored && (crashed || options.dropFrom(envelope))) {
        crashed = true;
        dropped.push(envelope);
        return; // swallowed: the process "died" before this write landed
      }
      return inner.append(envelope);
    },
    read: (executionId) => inner.read(executionId),
    readFrom: (executionId, fromSequence) => inner.readFrom(executionId, fromSequence),
    subscribe: (executionId, handler) => inner.subscribe(executionId, handler),
    close: () => inner.close(),
  };

  // Every optional method decided over the whole union (ADR 0074 Amendment), each installed
  // only when the inner store has it, so capability probes (`if (store.copyPrefix)`) behave
  // identically. Everything forwards except `appendBatch`, which must honour the crash: a
  // verbatim forward would let a coalesced write sail past the simulated death.
  const plan = {
    // Same shape as N sequential appends: the envelopes BEFORE the trigger land (in one
    // round-trip), the trigger and everything after it are swallowed.
    appendBatch: async (envelopes: readonly EventEnvelope[]): Promise<void> => {
      let cut = envelopes.length;
      if (!restored) {
        cut = crashed ? 0 : envelopes.findIndex((e) => options.dropFrom(e));
        if (cut === -1) cut = envelopes.length;
      }
      if (cut < envelopes.length) {
        crashed = true;
        dropped.push(...envelopes.slice(cut));
      }
      if (cut > 0) {
        await (inner.appendBatch as (es: readonly EventEnvelope[]) => Promise<void>)(
          cut === envelopes.length ? envelopes : envelopes.slice(0, cut)
        );
      }
    },
    head: "forward",
    readRange: "forward",
    acquireFence: "forward",
    acquireFenceIf: "forward",
    // Honours the crash like `append`: a swallowed write reports success (the process "died").
    appendIfUnchanged: async (
      executionId: string,
      event: EventEnvelope | null,
      expect?: TipObservation
    ): Promise<AppendIfUnchangedResult> => {
      const conditional = inner.appendIfUnchanged as NonNullable<EventStore["appendIfUnchanged"]>;
      if (event === null) return conditional.call(inner, executionId, null, expect);
      if (!restored && (crashed || options.dropFrom(event))) {
        crashed = true;
        dropped.push(event);
        return { appended: true };
      }
      return conditional.call(inner, executionId, event, expect);
    },
    storeNow: "forward",
    sealingCapability: "forward",
    readAtRest: "forward",
    copyPrefix: "forward",
    deleteExecution: "forward",
    deleteThrough: "forward",
    truncatePrefix: "forward",
    truncatePrefixKeeping: "forward",
    listExecutions: "forward",
    listExecutionsPage: "forward",
  } satisfies DecoratorPlan<EventStore, OptionalEventStoreMethod>;
  installOptional<EventStore, OptionalEventStoreMethod>(store, inner, plan);

  return {
    store,
    get crashed() {
      return crashed;
    },
    dropped,
    restore() {
      restored = true;
    },
  };
}
