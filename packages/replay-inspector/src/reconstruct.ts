import type { EventEnvelope, ExecutionState } from "@loom/core";
import { foldEvents, normalizeSnapshotState } from "@loom/replay-vm";
import { CompactedHistoryError, InspectorBudgetError } from "./types";
import type { ReadOnlyEventStore, ReadOnlySnapshotStore } from "./types";

// ── IX-2 — state reconstruction at any event ──────────────────────────────────
//
// The original requirement cited `ReplayVM.applyEvent` + `getState` as "scrub-to-event
// directly — the primitive already exists". It is not the primitive to build on.
// `applyEvent` is `foldEvents([event], this.state)` (ReplayVM.ts:61), and `foldEvents`
// calls `resetFoldOwnership()` at its head (foldEvents.ts:33). One event per call means
// ownership is reset per event, so `appendAudit` never takes its in-place branch and
// re-copies every audit list at every step: O(n²) in audit-list length, against an
// acceptance criterion of 10⁴ events in interactive time.
//
// The shape that is actually optimal, and which needs no change to `@loom/replay-vm`:
//
//   anchor  = snapshots.loadLatestBefore(executionId, firstPosition)   ← built for fork()
//   events  = events.readRange(executionId, anchor+1, lastPosition)    ← one bounded read
//   states  = one foldEvents call PER REQUESTED POSITION, in sequence order
//
// Batching is what removes the pathology: within a single `foldEvents` call ownership
// holds, so audit lists are appended in place. Total work is O(E) in events folded plus
// O(P·|audit|) for P requested positions, instead of O(E·|audit|). For a timeline that
// renders P rows over E events — the actual use — that is the right complexity, and it
// degenerates to the optimal single fold when P = 1.
//
// Two store round-trips total, regardless of P.

/** Where a reconstruction started folding from. Surfaced so a caller can tell a
 *  snapshot-anchored read from a full replay without instrumenting the store. */
export interface ReconstructionAnchor {
  kind: "snapshot" | "origin";
  /** Sequence the fold resumed from; `-1` when replaying from the start of the log. */
  sequence: number;
}

export interface ReconstructionPoint {
  /** The requested position: state reflects every event with `sequence <= position`. */
  position: number;
  state: ExecutionState;
  /** Events folded from the anchor to reach this position (not since the previous one). */
  foldedEvents: number;
}

export interface ReconstructOptions {
  /**
   * Refuse rather than truncate above this many events in one reconstruction.
   * Default 1_000_000. A short read would produce a plausible-looking wrong state,
   * which is worse than an error — the same reasoning as IX-5's no-silent-fallback.
   */
  maxEvents?: number;
}

const DEFAULT_MAX_EVENTS = 1_000_000;

/**
 * Bounded segment read. `readRange` is OPTIONAL on the EventStore SPI, so a conforming
 * store may omit it; the fallback filters `readFrom`, which is what
 * `@loom/event-runtime`'s own `readRangeOf` helper does. Preferring `readRange` pushes
 * the bound into the backend's indexed query instead of loading the tail into JS —
 * material for IX-7, since a wide read is load the writer's backend also feels.
 */
async function readSegment(
  events: ReadOnlyEventStore,
  executionId: string,
  fromSequence: number,
  toSequence: number
): Promise<EventEnvelope[]> {
  if (toSequence < fromSequence) return [];
  if (events.readRange !== undefined) {
    return events.readRange(executionId, fromSequence, toSequence);
  }
  const tail = await events.readFrom(executionId, fromSequence);
  // `readFrom` is ordered by sequence, so stop at the first event past the bound
  // rather than filtering the whole tail.
  let end = tail.length;
  for (let i = 0; i < tail.length; i++) {
    if ((tail[i] as EventEnvelope).sequence > toSequence) {
      end = i;
      break;
    }
  }
  return end === tail.length ? tail : tail.slice(0, end);
}

/**
 * Reconstruct `ExecutionState` at each requested position, in one pass.
 *
 * Positions are de-duplicated and sorted; results come back in ascending position
 * order regardless of input order. A position below the execution's first event
 * yields the seeded (pre-start) state, which is the honest answer rather than an error.
 *
 * The returned states share structure with each other and with the anchoring snapshot
 * — the fold copies on write, it does not deep-clone. **Treat them as immutable.**
 * This is the same contract the kernel itself relies on when it seeds a fold from a
 * snapshot; `reconstruct.test.ts` pins that the store's snapshot is not mutated.
 */
