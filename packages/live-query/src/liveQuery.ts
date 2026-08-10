import type { EventEnvelope, ExecutionState } from "@loom/core";
import type { EventStore } from "@loom/event-runtime";

// ── Live query over an in-flight execution ────────────────────────────────────
//
// Loom's `loadState` already folds an execution's durable state on demand (bounded by
// snapshots) — that IS a query. A LIVE query is that plus a subscription: re-fold and
// push the new state each time an event lands. This needs NO syscall and NO new event
// type — it composes `loadState` with `EventStore.subscribe`, so it stays a read-model
// concern (P10), never a kernel primitive.

/** The runtime capability a live query needs — just the folding read. */
export interface StateReader {
  loadState(executionId: string, options?: { principal?: unknown }): Promise<ExecutionState | null>;
}

export interface LiveQuery {
  /** The current folded state (null if the execution is unknown). */
  snapshot(executionId: string): Promise<ExecutionState | null>;
  /**
   * Push the current state now, then again after every subsequent event, until the
   * returned unsubscribe is called. `onState` receives a coalesced latest-wins state;
   * a terminal state is delivered before teardown so callers can stop on completion.
   */
  subscribe(executionId: string, onState: (state: ExecutionState) => void): Promise<() => void>;
}

export interface LiveQueryDeps {
  eventStore: EventStore;
  reader: StateReader;
  /**
   * Reports a BACKGROUND re-fold that failed — a store read that rejected, or an `onState`
   * callback that threw. Those run from the store's subscribe callback with nothing
   * awaiting them, so without this the rejection is unhandled and the process exits.
   *
   * The subscription stays live: one failed re-fold costs that update, and the next event
   * folds from the log again. Unset, failures are swallowed — never rethrown, because
   * there is no caller left to catch them.
   */
  onError?: (err: unknown) => void;
}

/** Build a {@link LiveQuery} over a store + a state reader (typically the runtime). */
export function liveQuery(deps: LiveQueryDeps): LiveQuery {
  const snapshot = (executionId: string): Promise<ExecutionState | null> =>
    deps.reader.loadState(executionId);

  return {
    snapshot,
    async subscribe(executionId, onState): Promise<() => void> {
      // Coalesce: only ever one re-fold in flight; if events arrive during a fold,
      // do exactly one more afterwards (latest-wins) so a burst is O(1) extra folds,
      // not one per event, and callers never see stale-then-newer out of order.
      let refolding = false;
      let dirty = false;

      const pump = async (): Promise<void> => {
        if (refolding) {
          dirty = true;
          return;
        }
        refolding = true;
        try {
          do {
            dirty = false;
            const state = await snapshot(executionId);
            if (state !== null) onState(state);
          } while (dirty);
        } finally {
          refolding = false;
        }
      };

      const unsubscribe = await deps.eventStore.subscribe(executionId, (_e: EventEnvelope) => {
        // Background re-fold: nothing awaits it, so it must never escape as an unhandled
        // rejection. The FIRST fold below is different — the caller awaits `subscribe`, so
        // a failure there is theirs to see and is deliberately left to propagate.
        void pump().catch((err: unknown) => deps.onError?.(err));
      });
      // Emit the current state immediately so a subscriber isn't blind until the next event.
      await pump();
      return unsubscribe;
    },
  };
}
