import { canonicalJson } from "@loom/core";
import type { EventEnvelope, ExecutionState } from "@loom/core";
import {
  type EventStore,
  headOf,
  isReservedStream,
  iterateExecutionIds,
} from "@loom/event-runtime";
import { ReplayVM, normalizeSnapshotState } from "@loom/replay-vm";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";

// ── ADR 0107 — the blank stream the pre-0106 compaction bug wrote ─────────────
//
// Before ADR 0106 a compaction checkpoint named execution `""`, and every resume folded on
// it journaled under that blank identity: the resumed events landed in execution `""`, at the
// sequences their own execution would have used. Their envelopes carry no identity at all
// (`executionId: ""`, `workflowId: ""`, ids `-<sequence>`), so the event alone never says
// whose it is. What does is the snapshot the same run saved under its REAL key — the runtime
// keyed its checkpoints by the id it was driving, and only the state inside them was blank.
//
// **Proof (a "snapshot" segment).** Execution X owns the blank-stream events in `(b, S]` when
//  1. X has a snapshot at S whose state carries the blank identity (only a run seeded from a
//     pre-0106 checkpoint writes one, and that run's journal wrote to `""`),
//  2. that snapshot was taken at a drain barrier (suspended or terminal — never the running
//     cadence checkpoint), so every event its run committed through S is durable,
//  3. `b` is X's next snapshot below S, and the blank stream holds every sequence in (b, S],
//  4. folding those events onto the snapshot at b reproduces the snapshot at S exactly.
// Slots are unique per stream, so an event another execution had written first would have
// failed X's append, and X's run could not have reached its drain barrier at S.
//
// **Not provable.** Events above X's LAST such snapshot: a run that completed without a
// checkpoint (the default cadence takes none), or crashed. Nothing that survives names their
// writer, and several executions can sit at the same sequence. The census lists them with the
// executions that could have written them; an operator who knows the owner assigns them
// explicitly (proof "operator"), and the repair still checks that they fold onto that
// execution's snapshot. It never guesses.

/** How a segment's ownership was established. */
export type RehomeProof = "snapshot" | "operator";

/**
 * What a repair would do with a segment.
 *
 * - `rehomable`: proven, and its execution's log can take it (some or all slots still empty).
 * - `rehomed`: every slot already holds this segment's event (an earlier repair).
 * - `occupied`: the execution's own log holds another event in the segment or below it — a
 *   pre-0106 denial written into the checkpoint's slot, say. Re-homing would give it a shape
 *   no reader can interpret.
 * - `superseded`: the execution was compacted again after the fix, so a later checkpoint
 *   already folds these events and its log has a gap above them. The log never compacted by
 *   the bug would not hold them either.
 * - `conflict`: two executions prove the same slot. Nothing is touched.
 * - `invalid`: an operator assignment that does not fold onto its execution (see `detail`).
 */
export type BlankSegmentStatus =
  | "rehomable"
  | "rehomed"
  | "occupied"
  | "superseded"
  | "conflict"
  | "invalid";

export interface BlankStreamSegment {
  executionId: string;
  fromSequence: number;
  throughSequence: number;
  proof: RehomeProof;
  status: BlankSegmentStatus;
  detail?: string;
}

/** A contiguous run of blank-stream events no proof and no assignment covers. */
export interface UnattributedRun {
  fromSequence: number;
  throughSequence: number;
  eventTypes: string[];
  /**
   * Executions with a blank-identity snapshot at `fromSequence − 1`: a run resumed from there
   * could have written this. Evidence for an operator, not an attribution.
   */
  candidates: string[];
}

export interface BlankStreamCensus {
  /** Events in execution `""`. */
  strayEvents: number;
  /** Executions enumerated. */
  scanned: number;
  /** Executions carrying a blank-identity snapshot: resumed after a pre-0106 compaction. */
  affected: string[];
  segments: BlankStreamSegment[];
  unattributed: UnattributedRun[];
}

/** An operator's assertion that `[fromSequence, throughSequence]` of `""` is `executionId`'s. */
export interface RehomeAssignment {
  executionId: string;
  fromSequence: number;
  throughSequence: number;
}

/** The census plus what applying it needs: the stray events and each execution's workflowId. */
export interface BlankStreamPlan {
  census: BlankStreamCensus;
  stray: ReadonlyMap<number, EventEnvelope>;
  /** Per segment in `census.segments`, the sequences its execution's log still lacks. */
  missing: ReadonlyMap<BlankStreamSegment, number[]>;
  workflowIdOf: ReadonlyMap<string, string>;
}