export async function reconstructMany(
  events: ReadOnlyEventStore,
  snapshots: ReadOnlySnapshotStore | undefined,
  executionId: string,
  positions: readonly number[],
  options: ReconstructOptions = {}
): Promise<ReconstructionPoint[]> {
  if (positions.length === 0) return [];
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;

  const sorted = [...new Set(positions)].sort((x, y) => x - y);
  const first = sorted[0] as number;
  const last = sorted[sorted.length - 1] as number;

  // Anchor before the FIRST requested position — anchoring at the last would force a
  // backwards replay for every earlier position.
  const snapshot =
    snapshots !== undefined ? await snapshots.loadLatestBefore(executionId, first) : null;
  const anchorSequence = snapshot !== null ? snapshot.sequence : -1;

  const segment = await readSegment(events, executionId, anchorSequence + 1, last);
  if (segment.length > maxEvents) {
    throw new InspectorBudgetError(executionId, segment.length, maxEvents);
  }

  // ADR 0106 — compaction leaves gaps. A fold that crosses one returns a wrong state, so the
  // positions at or above the FIRST gap after the anchor are re-anchored on their own nearest
  // snapshot (one recursive call); if that anchor is still below the gap — the position sits
  // inside compacted history — it is refused rather than guessed. A gap can also END the
  // segment (positions inside a hole with nothing below them in range), so when the segment
  // stops short of `last`, the first event past it is probed: none means "past the tip".
  let expected = anchorSequence + 1;
  let hole: { from: number; through: number } | undefined;
  for (const e of segment) {
    if (e.sequence !== expected) {
      hole = { from: expected, through: e.sequence - 1 };
      break;
    }
    expected++;
  }
  if (hole === undefined && expected <= last) {
    const next = (await events.readFrom(executionId, expected))[0];
    if (next !== undefined) hole = { from: expected, through: next.sequence - 1 };
  }
  if (hole !== undefined) {
    const from = hole.from;
    const cut = sorted.findIndex((p) => p >= from);
    if (cut === 0) {
      throw new CompactedHistoryError(executionId, first, hole.from, hole.through);
    }
    const before = await reconstructMany(
      events,
      snapshots,
      executionId,
      sorted.slice(0, cut),
      options
    );
    const after = await reconstructMany(events, snapshots, executionId, sorted.slice(cut), options);
    return [...before, ...after];
  }

  // `foldEvents` shallow-spreads `initial` into a fresh object and treats the caller's
  // arrays as immutable (ownership is reset per call), so passing the store's snapshot
  // state directly is safe and avoids a clone.
  const seed: Partial<ExecutionState> =
    snapshot !== null
      ? normalizeSnapshotState(snapshot.state)
      : { executionId, workflowId: (segment[0] as EventEnvelope | undefined)?.workflowId ?? "" };

  const out: ReconstructionPoint[] = [];
  let state = foldEvents([], seed);
  let cursor = 0; // index into `segment` of the first not-yet-folded event
  let folded = 0;

  for (const position of sorted) {
    // Advance to the first event past this position. `segment` is sequence-ordered, and
    // `cursor` only moves forward, so the whole loop is one linear scan across all P
    // positions — not P scans.
    const start = cursor;
    while (cursor < segment.length && (segment[cursor] as EventEnvelope).sequence <= position) {
      cursor++;
    }
    if (cursor > start) {
      // One call for the whole slice: ownership holds across it, so audit lists append
      // in place instead of copying per event.
      state = foldEvents(segment.slice(start, cursor), state);
      folded += cursor - start;
    }
    out.push({ position, state, foldedEvents: folded });
  }

  return out;
}

/** Single-position convenience over {@link reconstructMany}. */
export async function reconstructAt(
  events: ReadOnlyEventStore,
  snapshots: ReadOnlySnapshotStore | undefined,
  executionId: string,
  position: number,
  options: ReconstructOptions = {}
): Promise<ReconstructionPoint> {
  const [point] = await reconstructMany(events, snapshots, executionId, [position], options);
  return point as ReconstructionPoint;
}

/** The anchor a reconstruction at `position` would use. Diagnostic only — it costs a
 *  snapshot load, so it is not folded into the reconstruction path. */
export async function anchorFor(
  snapshots: ReadOnlySnapshotStore | undefined,
  executionId: string,
  position: number
): Promise<ReconstructionAnchor> {
  const snapshot =
    snapshots !== undefined ? await snapshots.loadLatestBefore(executionId, position) : null;
  return snapshot !== null
    ? { kind: "snapshot", sequence: snapshot.sequence }
    : { kind: "origin", sequence: -1 };
}
