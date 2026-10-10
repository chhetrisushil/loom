import type { EventEnvelope } from "@loom/core";
import { type DecoratorPlan, installOptional } from "./installOptional";
import type { EventStore, OptionalEventStoreMethod } from "./types";

/** Store-side timings, in milliseconds unless stated otherwise. */
export interface WriteProfile {
  /** Envelopes durably appended (counting each envelope of a batch). */
  envelopes: number;
  /** Calls to `append` plus calls to `appendBatch` — i.e. round-trips. */
  roundTrips: number;
  /** Summed wall time inside the store's write calls. */
  totalWriteMs: number;
  /** Longest single write call. */
  maxWriteMs: number;
  /** Greatest number of write calls in flight at once — the queue the log is absorbing. */
  peakConcurrentWrites: number;
  /** Wall time from the first write starting to the last one finishing. */
  spanMs: number;
  /** Envelopes per second over `spanMs`. 0 before anything is written. */
  envelopesPerSec: number;
}

/**
 * Measures what the durable write path actually costs, so a workload can be *profiled*
 * rather than reasoned about.
 *
 * This exists for [ADR 0065](../../../docs/adr/0065-group-commit-deferred-evidence-gate.md)
 * gate 1, which asks for a real workload where **event-write throughput — not effect
 * latency, not fold cost — is the measured bottleneck**, and is explicit that a profile is
 * required rather than intuition. The gate is deliberately hard to satisfy: `ExecutionJournal`
 * already decouples the interpreter from write latency by queueing appends on a serial
 * tail, so a workload can write a great deal without writes ever being the constraint.
 *
 * Point this at your own application, alongside `effectTimingMiddleware` from
 * `@loom/middleware`, and compare: if effect time dwarfs write time, batching cannot help
 * you, whatever the raw event rate looks like.
 *
 * Zero-cost when unwired — it is a decorator, so a store that is not wrapped is unaffected.
 */
export class ProfilingEventStore implements EventStore {
  readonly head?: NonNullable<EventStore["head"]>;
  readonly readRange?: NonNullable<EventStore["readRange"]>;
  readonly acquireFence?: NonNullable<EventStore["acquireFence"]>;
  readonly acquireFenceIf?: NonNullable<EventStore["acquireFenceIf"]>;
  readonly appendIfUnchanged?: NonNullable<EventStore["appendIfUnchanged"]>;
  readonly storeNow?: NonNullable<EventStore["storeNow"]>;
  readonly copyPrefix?: NonNullable<EventStore["copyPrefix"]>;
  readonly deleteExecution?: NonNullable<EventStore["deleteExecution"]>;
  readonly truncatePrefix?: NonNullable<EventStore["truncatePrefix"]>;
  readonly truncatePrefixKeeping?: NonNullable<EventStore["truncatePrefixKeeping"]>;
  readonly listExecutions?: NonNullable<EventStore["listExecutions"]>;
  readonly listExecutionsPage?: NonNullable<EventStore["listExecutionsPage"]>;
  readonly appendBatch?: NonNullable<EventStore["appendBatch"]>;

  private envelopes = 0;
  private roundTrips = 0;
  private totalWriteMs = 0;
  private maxWriteMs = 0;
  private inFlight = 0;
  private peakConcurrentWrites = 0;
  private firstStart: number | undefined;
  private lastEnd = 0;

  constructor(private readonly inner: EventStore) {
    // Only advertise what the inner store has (installOptional's rule), so wrapping never
    // changes which path a caller takes. Batches are timed like single appends.
    const plan = {
      appendBatch: (envelopes) => this.timed(envelopes.length, () => inner.appendBatch!(envelopes)),
      head: "forward",
      readRange: "forward",
      acquireFence: "forward",
      acquireFenceIf: "forward",
      appendIfUnchanged: "forward",
      storeNow: "forward",
      copyPrefix: "forward",
      deleteExecution: "forward",
      truncatePrefix: "forward",
      truncatePrefixKeeping: "forward",
      listExecutions: "forward",
      listExecutionsPage: "forward",
    } satisfies DecoratorPlan<EventStore, OptionalEventStoreMethod>;
    installOptional<EventStore, OptionalEventStoreMethod>(this, inner, plan);
  }

  private async timed(envelopes: number, run: () => Promise<void>): Promise<void> {
    const started = performance.now();
    if (this.firstStart === undefined) this.firstStart = started;
    this.inFlight++;
    if (this.inFlight > this.peakConcurrentWrites) this.peakConcurrentWrites = this.inFlight;
    try {
      await run();
    } finally {
      const elapsed = performance.now() - started;
      this.inFlight--;
      this.roundTrips++;
      this.envelopes += envelopes;
      this.totalWriteMs += elapsed;
      if (elapsed > this.maxWriteMs) this.maxWriteMs = elapsed;
      this.lastEnd = performance.now();
    }
  }

  append(envelope: EventEnvelope): Promise<void> {
    return this.timed(1, () => this.inner.append(envelope));
  }

  /** Snapshot of the write profile so far. */
  writeProfile(): WriteProfile {
    const spanMs = this.firstStart === undefined ? 0 : this.lastEnd - this.firstStart;
    return {
      envelopes: this.envelopes,
      roundTrips: this.roundTrips,
      totalWriteMs: this.totalWriteMs,
      maxWriteMs: this.maxWriteMs,
      peakConcurrentWrites: this.peakConcurrentWrites,
      spanMs,
      envelopesPerSec: spanMs > 0 ? (this.envelopes / spanMs) * 1000 : 0,
    };
  }

  /** Discard measurements (e.g. after a warmup phase). */
  resetProfile(): void {
    this.envelopes = 0;
    this.roundTrips = 0;
    this.totalWriteMs = 0;
    this.maxWriteMs = 0;
    this.peakConcurrentWrites = 0;
    this.firstStart = undefined;
    this.lastEnd = 0;
  }

  read(executionId: string): Promise<EventEnvelope[]> {
    return this.inner.read(executionId);
  }

  readFrom(executionId: string, fromSequence: number): Promise<EventEnvelope[]> {
    return this.inner.readFrom(executionId, fromSequence);
  }

  subscribe(executionId: string, handler: (event: EventEnvelope) => void): Promise<() => void> {
    return this.inner.subscribe(executionId, handler);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
