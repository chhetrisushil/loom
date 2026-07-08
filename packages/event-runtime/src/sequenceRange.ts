import type { EventEnvelope } from "@loom/core";

// Binary-search helpers over an event array that is sorted ascending by
// `sequence` — the invariant every EventStore preserves (the per-execution
// sequencer assigns strictly increasing sequences, and `copyPrefix` copies in
// order). They turn range reads on an in-memory log from O(n) filters into
// O(log n + k) slices, and back the workflow-runtime fork/materialize path.

/** First index whose event.sequence >= `seq` (i.e. events.length if none). */
export function lowerBoundBySequence(events: readonly EventEnvelope[], seq: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((events[mid] as EventEnvelope).sequence < seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Events with `fromSequence <= sequence <= toSequence`, assuming `events` is
 * sorted ascending by sequence. O(log n) to locate the bounds + O(k) to copy the
 * k in-range events — no full scan.
 */
export function sliceBySequence(
  events: readonly EventEnvelope[],
  fromSequence: number,
  toSequence: number
): EventEnvelope[] {
  if (toSequence < fromSequence) return [];
  const start = lowerBoundBySequence(events, fromSequence);
  const end = lowerBoundBySequence(events, toSequence + 1);
  return events.slice(start, end);
}
