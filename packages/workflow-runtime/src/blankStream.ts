import { canonicalJson } from "@loom/core";
import type { EventEnvelope, ExecutionState } from "@loom/core";
import {
  type EventStore,
  headOf,
  isReservedStream,
  iterateExecutionIds,
  readRangeOf,
} from "@loom/event-runtime";
import { ReplayVM, normalizeSnapshotState } from "@loom/replay-vm";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";
import { TIMER_FIRED } from "./types";

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
//  1. X has snapshots at `b` and at `S` whose states BOTH carry the blank identity. Only a run
//     seeded from a pre-0106 checkpoint writes one, and that run's journal wrote to `""`. A
//     pre-0106 COMPACTION checkpoint is blank too, but its base is the runtime's own (named)
//     snapshot, so requiring a blank base keeps a checkpoint from claiming a stretch of `""`
//     some other execution wrote.
//  2. The snapshot at `S` is suspended or terminal: the runtime's suspend and settle
//     checkpoints, taken after a drain barrier. This is a filter, not the proof. A pre-0106
//     cadence checkpoint fired on COMMIT, before its event was durable, and one landing on a
//     suspend has the same status.
//  3. The blank stream holds every sequence in `(b, S]`, and
//  4. folding those events onto `b` reproduces `S` exactly (canonical JSON, identity aside).
//     This is the proof. It covers every timestamp and payload the fold records. When a
//     blank running (cadence) snapshot sits between two such snapshots, the base walks down
//     across it only while the fold reproduces it too.
// Two executions proving one slot are a `conflict`, and neither is touched. What stays
// unproven: two executions whose events are identical in every field the fold reads, where
// one of them has no snapshot of its own. Re-homing then gives X the history its snapshot
// already claims.
//
// **Not provable.** Events above X's LAST such snapshot: a run that completed without a
// checkpoint (the default cadence takes none), or crashed. Nothing that survives names their
// writer, and several executions can sit at the same sequence. The census lists them with the
// executions that could have written them. An operator who knows the owner assigns them
// explicitly (proof "operator"), and the repair still checks the assignment: the seed at
// `from − 1` must be a blank snapshot of X, suspended, with nothing of X's above it, and the
// range must open with the resume answering that gate. It never guesses.

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
  /**
   * The blank stream's events still carry ciphertext as this store read them: it is the raw
   * store under an encrypting one, which cannot decrypt them. Copying them into an execution
   * would plant ciphertext under the wrong key, so a repair refuses to apply. Run it through
   * the app's own (encrypting) stores.
   */
  ciphertext: boolean;
  /**
   * The blank stream's events carry `{ $shredded: true }` placeholders: a tolerant encrypting
   * store whose key for subject `""` is gone. Their payloads are unrecoverable, and copying the
   * placeholders into an execution would record a fabricated history, so a repair refuses to
   * apply.
   */
  shredded: boolean;
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
  /** Per execution with segments to apply, its log's tip when planned (re-checked at apply). */
  tipOf: ReadonlyMap<string, number>;
}

/** The metadata key a re-homed event carries: the id it had in the blank stream. */
export const REHOMED_FROM_KEY = "rehomedFrom";

const DRAINED = new Set<ExecutionState["status"]>([
  "suspended",
  "completed",
  "failed",
  "cancelled",
  "continued",
]);

const isBlank = (s: Snapshot): boolean => s.state.executionId === "";

const statusOf = (s: Snapshot): ExecutionState["status"] => normalizeSnapshotState(s.state).status;

/**
 * Whether `v` holds an object with `key` anywhere: the field-level ciphertext envelope
 * `@loom/plugin-crypto` writes (`__loomEnc`), or the placeholder a tolerant read leaves for a
 * destroyed key (`$shredded`).
 */
function carriesKey(v: unknown, key: "__loomEnc" | "$shredded"): boolean {
  const stack: unknown[] = [v];
  // Bounded: a payload is plain JSON, and the walk is iterative, so depth cannot blow the stack.
  for (let budget = 100_000; stack.length > 0 && budget > 0; budget--) {
    const x = stack.pop();
    if (typeof x !== "object" || x === null) continue;
    if ((x as Record<string, unknown>)[key] !== undefined) return true;
    for (const child of Object.values(x)) stack.push(child);
  }
  return false;
}

/**
 * Kernel facts a resume records BEFORE its answer: a verified approval, a discarded legacy
 * answer, a `resumeAs` migration.
 */
