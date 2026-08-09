import type { EventEnvelope } from "@loom/core";

/**
 * The backend-independent half of `EventStore.subscribe` (ADR 0074 D4).
 *
 * Every store has to do the same three things: keep a per-execution set of local handlers,
 * fan an event out to them, and — for stores whose transport echoes an append back to its
 * own publisher — ignore what it published itself. That was written three times
 * (in-memory, SQLite, Postgres) before this existed.
 *
 * What it deliberately does NOT do is decide how events arrive. That is the genuinely
 * backend-specific part: a global channel, a per-bucket channel, a Redis topic, a Kafka
 * partition. {@link interest} exists so a transport can ask "what am I actually subscribed
 * to?" and narrow what it asks for upstream instead of receiving everything and
 * discarding — the difference between broadcast delivery and interest-filtered delivery.
 *
 * A bring-your-own backend composes this and implements only the transport.
 */
export class SubscriberRegistry {
  private readonly handlers = new Map<string, Set<(event: EventEnvelope) => void>>();
  /**
   * Fires when an execution gains its first handler or loses its last, so a transport can
   * subscribe/unsubscribe upstream in step. Both arguments are supplied so a transport can
   * work at whatever granularity it uses (per-execution, per-bucket).
   */
  private readonly onInterestChange:
    | ((executionId: string, kind: "first" | "last") => void)
    | undefined;

  constructor(
    options: { onInterestChange?: (executionId: string, kind: "first" | "last") => void } = {}
  ) {
    this.onInterestChange = options.onInterestChange;
  }

  /**
   * Register a local handler. Returns an unsubscribe that removes it and, when it was the
   * last for that execution, drops the entry (so {@link interest} stays tight).
   */
  add(executionId: string, handler: (event: EventEnvelope) => void): () => void {
    let set = this.handlers.get(executionId);
    const isFirst = set === undefined;
    if (set === undefined) {
      set = new Set();
      this.handlers.set(executionId, set);
    }
    set.add(handler);
    if (isFirst) this.onInterestChange?.(executionId, "first");
    let removed = false;
    return () => {
      // Idempotent: a caller may unsubscribe twice, and must not then fire "last" twice or
      // tear down a subscription a later subscriber re-established.
      if (removed) return;
      removed = true;
      const current = this.handlers.get(executionId);
      if (current === undefined) return;
      current.delete(handler);
      if (current.size === 0) {
        this.handlers.delete(executionId);
        this.onInterestChange?.(executionId, "last");
      }
    };
  }

  /** Whether anything local cares about this execution. The transport's filter predicate. */
  has(executionId: string): boolean {
    return this.handlers.has(executionId);
  }

  /** The executions with at least one local handler — this node's interest set. */
  interest(): string[] {
    return [...this.handlers.keys()];
  }

  /** Number of executions currently subscribed (not the number of handlers). */
  get size(): number {
    return this.handlers.size;
  }

  /**
   * Fan an event out to local handlers. Synchronous, matching the store contract that a
   * same-process subscriber sees the event as part of the append.
   *
   * Iterates a COPY: a handler that unsubscribes (or subscribes) during delivery must not
   * perturb the set being walked.
   */
  emit(event: EventEnvelope): void {
    const set = this.handlers.get(event.executionId);
    if (set === undefined || set.size === 0) return;
    for (const handler of [...set]) handler(event);
  }

  /** Drop every subscription. Used by `close()`. */
  clear(): void {
    this.handlers.clear();
  }
}

/**
 * Map an executionId onto one of `buckets` channels, for transports that cannot afford a
 * channel per execution but must not broadcast everything either (ADR 0074 D4).
 *
 * FNV-1a over the id: stable across processes and restarts — which is required, since two
 * nodes must agree on which bucket an execution lives in — and dependency-free.
 */
export function bucketOf(executionId: string, buckets: number): number {
  if (buckets <= 1) return 0;
  let hash = 0x811c9dc5;
  for (let i = 0; i < executionId.length; i++) {
    hash ^= executionId.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts; `>>> 0` keeps it unsigned.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash % buckets;
}