/** The metadata key a re-homed event carries: the id it had in the blank stream. */
export const REHOMED_FROM_KEY = "rehomedFrom";

const DRAINED = new Set<ExecutionState["status"]>([
  "suspended",
  "completed",
  "failed",
  "cancelled",
]);

const isBlank = (s: Snapshot): boolean => s.state.executionId === "";

/** A state with its identity blanked, as canonical JSON, or null when it is not plain JSON. */
function identityFree(state: ExecutionState): string | null {
  try {
    return canonicalJson({
      ...normalizeSnapshotState(state),
      executionId: "",
      workflowId: "",
      workflowVersion: "",
    });
  } catch {
    return null;
  }
}

/** Does folding `events` onto `base` reproduce `top` exactly (identity aside)? */
function foldReproduces(base: Snapshot, events: EventEnvelope[], top: Snapshot): boolean {
  const seed = { ...normalizeSnapshotState(base.state), executionId: "", workflowId: "" };
  const folded = identityFree(new ReplayVM(events, seed).getState());
  return folded !== null && folded === identityFree(top.state);
}

/** The stray events at `[from, through]`, or null unless every sequence is present. */
function strayRange(
  stray: ReadonlyMap<number, EventEnvelope>,
  from: number,
  through: number
): EventEnvelope[] | null {
  const out: EventEnvelope[] = [];
  for (let q = from; q <= through; q++) {
    const e = stray.get(q);
    if (e === undefined) return null;
    out.push(e);
  }
  return out;
}

/**
 * ADR 0107 — census the blank stream: which of its events are provably whose, which are
 * already re-homed, and which nobody can attribute. Reads only: `LogLifecycle.rehomeBlankStream`
 * applies it. Enumerates every execution (the store must implement `listExecutions` or
 * `listExecutionsPage`), reading per execution only the snapshots whose sequences fall inside
 * the blank stream's range, plus one log range for an affected one.
 */
