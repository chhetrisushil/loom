import type { EventEnvelope, ExecutionState } from "@loom/core";
import type { EventStore } from "@loom/event-runtime";
import { foldEvents } from "@loom/replay-vm";

// ── Live query over an in-flight execution ────────────────────────────────────
//
// Loom's `loadState` already folds an execution's durable state on demand (bounded by
// snapshots) — that IS a query. A LIVE query is that plus a subscription: re-fold and
// push the new state each time an event lands. This needs NO syscall and NO new event
// type — it composes `loadState` with `EventStore.subscribe`, so it stays a read-model
// concern (P10), never a kernel primitive.
//
// INCREMENTAL FOLD — the one-time full load, then deltas only. `loadState` bounds a
// single fold's I/O with snapshots, but a live subscriber re-folding from genesis on
// EVERY event is still O(N) rows per event and O(N²) over an execution's lifetime (see
// `WorkflowRuntime.foldState`'s docstring). So `subscribe` calls `reader.loadState`
// exactly ONCE per subscription — establishing `state` and `tip` (the last folded
// sequence) — and every later wake-up instead reads only the tail since `tip`
// (`eventStore.readFrom(id, tip + 1)`) and folds that delta onto the kept `state` with
// the kernel's own `foldEvents` (no new fold, no new version — `fold(snapshot, suffix)
// === fold(events)` is already load-bearing for snapshots/compaction). Total I/O goes
// from O(N²) to O(N).
//
// It reads the delta rather than folding the delivered envelope because delivery can be
// gapped, duplicated or cross-node — `readFrom` handles all three for free — and because
// `ContentResolvingEventStore.subscribe` deliberately delivers the RAW ref-bearing event
// when resolution fails, whereas its read path throws `ContentMissingError` loudly. An
// empty delta emits nothing; a deleted execution (`readFrom` returns `[]` forever) stays
// silent, same as today's `null`-skipping.
//
// The gate for "still need the one-time full load" is `state === null` — not a separate
// boolean — because a subscription started before the execution exists must keep asking
// the reader (cheaply: an empty log) until the reader hands back a real baseline with the
// executionId/workflowId identity `foldEvents([], undefined)` cannot invent on its own.

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

      // Per-subscription incremental fold state. `state === null` means "no baseline
      // yet" — the ONLY condition under which a pass does the full `reader.loadState`;
      // every other pass reads just the tail past `tip` and folds it onto `state`.
      let state: ExecutionState | null = null;
      let tip = -1;

      const pump = async (): Promise<void> => {
        if (refolding) {
          dirty = true;
          return;
        }
        refolding = true;
        try {
          do {
            dirty = false;
            if (state === null) {
              state = await deps.reader.loadState(executionId);
              if (state !== null) tip = state.sequence;
            } else {
              const delta = await deps.eventStore.readFrom(executionId, tip + 1);
              if (delta.length === 0) continue; // nothing new — emit nothing
              // `foldEvents` treats `state` as immutable (fresh audit-list ownership per
              // pass), so folding the delta onto the kept state never mutates what a
              // previous `onState` call was handed.
              state = foldEvents(delta, state);
              tip = delta[delta.length - 1]!.sequence;
            }
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
