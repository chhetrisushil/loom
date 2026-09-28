import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { foldEvents } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { anchorFor, reconstructAt, reconstructMany } from "./reconstruct";
import type { ReadOnlyEventStore } from "./types";
import { CompactedHistoryError, InspectorBudgetError } from "./types";

const EXEC = "exec-1";
const WF = "wf-1";

function envelope(sequence: number, eventType: string, payload: unknown): EventEnvelope {
  return {
    id: `${EXEC}-${sequence}`,
    workflowId: WF,
    executionId: EXEC,
    eventType,
    sequence,
    timestamp: 1_700_000_000_000 + sequence,
    payload,
  };
}

/** A log of `steps` complete steps, preceded by EXECUTION_STARTED. */
function buildLog(steps: number, flowHash?: string): EventEnvelope[] {
  const log: EventEnvelope[] = [
    envelope(0, "EXECUTION_STARTED", {
      input: { n: 1 },
      ...(flowHash !== undefined && { flowHash }),
    }),
  ];
  let seq = 1;
  for (let i = 0; i < steps; i++) {
    log.push(envelope(seq++, "STEP_STARTED", { stepId: `s${i}`, input: { i } }));
    log.push(envelope(seq++, "STEP_COMPLETED", { stepId: `s${i}`, output: { i, ok: true } }));
  }
  return log;
}

async function seed(store: InMemoryAsyncEventStore, log: EventEnvelope[]): Promise<void> {
  for (const e of log) await store.append(e);
}

describe("reconstructMany — correctness", () => {
  let events: InMemoryAsyncEventStore;
  let log: EventEnvelope[];

  beforeEach(async () => {
    events = new InMemoryAsyncEventStore();
    log = buildLog(5, "hash-v1");
    await seed(events, log);
  });

  it("reproduces the kernel fold exactly at every position", async () => {
    const positions = log.map((e) => e.sequence);
    const points = await reconstructMany(events, undefined, EXEC, positions);

    for (const point of points) {
      const expected = foldEvents(
        log.filter((e) => e.sequence <= point.position),
        { executionId: EXEC, workflowId: WF }
      );
      // Structural, not reference: a segment-wise fold and a one-shot fold produce
      // equal values with different array identities by construction (the ownership
      // reset in foldEvents guarantees fresh arrays). Asserting identity here would
      // fail on a correct implementation.
      expect(point.state).toEqual(expected);
    }
  });

  it("returns positions ascending, de-duplicated, regardless of input order", async () => {
    const points = await reconstructMany(events, undefined, EXEC, [7, 3, 7, 1]);
    expect(points.map((p) => p.position)).toEqual([1, 3, 7]);
  });

  it("returns the pre-start state for a position below the first event", async () => {
    const point = await reconstructAt(events, undefined, EXEC, -1);
    expect(point.state.status).toBe("pending");
    expect(point.foldedEvents).toBe(0);
  });

  it("is empty for an empty position list", async () => {
    expect(await reconstructMany(events, undefined, EXEC, [])).toEqual([]);
  });

  it("clamps a position beyond the end of the log to the final state", async () => {
    const last = (log[log.length - 1] as EventEnvelope).sequence;
    const beyond = await reconstructAt(events, undefined, EXEC, last + 1000);
    const atEnd = await reconstructAt(events, undefined, EXEC, last);
    expect(beyond.state).toEqual(atEnd.state);
  });
});