export async function planBlankStreamRepair(
  eventStore: EventStore,
  snapshotStore: SnapshotStore,
  assign: readonly RehomeAssignment[] = []
): Promise<BlankStreamPlan> {
  const strayEvents = await eventStore.read("");
  const stray = new Map(strayEvents.map((e) => [e.sequence, e]));
  const census: BlankStreamCensus = {
    strayEvents: strayEvents.length,
    scanned: 0,
    affected: [],
    segments: [],
    unattributed: [],
  };
  const missing = new Map<BlankStreamSegment, number[]>();
  const workflowIdOf = new Map<string, string>();
  if (strayEvents.length === 0 && assign.length === 0) {
    return { census, stray, missing, workflowIdOf };
  }
  if (eventStore.listExecutions === undefined && eventStore.listExecutionsPage === undefined) {
    throw new TypeError(
      "the blank-stream census enumerates every execution, and this event store implements neither listExecutions nor listExecutionsPage"
    );
  }
  const minS = strayEvents[0]?.sequence ?? 0;
  const maxS = strayEvents[strayEvents.length - 1]?.sequence ?? 0;

  // Pass 1 — proofs, one execution at a time.
  const blankAt = new Map<number, string[]>();
  for await (const id of iterateExecutionIds(eventStore)) {
    if (isReservedStream(id)) continue;
    census.scanned++;
    if (strayEvents.length === 0) continue;
    // X's snapshots inside the window a segment can occupy, highest first. A segment's base
    // sits at minS − 1 at the lowest; nothing below it can anchor a stray event.
    const chain: Snapshot[] = [];
    for (
      let s = await snapshotStore.loadLatestBefore(id, maxS);
      s !== null && s.sequence >= minS - 1;
      s = s.sequence > 0 ? await snapshotStore.loadLatestBefore(id, s.sequence - 1) : null
    ) {
      chain.push(s);
    }
    if (!chain.some(isBlank)) continue;
    census.affected.push(id);
    for (const s of chain) {
      if (!isBlank(s)) continue;
      const at = blankAt.get(s.sequence);
      if (at === undefined) blankAt.set(s.sequence, [id]);
      else at.push(id);
    }
    for (let i = chain.length - 2; i >= 0; i--) {
      const top = chain[i]!;
      const base = chain[i + 1]!;
      if (!isBlank(top) || !DRAINED.has(normalizeSnapshotState(top.state).status)) continue;
      const events = strayRange(stray, base.sequence + 1, top.sequence);
      if (events === null || !foldReproduces(base, events, top)) continue;
      census.segments.push({
        executionId: id,
        fromSequence: base.sequence + 1,
        throughSequence: top.sequence,
        proof: "snapshot",
        status: "rehomable",
      });
    }
  }

  // Two executions proving one slot cannot both be right: neither is touched.
  const owner = new Map<number, BlankStreamSegment>();
  for (const seg of census.segments) {
    for (let q = seg.fromSequence; q <= seg.throughSequence; q++) {
      const other = owner.get(q);
      if (other !== undefined && other.executionId !== seg.executionId) {
        other.status = "conflict";
        seg.status = "conflict";
        seg.detail =
          other.detail = `sequence ${q} is proven for both ${other.executionId} and ${seg.executionId}`;
      } else {
        owner.set(q, seg);
      }
    }
  }

  // Operator assignments: the owner is asserted, the fold is still checked.
  for (const a of assign) {
    census.segments.push(await assess(eventStore, snapshotStore, stray, owner, a));
  }

  // Pass 2 — can each execution's own log take its segments?
  const byExecution = new Map<string, BlankStreamSegment[]>();
  for (const seg of census.segments) {
    if (seg.status !== "rehomable") continue;
    const list = byExecution.get(seg.executionId);
    if (list === undefined) byExecution.set(seg.executionId, [seg]);
    else list.push(seg);
  }
  for (const [id, segs] of byExecution) {
    const own = await eventStore.read(id);
    workflowIdOf.set(id, own[0]?.workflowId ?? "");
    const latest = await snapshotStore.loadLatest(id);
    judge(id, segs, own, latest?.sequence ?? -1, stray, missing);
  }

  // What nothing covers, as contiguous runs.
  const covered = new Set<number>();
  for (const seg of census.segments) {
    if (seg.status === "conflict" || seg.status === "invalid") continue;
    for (let q = seg.fromSequence; q <= seg.throughSequence; q++) covered.add(q);
  }
  let run: UnattributedRun | undefined;
  for (const e of strayEvents) {
    if (covered.has(e.sequence)) {
      run = undefined;
      continue;
    }
    if (run !== undefined && e.sequence === run.throughSequence + 1) {
      run.throughSequence = e.sequence;
      run.eventTypes.push(e.eventType);
    } else {
      run = {
        fromSequence: e.sequence,
        throughSequence: e.sequence,
        eventTypes: [e.eventType],
        candidates: blankAt.get(e.sequence - 1) ?? [],
      };
      census.unattributed.push(run);
    }
  }
  census.segments.sort(
    (a, b) => a.fromSequence - b.fromSequence || a.executionId.localeCompare(b.executionId)
  );
  return { census, stray, missing, workflowIdOf };
}

/** Check an operator assignment; the result carries its status (`rehomable` or `invalid`). */
async function assess(
  eventStore: EventStore,
  snapshotStore: SnapshotStore,
  stray: ReadonlyMap<number, EventEnvelope>,
  owner: Map<number, BlankStreamSegment>,
  a: RehomeAssignment
): Promise<BlankStreamSegment> {
  const seg: BlankStreamSegment = {
    executionId: a.executionId,
    fromSequence: a.fromSequence,
    throughSequence: a.throughSequence,
    proof: "operator",
    status: "invalid",
  };
  const refuse = (detail: string): BlankStreamSegment => {
    seg.detail = detail;
    return seg;
  };
  if (
    !Number.isSafeInteger(a.fromSequence) ||
    !Number.isSafeInteger(a.throughSequence) ||
    a.fromSequence < 1 ||
    a.throughSequence < a.fromSequence
  ) {
    return refuse("the range must be integers with 1 ≤ from ≤ through");
  }
  if (isReservedStream(a.executionId)) return refuse("that id names no execution");
  const events = strayRange(stray, a.fromSequence, a.throughSequence);
  if (events === null) return refuse("the blank stream does not hold every sequence in the range");
  for (let q = a.fromSequence; q <= a.throughSequence; q++) {
    const other = owner.get(q);
    if (other !== undefined) {
      return refuse(
        `sequence ${q} is already ${other.proof === "snapshot" ? "proven" : "assigned"} for ${other.executionId}`
      );
    }
  }
  if ((await headOf(eventStore, a.executionId)) === null) return refuse("no such execution");
  const seed = await snapshotStore.loadLatestBefore(a.executionId, a.fromSequence - 1);
  if (seed === null || seed.sequence !== a.fromSequence - 1) {
    return refuse(
      `no snapshot of ${a.executionId} at ${a.fromSequence - 1} to fold the range onto — a run that wrote it resumed from exactly there`
    );
  }
  const latest = await snapshotStore.loadLatest(a.executionId);
  if (latest !== null && latest.sequence > seed.sequence) {
    return refuse(
      `${a.executionId} has moved past ${seed.sequence} (a snapshot at ${latest.sequence}), so this range is a continuation it abandoned, not its history`
    );
  }
  const seedState = normalizeSnapshotState(seed.state);
  const folded = new ReplayVM(events, seedState).getState();
  if (folded.sequence !== a.throughSequence) {
    return refuse("the range does not fold onto the snapshot contiguously");
  }
  for (let q = a.fromSequence; q <= a.throughSequence; q++) owner.set(q, seg);
  seg.status = "rehomable";
  return seg;
}

