import type { EventEnvelope } from "@loom/core";
import {
  type AppendIfUnchangedResult,
  type DecoratorPlan,
  type EventStore,
  type OptionalEventStoreMethod,
  type TipObservation,
  installOptional,
} from "@loom/event-runtime";
import type { Rng } from "./rng";

// ── Fault-injecting event store ───────────────────────────────────────────────
//
// The generalization of `@loom/testing`'s single-point `crashingEventStore`: instead
// of one hard-coded crash predicate, faults are DRAWN from a seeded stream at each
// append/delivery point, and every decision is RECORDED as a `FaultDraw`. That gives
// two modes over the same code:
//   • explore — sample faults from an `Rng` + `FaultModel`, recording each draw;
//   • replay  — apply exactly a recorded `FaultDraw[]`, no rng, fully deterministic.
// Replay is what makes a failing simulation reproducible and shrinkable: drop a
// subset of the recorded draws and replay to see if the failure survives.
//
// Modeled faults map to real durability/transport failure shapes:
//   crash        — this append + all later appends are swallowed (the process died
//                  after a side effect but before the write landed; crash.ts window).
//   appendReject — this append throws (a transient store write error).
//   msgLoss      — a subscriber delivery is dropped (the write landed but the
//                  LISTEN/NOTIFY fan-out to a watcher was lost).
//   msgDup       — a subscriber delivery is duplicated (at-least-once transport).

export type FaultKind = "crash" | "appendReject" | "msgLoss" | "msgDup";

/** Per-point fault probabilities, each sampled independently from the stream. */
export interface FaultModel {
  /** P(this append triggers a crash — it and every later append are swallowed). */
  crashBeforeAppend?: number;
  /** P(this append throws instead of persisting). */
  appendReject?: number;
  /** P(a subscriber delivery is lost). */
  msgLoss?: number;
  /** P(a subscriber delivery is duplicated). */
  msgDup?: number;
}

const MODEL_KEY: Record<FaultKind, keyof FaultModel> = {
  crash: "crashBeforeAppend",
  appendReject: "appendReject",
  msgLoss: "msgLoss",
  msgDup: "msgDup",
};

/** A recorded fault decision — the replayable, shrinkable unit of a schedule. */
export interface FaultDraw {
  /** Monotonic decision index (append/delivery order). */
  tick: number;
  kind: FaultKind;
  /** The envelope the fault applied to (for evidence + readable schedules). */
  envelopeId: string;
  sequence: number;
  eventType: string;
}

export type FaultSource =
  | { mode: "explore"; rng: Rng; model: FaultModel }
  | { mode: "replay"; draws: readonly FaultDraw[] };

export interface FaultInjectingStore {
  /** The wrapped store to hand to the runtime under test. */
  store: EventStore;
  /** True once a crash fault has been triggered (all later appends swallowed). */
  readonly crashed: boolean;
  /** Every fault applied so far, in order — the replayable schedule. */
  readonly draws: FaultDraw[];
  /** Envelopes swallowed by a crash (for assertions). */
  readonly dropped: EventEnvelope[];
  /** "Reboot": stop swallowing appends so a recovery run persists normally. */
  restore(): void;
}

/**
 * Wrap an {@link EventStore} so appends and subscriber deliveries are subject to a
 * seeded {@link FaultModel} (explore) or a recorded {@link FaultDraw} list (replay).
 * Every optional store method is carried through (a `DecoratorPlan`), so a capability probe
 * (`if (store.copyPrefix)`) behaves identically to the inner store; `appendBatch` draws one
 * fault per batch.
 */