describe("reconstructMany — snapshot anchoring", () => {
  it("snapshot-anchored reconstruction equals reconstruction from zero, at every index", async () => {
    const events = new InMemoryAsyncEventStore();
    const log = buildLog(8, "hash-v1");
    await seed(events, log);

    const snapshots = new InMemoryAsyncSnapshotStore();
    const midpoint = 9;
    await snapshots.save({
      id: "snap-1",
      executionId: EXEC,
      workflowId: WF,
      sequence: midpoint,
      state: foldEvents(
        log.filter((e) => e.sequence <= midpoint),
        { executionId: EXEC, workflowId: WF }
      ),
      createdAt: 1,
    });

    for (const e of log) {
      const anchored = await reconstructAt(events, snapshots, EXEC, e.sequence);
      const fromZero = await reconstructAt(events, undefined, EXEC, e.sequence);
      expect(anchored.state).toEqual(fromZero.state);
    }
  });

  it("anchors before the FIRST requested position, not the last", async () => {
    const events = new InMemoryAsyncEventStore();
    await seed(events, buildLog(8));
    const snapshots = new InMemoryAsyncSnapshotStore();
    await snapshots.save({
      id: "s",
      executionId: EXEC,
      workflowId: WF,
      sequence: 9,
      state: foldEvents(
        buildLog(8).filter((e) => e.sequence <= 9),
        {
          executionId: EXEC,
          workflowId: WF,
        }
      ),
      createdAt: 1,
    });
    // Requesting [3, 15] must anchor at origin (3 < 9), else position 3 would be wrong.
    const [early] = await reconstructMany(events, snapshots, EXEC, [3, 15]);
    const fromZero = await reconstructAt(events, undefined, EXEC, 3);
    expect(early?.state).toEqual(fromZero.state);
  });

  it("does not mutate the snapshot held by the store", async () => {
    const events = new InMemoryAsyncEventStore();
    const log = buildLog(6);
    await seed(events, log);

    const snapshots = new InMemoryAsyncSnapshotStore();
    const state = foldEvents(
      log.filter((e) => e.sequence <= 5),
      {
        executionId: EXEC,
        workflowId: WF,
      }
    );
    await snapshots.save({
      id: "s",
      executionId: EXEC,
      workflowId: WF,
      sequence: 5,
      state,
      createdAt: 1,
    });
    // The in-memory store hands back the SAME object it stored — no clone. If the fold
    // mutated `initial` in place, repeated reconstruction would corrupt it.
    const before = structuredClone(state);
    await reconstructMany(events, snapshots, EXEC, [7, 9, 11]);
    await reconstructMany(events, snapshots, EXEC, [7, 9, 11]);
    const after = (await snapshots.loadLatestBefore(EXEC, 5))?.state;
    expect(after).toEqual(before);
  });

  it("reports which anchor a position would use", async () => {
    const snapshots = new InMemoryAsyncSnapshotStore();
    expect(await anchorFor(snapshots, EXEC, 10)).toEqual({ kind: "origin", sequence: -1 });
    await snapshots.save({
      id: "s",
      executionId: EXEC,
      workflowId: WF,
      sequence: 4,
      state: foldEvents([], { executionId: EXEC, workflowId: WF }),
      createdAt: 1,
    });
    expect(await anchorFor(snapshots, EXEC, 10)).toEqual({ kind: "snapshot", sequence: 4 });
    expect(await anchorFor(undefined, EXEC, 10)).toEqual({ kind: "origin", sequence: -1 });
  });
});

describe("reconstructMany — store contract and bounds", () => {
  it("works against a store that omits the optional readRange", async () => {
    const backing = new InMemoryAsyncEventStore();
    const log = buildLog(4);
    await seed(backing, log);
    // A conforming store MAY omit readRange; the fallback must produce the same answer.
    const narrowed: ReadOnlyEventStore = {
      read: (id) => backing.read(id),
      readFrom: (id, from) => backing.readFrom(id, from),
    };
    for (const e of log) {
      expect((await reconstructAt(narrowed, undefined, EXEC, e.sequence)).state).toEqual(
        (await reconstructAt(backing, undefined, EXEC, e.sequence)).state
      );
    }
  });

  it("refuses an over-budget read rather than truncating it", async () => {
    const events = new InMemoryAsyncEventStore();
    await seed(events, buildLog(20));
    await expect(
      reconstructAt(events, undefined, EXEC, 100, { maxEvents: 5 })
    ).rejects.toBeInstanceOf(InspectorBudgetError);
  });

  it("reads the log at most once regardless of how many positions are requested", async () => {
    const backing = new InMemoryAsyncEventStore();
    await seed(backing, buildLog(10));
    let rangeCalls = 0;
    let fromCalls = 0;
    const counted: ReadOnlyEventStore = {
      read: (id) => backing.read(id),
      readFrom: (id, from) => {
        fromCalls++;
        return backing.readFrom(id, from);
      },
      readRange: (id, from, to) => {
        rangeCalls++;
        return backing.readRange(id, from, to);
      },
    };
    const positions = Array.from({ length: 21 }, (_, i) => i);
    await reconstructMany(counted, undefined, EXEC, positions);
    expect(rangeCalls + fromCalls).toBe(1);
  });

  it("folds each event exactly once across many positions", async () => {
    const events = new InMemoryAsyncEventStore();
    const log = buildLog(10);
    await seed(events, log);
    const positions = log.map((e) => e.sequence);
    const points = await reconstructMany(events, undefined, EXEC, positions);
    // foldedEvents is cumulative from the anchor; the last equals the log length, which
    // is only true if no event was folded twice.
    expect(points[points.length - 1]?.foldedEvents).toBe(log.length);
  });
});