/**
 * Decide an execution's `rehomable` segments against its own log. Re-homing must leave a log
 * that the log would have been without the bug, in a shape every reader interprets (ADR 0106
 * D2): the re-homed events and the log's own events above them form ONE contiguous block up
 * to the tip, with a missing slot below it (the checkpoint the block folds onto), and no
 * snapshot above the new tip. A segment below a later gap was compacted after the fix —
 * `superseded` — and a block reaching down to 0 would read as never compacted.
 */
function judge(
  id: string,
  segs: BlankStreamSegment[],
  own: readonly EventEnvelope[],
  latestSnapshot: number,
  stray: ReadonlyMap<number, EventEnvelope>,
  missing: Map<BlankStreamSegment, number[]>
): void {
  const at = new Map(own.map((e) => [e.sequence, e]));
  const present = new Set(at.keys());
  const open: Array<{ seg: BlankStreamSegment; empty: number[] }> = [];
  for (const seg of segs) {
    const empty: number[] = [];
    let foreign: EventEnvelope | undefined;
    for (let q = seg.fromSequence; q <= seg.throughSequence && foreign === undefined; q++) {
      const e = at.get(q);
      if (e === undefined) empty.push(q);
      else if (e.metadata?.[REHOMED_FROM_KEY] !== stray.get(q)?.id) foreign = e;
    }
    if (foreign !== undefined) {
      seg.status = "occupied";
      seg.detail = `${id}'s own log holds ${foreign.eventType} at ${foreign.sequence}`;
      continue;
    }
    for (const q of empty) present.add(q);
    open.push({ seg, empty });
  }
  if (open.length === 0) return;
  let tip = own[own.length - 1]?.sequence ?? -1;
  for (const { seg } of open) tip = Math.max(tip, seg.throughSequence);
  let low = tip;
  while (low >= 0 && present.has(low)) low--;
  const refuseAll = (status: BlankSegmentStatus, detail: string): void => {
    for (const { seg } of open) {
      seg.status = status;
      seg.detail = detail;
    }
  };
  if (low < 0) {
    const first = own.find((e) => e.sequence > 0 && e.metadata?.[REHOMED_FROM_KEY] === undefined);
    refuseAll(
      "occupied",
      `re-homing would leave ${id}'s log gap-free, which reads as never compacted${first !== undefined ? ` (its own log holds ${first.eventType} at ${first.sequence}, where the checkpoint's history belongs)` : ""}`
    );
    return;
  }
  if (latestSnapshot > tip) {
    refuseAll(
      "superseded",
      `${id} was compacted through its tip after the fix (a snapshot at ${latestSnapshot}); that checkpoint already folds these events`
    );
    return;
  }
  for (const { seg, empty } of open) {
    if (seg.fromSequence <= low) {
      seg.status = "superseded";
      seg.detail = `${id} was compacted again after the fix: its log has a gap at ${low}, above these events, and that checkpoint already folds them`;
    } else if (empty.length === 0) {
      seg.status = "rehomed";
    } else {
      missing.set(seg, empty);
    }
  }
}

/** The blank-stream event re-stamped into the execution that owns it. */
export function rehomedEnvelope(
  e: EventEnvelope,
  executionId: string,
  workflowId: string
): EventEnvelope {
  return {
    ...e,
    executionId,
    workflowId,
    id: `${executionId}-${e.sequence}`,
    metadata: { ...e.metadata, [REHOMED_FROM_KEY]: e.id },
  };
}