export function faultInjectingStore(inner: EventStore, source: FaultSource): FaultInjectingStore {
  const draws: FaultDraw[] = [];
  const dropped: EventEnvelope[] = [];
  let crashed = false;
  let restored = false;
  let tick = 0;

  // Replay lookup: `${tick}:${kind}` → applies. Built once for O(1) checks.
  const replayIndex = new Set<string>();
  if (source.mode === "replay") {
    for (const d of source.draws) replayIndex.add(`${d.tick}:${d.kind}`);
  }

  const shouldFault = (kind: FaultKind, at: number): boolean => {
    if (restored) return false;
    if (source.mode === "replay") return replayIndex.has(`${at}:${kind}`);
    const p = source.model[MODEL_KEY[kind]];
    return p !== undefined && source.rng.bool(p);
  };

  const record = (kind: FaultKind, e: EventEnvelope, at: number): void => {
    draws.push({ tick: at, kind, envelopeId: e.id, sequence: e.sequence, eventType: e.eventType });
  };

  const store: EventStore = {
    async append(envelope: EventEnvelope): Promise<void> {
      const at = tick++;
      if (crashed && !restored) {
        dropped.push(envelope);
        return; // already crashed: swallow the tail
      }
      if (shouldFault("crash", at)) {
        crashed = true;
        record("crash", envelope, at);
        dropped.push(envelope);
        return;
      }
      if (shouldFault("appendReject", at)) {
        record("appendReject", envelope, at);
        throw new Error(`dst: injected append rejection for ${envelope.id}`);
      }
      await inner.append(envelope);
    },
    read: (executionId) => inner.read(executionId),
    readFrom: (executionId, fromSequence) => inner.readFrom(executionId, fromSequence),
    subscribe: (executionId, handler): Promise<() => void> =>
      // Wrap delivery so msgLoss/msgDup faults apply per delivered event.
      inner.subscribe(executionId, (e: EventEnvelope) => {
        const at = tick++;
        if (shouldFault("msgLoss", at)) {
          record("msgLoss", e, at);
          return; // delivery lost
        }
        if (shouldFault("msgDup", at)) {
          record("msgDup", e, at);
          handler(e); // deliver twice
        }
        handler(e);
      }),
    close: () => inner.close(),
  };

  // Every optional method decided over the whole union (ADR 0074 Amendment), each installed
  // only when the inner store has it, so a capability probe behaves identically.
  const plan = {
    // ONE fault decision per batch — a batch is one round-trip, so it lands or fails whole.
    // This is what lets DST exercise the coalescing path at all: before, the method was
    // dropped and `CoalescingEventStore` quietly degraded to per-envelope appends.
    appendBatch: async (envelopes: readonly EventEnvelope[]): Promise<void> => {
      if (envelopes.length === 0) return;
      const at = tick++;
      const first = envelopes[0] as EventEnvelope;
      if (crashed && !restored) {
        dropped.push(...envelopes);
        return;
      }
      if (shouldFault("crash", at)) {
        crashed = true;
        record("crash", first, at);
        dropped.push(...envelopes);
        return;
      }
      if (shouldFault("appendReject", at)) {
        record("appendReject", first, at);
        throw new Error(`dst: injected batch rejection for ${first.id} (+${envelopes.length - 1})`);
      }
      await (inner.appendBatch as (es: readonly EventEnvelope[]) => Promise<void>)(envelopes);
    },
    head: "forward",
    readRange: "forward",
    acquireFence: "forward",
    acquireFenceIf: "forward",
    // One fault decision, exactly like a single `append`.
    appendIfUnchanged: async (
      executionId: string,
      event: EventEnvelope | null,
      expect?: TipObservation
    ): Promise<AppendIfUnchangedResult> => {
      const conditional = inner.appendIfUnchanged as NonNullable<EventStore["appendIfUnchanged"]>;
      if (event === null) return conditional.call(inner, executionId, null, expect);
      const at = tick++;
      if (crashed && !restored) {
        dropped.push(event);
        return { appended: true };
      }
      if (shouldFault("crash", at)) {
        crashed = true;
        record("crash", event, at);
        dropped.push(event);
        return { appended: true };
      }
      if (shouldFault("appendReject", at)) {
        record("appendReject", event, at);
        throw new Error(`dst: injected append rejection for ${event.id}`);
      }
      return conditional.call(inner, executionId, event, expect);
    },
    storeNow: "forward",
    sealingCapability: "forward",
    readAtRest: "forward",
    copyPrefix: "forward",
    deleteExecution: "forward",
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
    draws,
    dropped,
    restore() {
      restored = true;
    },
  };
}
