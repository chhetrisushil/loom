import type { EventEnvelope } from "@loom/core";
import type { EventStore } from "@loom/event-runtime";

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
    // Forward the optional fast-paths only when the inner store has them, so
    // capability probes (`if (store.copyPrefix)`) behave identically.
    ...(inner.readRange !== undefined && {
      readRange: inner.readRange.bind(inner),
    }),
    ...(inner.copyPrefix !== undefined && {
      copyPrefix: inner.copyPrefix.bind(inner),
    }),
  };

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