const RESUME_PREFIX = new Set(["APPROVAL_GRANTED", "DECISION_RECORDED", "EXECUTION_MIGRATED"]);

/**
 * Why `events` does NOT open with a resume that answers the park `seed` records, or
 * `undefined` when it does. What a pre-0106 resume wrote, in order: optional prefix facts
 * (`RESUME_PREFIX`), the answer, an in-doubt verdict (`DECISION_RECORDED`) only when the park
 * is in doubt, then `EXECUTION_RESUMED`. The answer is the event the park waits on
 * (`suspendedOn.on`, which is `EffectInDoubtResolved` for an in-doubt park), or `TIMER_FIRED`
 * carrying exactly the park's recorded `wakeAt`.
 */
function answersPark(seed: ExecutionState, events: readonly EventEnvelope[]): string | undefined {
  const park = seed.status === "suspended" ? seed.suspendedOn : undefined;
  if (park === undefined) return "it is not parked at a gate";
  let i = 0;
  while (i < events.length && RESUME_PREFIX.has(events[i]!.eventType)) i++;
  const answer = events[i];
  const wakeAt = (answer?.payload as { wakeAt?: unknown } | null | undefined)?.wakeAt;
  const answers =
    answer !== undefined &&
    (answer.eventType === park.on ||
      (answer.eventType === TIMER_FIRED && park.wakeAt !== undefined && wakeAt === park.wakeAt));
  const expected = `"${park.on}"${park.wakeAt !== undefined ? ` or ${TIMER_FIRED} at ${park.wakeAt}` : ""}`;
  if (!answers) {
    return `the range must open with the resume answering its gate (${expected}); it opens with ${answer?.eventType ?? "nothing"}`;
  }
  let j = i + 1;
  if (park.on === "EffectInDoubtResolved" && events[j]?.eventType === "DECISION_RECORDED") j++;
  if (events[j]?.eventType !== "EXECUTION_RESUMED") {
    return `the answer to ${expected} is not followed by EXECUTION_RESUMED, as every resume records it`;
  }
  return undefined;
}

/**
 * X's snapshot at exactly `sequence`, preferring a blank one. A pre-0106 compaction checkpoint
 * and the runtime's own suspend snapshot can share a sequence, and which of the two a
 * `loadLatestBefore` returns is the store's tie-break.
 */
async function preferBlank(
  snapshotStore: SnapshotStore,
  id: string,
  s: Snapshot
): Promise<Snapshot> {
  if (isBlank(s)) return s;
  const other = await snapshotStore.loadAt(id, s.sequence);
  return other !== null && isBlank(other) ? other : s;
}

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
    ciphertext: strayEvents.some((e) => carriesKey(e.payload, "__loomEnc")),
    shredded: strayEvents.some((e) => carriesKey(e.payload, "$shredded")),
  };
  const missing = new Map<BlankStreamSegment, number[]>();
  const workflowIdOf = new Map<string, string>();
  const tipOf = new Map<string, number>();
  if (strayEvents.length === 0 && assign.length === 0) {
    return { census, stray, missing, workflowIdOf, tipOf };
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
      chain.push(await preferBlank(snapshotStore, id, s));
    }
    if (!chain.some(isBlank)) continue;
    census.affected.push(id);
    for (const s of chain) {
      if (!isBlank(s)) continue;
      const at = blankAt.get(s.sequence);
      if (at === undefined) blankAt.set(s.sequence, [id]);
      else at.push(id);
    }
    const reproduces = (base: Snapshot, top: Snapshot): boolean => {
      const events = strayRange(stray, base.sequence + 1, top.sequence);
      return events !== null && foldReproduces(base, events, top);
    };
    for (let i = chain.length - 2; i >= 0; i--) {
      const top = chain[i]!;
      if (!isBlank(top) || !DRAINED.has(statusOf(top))) continue;
      let j = i + 1;
      if (!isBlank(chain[j]!) || !reproduces(chain[j]!, top)) continue;
      // A blank RUNNING snapshot below is a cadence checkpoint inside the same run: walk the
      // base down across it while the stream stays contiguous and the fold reproduces it too.
      while (
        j + 1 < chain.length &&
        !DRAINED.has(statusOf(chain[j]!)) &&
        isBlank(chain[j + 1]!) &&
        reproduces(chain[j + 1]!, chain[j]!)
      ) {
        j++;
      }
      census.segments.push({
        executionId: id,
        fromSequence: chain[j]!.sequence + 1,
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
    tipOf.set(id, own[own.length - 1]?.sequence ?? -1);
    const latest = await snapshotStore.loadLatest(id);
    judge(id, segs, own, latest?.sequence ?? -1, stray, missing);
  }

  // What nothing covers, as contiguous runs.
  const covered = new Set<number>();
  for (const seg of census.segments) {
    if (seg.status === "conflict" || seg.status === "invalid") continue;
    for (let q = seg.fromSequence; q <= seg.throughSequence; q++) covered.add(q);
  }
  const runs: UnattributedRun[] = [];
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
      runs.push(run);
    }
  }
  // An operator-assigned range an earlier run re-homed is no proof's, so it reaches here. It is
  // not unattributed: a candidate's log holds every slot's `rehomedFrom` twin. It is reported as
  // the `rehomed` operator segment it is, and only the rest of the run stays listed.
  for (const r of runs) {
    const rest = await recogniseRehomed(eventStore, stray, r, blankAt, census.segments);
    if (rest !== undefined) census.unattributed.push(rest);
  }
  census.segments.sort(
    (a, b) => a.fromSequence - b.fromSequence || a.executionId.localeCompare(b.executionId)
  );
  return { census, stray, missing, workflowIdOf, tipOf };
}