describe("reconstructMany — fidelity to the kernel's skip behaviour (IX-2)", () => {
  it("skips unrecognized event kinds exactly as foldEvents does", async () => {
    const events = new InMemoryAsyncEventStore();
    const log = buildLog(2);
    // An event kind no fold handler knows — what a v1 binary sees in a v2-written log.
    log.push(envelope(5, "TOTALLY_UNKNOWN_KIND_V2", { anything: true }));
    log.push(envelope(6, "STEP_STARTED", { stepId: "s9", input: {} }));
    await seed(events, log);

    const inspector = await reconstructAt(events, undefined, EXEC, 6);
    const kernel = foldEvents(log, { executionId: EXEC, workflowId: WF });
    expect(inspector.state).toEqual(kernel);
    // Sequence still advances across the skipped event — the inspector must not
    // "helpfully" error where the kernel silently continues.
    expect(inspector.state.sequence).toBe(6);
  });
});

describe("ADR 0106 — compacted history", () => {
  // buildLog(3): 0 start, 1..6 steps. A FINDING is appended at 7, then 8..9 another step.
  // Compaction (pinned FINDING) checkpoints at 8 and keeps 7 in place: [0, 7, 9].
  async function compacted() {
    const log = [
      ...buildLog(3),
      envelope(7, "FINDING_RECORDED", { f: 1 }),
      envelope(8, "STEP_STARTED", { stepId: "s3", input: { i: 3 } }),
      envelope(9, "STEP_COMPLETED", { stepId: "s3", output: { i: 3, ok: true } }),
    ];
    const events = new InMemoryAsyncEventStore();
    await seed(events, log);
    const snapshots = new InMemoryAsyncSnapshotStore();
    const full = (at: number) =>
      foldEvents(
        log.filter((e) => e.sequence <= at),
        { executionId: EXEC, workflowId: WF }
      );
    await snapshots.save({
      id: "cp",
      executionId: EXEC,
      workflowId: WF,
      sequence: 8,
      state: full(8),
      createdAt: 0,
    });
    await events.truncatePrefixKeeping(EXEC, 8, ["FINDING_RECORDED"]);
    expect((await events.read(EXEC)).map((e) => e.sequence)).toEqual([0, 7, 9]);
    return { events, snapshots, full };
  }

  it("refuses a position inside compacted history — including a kept event below the checkpoint", async () => {
    const { events, snapshots } = await compacted();
    await expect(reconstructAt(events, snapshots, EXEC, 7)).rejects.toThrow(CompactedHistoryError);
    await expect(reconstructAt(events, snapshots, EXEC, 3)).rejects.toThrow(CompactedHistoryError);
  });

  it("reconstructs positions at and above the checkpoint, and below the first gap", async () => {
    const { events, snapshots, full } = await compacted();
    const points = await reconstructMany(events, snapshots, EXEC, [0, 8, 9]);
    expect(points.map((p) => p.position)).toEqual([0, 8, 9]);
    expect(points[0]!.state).toEqual(full(0));
    expect(points[1]!.state).toEqual(full(8));
    expect(points[2]!.state).toEqual(full(9));
  });

  it("a batch spanning compacted history is refused, not partially guessed", async () => {
    const { events, snapshots } = await compacted();
    await expect(reconstructMany(events, snapshots, EXEC, [0, 5, 9])).rejects.toThrow(
      CompactedHistoryError
    );
  });

  it("finds a hole ending the segment with one head read, never the tail", async () => {
    const { events, snapshots } = await compacted();
    let tailReads = 0;
    const probing = {
      read: events.read.bind(events),
      readRange: events.readRange.bind(events),
      head: events.head.bind(events),
      readFrom: (id: string, from: number) => {
        tailReads++;
        return events.readFrom(id, from);
      },
    };
    await expect(reconstructAt(probing, snapshots, EXEC, 3)).rejects.toThrow(CompactedHistoryError);
    expect(tailReads).toBe(0);
    // Past the tip is not a hole.
    expect((await reconstructAt(probing, snapshots, EXEC, 50)).position).toBe(50);
  });
});
