import type { EventEnvelope } from "@loom/core";
import { type DecoratorPlan, installOptional } from "./installOptional";
import { type EventStore, type OptionalEventStoreMethod, appendBatchOf } from "./types";

export interface CoalescingEventStoreOptions {
  /**
   * Flush once this many envelopes are queued. The measured knee is ~16; past ~64 both
   * throughput and tail latency regress. Default 16.
   */
  maxBatch?: number;
  /**
   * Upper bound in milliseconds on how long the FIRST envelope of a batch waits for
   * company. Default 0 — flush on the next microtask, which under concurrency already
   * collects everything enqueued in the same turn without adding measurable latency.
   * Raise it only if you are deliberately trading latency for batch size.
   */
  maxLingerMs?: number;
}

interface Pending {
  envelope: EventEnvelope;
  resolve: () => void;
  reject: (err: unknown) => void;
}

/**
 * Merges concurrent appends **across executions** into one `appendBatch` (ADR 0074 D2).
 *
 * Why a decorator and not the journal: `ExecutionJournal` is per-execution, so a
 * journal-side batcher can only ever hold one execution's envelopes — a 1-step flow emits
 * four, and with a realistic slow effect the serial tail drains between `STEP_STARTED` and
 * `STEP_COMPLETED`, so it collects one. Measured; it is ADR 0065's own gate-2 case. A store
 * decorator sees every live execution at once and can actually fill a batch.
 *
 * **Ordering.** Each `ExecutionJournal` still serializes its own execution (D3 unchanged) —
 * it awaits each `append` before issuing the next, so this store never holds two envelopes
 * of one execution concurrently through the normal path. Should it anyway (a second writer,
 * a caller not using the journal), the queue is FIFO and `appendBatch` is specified to
 * apply in array order, so arrival order is preserved regardless.
 *
 * **Durability.** An `append` promise resolves only once its batch has committed. Nothing
 * resolves early, so every `drain()` barrier keeps exactly the meaning it has today. This
 * is the property that distinguishes coalescing from the durability classes ADR 0065
 * rejected on invariants.
 *
 * **Failure.** A batch rejection rejects every caller in that batch, so a partial write can
 * never look like success. Combined with `appendBatch`'s all-or-nothing contract, a failed
 * flush leaves the log untouched and every writer informed — **but only when the inner store
 * implements `appendBatch`**. Over a store without it, `appendBatchOf` falls back to a
 * sequential `append` loop, which is not atomic: envelopes ahead of the failing one are
 * already durable while their writers are told the batch failed. Every decorator between
 * this one and the backend must therefore carry `appendBatch` down (ADR 0074 Amendment —
 * `runEventStoreDecoratorConformance` checks it).
 *
 * **Blast radius.** One stale-fence zombie in a batch rejects the whole batch, so every
 * healthy writer coalesced with it is told "failed" too (nothing of theirs lands; they abort
 * and recovery re-drives them from the log). Coalescing widens a fencing rejection from one
 * execution to up to `maxBatch` of them — a price worth paying while fencing is rare.
 *
 * Inert unless wired: compose it explicitly in `storage`, outermost-but-one (sharding
 * outside it, since routing must pick a shard before a batch is formed for that shard).
 */
export class CoalescingEventStore implements EventStore {
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

  private readonly maxBatch: number;
  private readonly maxLingerMs: number;
  private queue: Pending[] = [];
  private flushScheduled = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Serializes flushes so two batches can never be in flight against the inner store. */
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly inner: EventStore,
    options: CoalescingEventStoreOptions = {}
  ) {
    this.maxBatch = Math.max(1, options.maxBatch ?? 16);
    this.maxLingerMs = Math.max(0, options.maxLingerMs ?? 0);
    // Pass through every optional capability the inner store has, so wrapping never
    // silently downgrades a backend (a missing `readRange` would push callers onto the
    // slow fallback for no reason). `appendBatch` is this class's own method — batching is
    // what it is for — so the plan covers every other optional method.
    const plan = {
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
    } satisfies DecoratorPlan<EventStore, Exclude<OptionalEventStoreMethod, "appendBatch">>;
    installOptional<EventStore, Exclude<OptionalEventStoreMethod, "appendBatch">>(
      this,
      inner,
      plan
    );
  }

  append(envelope: EventEnvelope): Promise<void> {
    if (this.closed) return Promise.reject(new Error("CoalescingEventStore is closed"));
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ envelope, resolve, reject });
      if (this.queue.length >= this.maxBatch) this.flushNow();
      else this.scheduleFlush();
    });
  }

  /**
   * A caller that already has a batch skips the queue entirely — it is by definition
   * already coalesced, and threading it through the queue would only risk splitting it.
   */
  appendBatch(envelopes: readonly EventEnvelope[]): Promise<void> {
    if (envelopes.length === 0) return Promise.resolve();
    if (this.closed) return Promise.reject(new Error("CoalescingEventStore is closed"));
    return this.enqueueFlush(() => appendBatchOf(this.inner, envelopes));
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    if (this.maxLingerMs === 0) {
      // Next microtask: collects everything enqueued in this turn — which under concurrency
      // is the whole in-flight set — without deferring to a timer.
      queueMicrotask(() => this.flushNow());
    } else {
      this.timer = setTimeout(() => this.flushNow(), this.maxLingerMs);
    }
  }

  private flushNow(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.flushScheduled = false;
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    void this.enqueueFlush(async () => {
      await appendBatchOf(
        this.inner,
        batch.map((p) => p.envelope)
      );
    }).then(
      () => {
        for (const p of batch) p.resolve();
      },
      (err: unknown) => {
        // Every writer in a failed batch learns it failed — a partial write must never be
        // reported as success.
        for (const p of batch) p.reject(err);
      }
    );
  }

  /** Chain onto the serial tail so batches commit one at a time, in enqueue order. */
  private enqueueFlush(run: () => Promise<void>): Promise<void> {
    const result = this.tail.then(run);
    // The tail itself must never reject, or every later flush would inherit the failure.
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
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

  /** Flush anything queued and wait for in-flight batches. Safe to call repeatedly. */
  async drain(): Promise<void> {
    this.flushNow();
    await this.tail;
  }

  async close(): Promise<void> {
    await this.drain();
    this.closed = true;
    await this.inner.close();
  }
}