/**
 * The part of an unattributed run left after a leading stretch some candidate already holds as
 * re-homed twins (pushed onto `segments` as a `rehomed` operator segment), or `undefined` when
 * the whole run is accounted for. One log range read per candidate.
 */
async function recogniseRehomed(
  eventStore: EventStore,
  stray: ReadonlyMap<number, EventEnvelope>,
  run: UnattributedRun,
  blankAt: ReadonlyMap<number, string[]>,
  segments: BlankStreamSegment[]
): Promise<UnattributedRun | undefined> {
  for (const candidate of run.candidates) {
    const own = await readRangeOf(eventStore, candidate, run.fromSequence, run.throughSequence);
    let through = run.fromSequence - 1;
    for (const e of own) {
      if (
        e.sequence !== through + 1 ||
        e.metadata?.[REHOMED_FROM_KEY] !== stray.get(e.sequence)?.id
      ) {
        break;
      }
      through = e.sequence;
    }
    if (through < run.fromSequence) continue;
    segments.push({
      executionId: candidate,
      fromSequence: run.fromSequence,
      throughSequence: through,
      proof: "operator",
      status: "rehomed",
    });
    if (through === run.throughSequence) return undefined;
    return {
      fromSequence: through + 1,
      throughSequence: run.throughSequence,
      eventTypes: run.eventTypes.slice(through + 1 - run.fromSequence),
      candidates: blankAt.get(through) ?? [],
    };
  }
  return run;
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
  // The run that wrote the range resumed from a pre-0106 checkpoint of THIS execution: a blank
  // snapshot of X at exactly `from − 1`. A healthy execution — even one compacted after the
  // fix — has none, so an assignment can never graft a stray run onto it.
  const found = await snapshotStore.loadLatestBefore(a.executionId, a.fromSequence - 1);
  const seed =
    found !== null && found.sequence === a.fromSequence - 1
      ? await preferBlank(snapshotStore, a.executionId, found)
      : null;
  if (seed === null || !isBlank(seed)) {
    return refuse(
      `${a.executionId} has no pre-0106 (blank) snapshot at ${a.fromSequence - 1}, so no run of it resumed into "" from there`
    );
  }
  const latest = await snapshotStore.loadLatest(a.executionId);
  if (latest !== null && latest.sequence > seed.sequence) {
    return refuse(
      `${a.executionId} has moved past ${seed.sequence} (a snapshot at ${latest.sequence}), so this range is a continuation it abandoned, not its history`
    );
  }
  const seedState = normalizeSnapshotState(seed.state);
  const unanswered = answersPark(seedState, events);
  if (unanswered !== undefined) {
    return refuse(`${a.executionId} at ${seed.sequence}: ${unanswered}`);
  }
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
  workflowId: string,
  fence?: number
): EventEnvelope {
  return {
    ...e,
    executionId,
    workflowId,
    id: `${executionId}-${e.sequence}`,
    metadata: {
      ...e.metadata,
      [REHOMED_FROM_KEY]: e.id,
      ...(fence !== undefined && { fence }),
    },
  };
}
