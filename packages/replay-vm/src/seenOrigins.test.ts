import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventEnvelope, ExecutionState } from "@loomwork/core";
import { describe, expect, it } from "vitest";
import { foldEvents, normalizeSnapshotState } from "./foldEvents";
import { SEEN_ORIGINS_KEY, carrySeenOrigins } from "./seenOrigins";

// ADR 0152 D1 (R11), the FOLD side: the fold unions the origins the journal RECORDED on an event's metadata,
// advances `through`, never opens a payload. Records are written by hand here; the writer is seenOriginsRecord.test.ts.

const K = { kernel: true };
const STAMP = { maxOrigins: 64, maxScanNodes: 10_000 };
type Raw = { eventType: string; payload: unknown; metadata?: Record<string, unknown> };
const env = (sequence: number, r: Raw, metadata?: Record<string, unknown>): EventEnvelope => ({
  id: `x-${sequence}`,
  workflowId: "wf",
  executionId: "x",
  eventType: r.eventType,
  sequence,
  timestamp: 1000 + sequence,
  payload: r.payload,
  ...((metadata ?? r.metadata) !== undefined && { metadata: metadata ?? r.metadata }),
});
const start = (extra: Record<string, unknown> = {}, input: unknown = {}): Raw => ({
  eventType: "EXECUTION_STARTED",
  payload: { input, seenOriginsLimits: STAMP, ...extra },
  metadata: { origins: [] }, // R13: a tracked run records on every channel event, empty when clean
});
const completed = (output: unknown = 1, stepId = "s"): Raw => ({
  eventType: "STEP_COMPLETED",
  payload: { stepId, output },
});
/** A STEP_COMPLETED whose commit recorded `origins`. */
const rec = (origins: string[], overflow = false): Raw => ({
  ...completed(),
  metadata: overflow ? { originsOverflow: true } : { origins },
});
const fold = (raws: Raw[], initial?: Partial<ExecutionState>, from = 0): ExecutionState =>
  foldEvents(
    raws.map((r, i) => env(from + i, r)),
    initial
  );
const keyOf = (s: Partial<ExecutionState>) =>
  s.variables?.[SEEN_ORIGINS_KEY] as
    | { origins: string[]; overflow?: true; through?: number; limits: typeof STAMP }
    | undefined;

describe("R13: no record on a channel event of a tracked run is overflow (fail closed)", () => {
  const CHANNELS = [
    "STEP_COMPLETED",
    "MESSAGE_CONSUMED",
    "EXECUTION_RESUMED",
    "DECISION_RECORDED",
    "STEP_FAILED",
    "PARALLEL_COMPLETED",
    "EXECUTION_MIGRATED",
  ];
  it.each(CHANNELS)("%s with no metadata (a 1.26 writer / an unwired commit path)", (t) => {
    const k = keyOf(fold([start(), { eventType: t, payload: {} }]));
    expect(k?.overflow).toBe(true);
    expect(k?.through).toBe(1);
  });
  it("metadata with neither origins nor originsOverflow (only kernel/fence stamps), or a non-array origins", () => {
    expect(keyOf(fold([start(), { ...completed(), metadata: { kernel: true } }]))?.overflow).toBe(
      true
    );
    expect(keyOf(fold([start(), { ...completed(), metadata: { origins: "x" } }]))?.overflow).toBe(
      true
    );
  });
  it("a start with the stamp but no record also fails closed; a non-channel event never needs one", () => {
    expect(
      keyOf(fold([{ eventType: "EXECUTION_STARTED", payload: start().payload }]))?.overflow
    ).toBe(true);
    expect(
      keyOf(fold([start(), { eventType: "STEP_STARTED", payload: { stepId: "a" } }]))?.overflow
    ).toBeUndefined();
  });
  it("a tainted STEP_COMPLETED appended with no metadata folds to overflow, not clean", () => {
    const tainted = { __loomTainted: { origin: "peer:x" }, value: 1 };
    const k = keyOf(fold([start(), completed(tainted)]));
    expect(k?.origins).toEqual([]);
    expect(k?.overflow).toBe(true);
  });
  it("m-4: a key not advanced to the prior sequence is unproven overflow even without normalize", () => {
    const s0 = fold([start(), rec(["a"])]);
    const stale = { ...s0, sequence: s0.sequence + 3 }; // a 1.26 fold advanced the sequence, left through behind
    const k = keyOf(foldEvents([env(9, rec(["b"]))], stale));
    expect(k?.overflow).toBe(true);
    expect(k?.through).toBeUndefined();
    expect(k?.origins).toEqual(["a"]);
  });
});

describe("the fold unions RECORDED lists", () => {
  const CHANNEL_TYPES = [
    "STEP_COMPLETED",
    "MESSAGE_CONSUMED",
    "EXECUTION_RESUMED",
    "DECISION_RECORDED",
    "STEP_FAILED",
    "PARALLEL_COMPLETED",
    "EXECUTION_MIGRATED",
  ];
  it("every channel event type contributes its recorded origins, in first-seen order, and through follows", () => {
    const raws: Raw[] = [
      start(),
      ...CHANNEL_TYPES.map((t, i) => ({
        eventType: t,
        payload: {},
        metadata: { origins: [`o${i}`, "shared"] },
      })),
    ];
    const k = keyOf(fold(raws));
    expect(k?.origins).toEqual([
      "o0",
      "shared",
      ...CHANNEL_TYPES.slice(1).map((_, i) => `o${i + 1}`),
    ]);
    expect(k?.through).toBe(CHANNEL_TYPES.length);
  });
  it("the start's own record (its input) is folded after the key is seeded", () => {
    expect(keyOf(fold([{ ...start(), metadata: { origins: ["in"] } }]))).toMatchObject({
      origins: ["in"],
      through: 0,
    });
  });
  it("a record on a non-channel event, or in a payload key, is ignored; junk entries are dropped", () => {
    const s = fold([start()]);
    expect(
      keyOf(foldEvents([env(1, { eventType: "APP_EVENT", payload: {} }, { origins: ["f"] })], s))
        ?.origins
    ).toEqual([]);
    expect(keyOf(foldEvents([env(1, completed({ origins: ["f"] }))], s))?.origins).toEqual([]);
    expect(
      keyOf(foldEvents([env(1, completed(), { origins: [1, null, "ok"] })], s))?.origins
    ).toEqual(["ok"]);
  });
  it("originsOverflow is sticky; the maxOrigins+1th distinct origin overflows and is dropped; later records are ignored", () => {
    const small = { ...STAMP, maxOrigins: 2 };
    const a = fold([
      {
        eventType: "EXECUTION_STARTED",
        payload: { input: {}, seenOriginsLimits: small },
        metadata: { origins: [] },
      },
      rec(["a", "b"]),
      rec(["c"]),
      rec(["a"]),
    ]);
    expect(keyOf(a)).toMatchObject({ origins: ["a", "b"], overflow: true, through: 3 });
    const b = fold([start(), rec([], true), rec(["x"])]);
    expect(keyOf(b)).toMatchObject({ origins: [], overflow: true, through: 2 });
  });
  it("a clean tracked run has the key with origins [] (distinct from an untracked run)", () => {
    expect(keyOf(fold([start(), rec([])]))).toEqual({
      v: 1,
      limits: STAMP,
      origins: [],
      through: 1,
    });
  });
  it("invalid recorded limits fall back to the defaults, per field; limits survive a snapshot", () => {
    const bad = fold([
      {
        eventType: "EXECUTION_STARTED",
        payload: { input: {}, seenOriginsLimits: { maxOrigins: 0, maxScanNodes: 500 } },
      },
    ]);
    expect(keyOf(bad)?.limits).toEqual({ maxOrigins: 64, maxScanNodes: 500 });
    const small = { maxOrigins: 1, maxScanNodes: 100 };
    const a = fold([
      {
        eventType: "EXECUTION_STARTED",
        payload: { input: {}, seenOriginsLimits: small },
        metadata: { origins: [] },
      },
      rec(["a"]),
    ]);
    const snap = normalizeSnapshotState(JSON.parse(JSON.stringify(a)) as ExecutionState);
    expect(keyOf(fold([rec(["b"])], snap, 2))).toMatchObject({
      origins: ["a"],
      overflow: true,
      limits: small,
    });
  });
  it("the recorded list is the source: live, JSON replay, key-reversed replay and snapshot+tail agree", () => {
    const raws: Raw[] = [
      start(),
      { ...rec(["z", "a"]), payload: { stepId: "s", output: { b: 1, a: 2 } } },
      rec(["m"]),
    ];
    const log = raws.map((r, i) => env(i, r));
    const reverse = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverse)
        : v !== null && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v)
                .reverse()
                .map(([k, x]) => [k, reverse(x)])
            )
          : v;
    const j = (s: ExecutionState) => JSON.stringify(keyOf(s));
    const live = foldEvents(log);
    const snap = normalizeSnapshotState(
      JSON.parse(JSON.stringify(foldEvents(log.slice(0, 2)))) as ExecutionState
    );
    expect(j(foldEvents(JSON.parse(JSON.stringify(log))))).toBe(j(live));
    expect(j(foldEvents(log.map((e) => reverse(e) as EventEnvelope)))).toBe(j(live));
    expect(j(foldEvents(log.slice(2), snap))).toBe(j(live));
    expect(keyOf(live)?.origins).toEqual(["z", "a", "m"]);
  });
});

describe("inert: no stamp, no carried set", () => {
  const dir = join(__dirname, "__golden__");
  const log = JSON.parse(readFileSync(join(dir, "inertLog.json"), "utf8")) as EventEnvelope[];
  // The golden was produced by the 1.26.0 fold (before this module existed) over a log with taint on every channel and
  // even forged `metadata.origins` / `originsOverflow`: with no tracking, none of it may change a byte.
  it("folds byte-identically to the 1.26.0 fold", () => {
    const golden = readFileSync(join(dir, "inertFold.golden.json"), "utf8");
    // compact stringify keeps key ORDER, so this is a byte comparison of the fold output
    expect(JSON.stringify(foldEvents(log))).toBe(JSON.stringify(JSON.parse(golden)));
    expect(foldEvents(log).variables[SEEN_ORIGINS_KEY]).toBeUndefined();
  });
});

describe("carry and fork (stamp AND continuedFrom AND no carried set gives overflow)", () => {
  const chain = { chainId: "c", generation: 1 };
  const succ = (carried: unknown, stamp = true) =>
    keyOf(
      foldEvents([
        env(
          0,
          {
            eventType: "EXECUTION_STARTED",
            payload: {
              input: {},
              ...chain,
              continuedFrom: { executionId: "c~0", ...(carried !== undefined && { carried }) },
              ...(stamp && { seenOriginsLimits: STAMP }),
            },
          },
          undefined
        ),
      ])
    );
  it("a carried set seeds the successor (and the overflow marker is carried)", () => {
    expect(succ({ seenOrigins: { origins: ["a", "b"] } })).toMatchObject({
      origins: ["a", "b"],
      through: 0,
    });
    expect(succ({ seenOrigins: { origins: ["a"], overflow: true } })?.overflow).toBe(true);
    expect(succ({ seenOrigins: { origins: ["a"] } }, false)?.origins).toEqual(["a"]); // carry alone tracks
  });
  it("a stamped successor with no (or an invalid) carried set is overflow", () => {
    expect(succ({})?.overflow).toBe(true);
    expect(succ(undefined)?.overflow).toBe(true);
    expect(succ({ seenOrigins: "junk" })?.overflow).toBe(true);
    expect(succ({ seenOrigins: { origins: "junk" } })?.overflow).toBe(true);
  });
  it("an over-long carried list is capped to maxOrigins with overflow; over-long labels are truncated", () => {
    const k = succ({ seenOrigins: { origins: Array.from({ length: 70 }, (_, i) => `o${i}`) } });
    expect(k?.origins).toHaveLength(64);
    expect(k?.overflow).toBe(true);
    expect(succ({ seenOrigins: { origins: ["x".repeat(300)] } })?.origins[0]).toMatch(
      /^unknown:truncated:/
    );
  });
  it("a stamped run with no continuedFrom starts clean; unstamped and uncarried stays untracked", () => {
    expect(keyOf(foldEvents([env(0, start(), undefined)]))).toMatchObject({
      origins: [],
      through: 0,
    });
    expect(
      keyOf(
        foldEvents([env(0, { eventType: "EXECUTION_STARTED", payload: { input: {} } }, undefined)])
      )
    ).toBeUndefined();
  });
  it("a fork of a chain member follows forkResources (carried set kept, else overflow)", () => {
    const fork = (carried: unknown) =>
      keyOf(
        foldEvents([
          env(
            0,
            {
              eventType: "EXECUTION_STARTED",
              payload: {
                input: {},
                continuedFrom: { executionId: "c~0", ...(carried !== undefined && { carried }) },
                seenOriginsLimits: STAMP,
              },
            },
            { forkChain: chain }
          ),
        ])
      );
    expect(fork({ seenOrigins: { origins: ["p"] } })).toMatchObject({ origins: ["p"] });
    expect(fork({})?.overflow).toBe(true);
  });
  it("carrySeenOrigins: untracked carries nothing; tracked carries set and marker; stale carries overflow", () => {
    expect(
      carrySeenOrigins(
        foldEvents([env(0, { eventType: "EXECUTION_STARTED", payload: {} }, undefined)])
      )
    ).toBeUndefined();
    const state = fold([start(), rec(["a"])]);
    expect(carrySeenOrigins(state)).toEqual({ origins: ["a"] });
    expect(carrySeenOrigins({ ...state, sequence: state.sequence + 3 })).toEqual({
      origins: ["a"],
      overflow: true,
    });
  });
});

describe("staleness inside normalizeSnapshotState", () => {
  const healthy = fold([start(), rec(["a"]), rec(["b"])]);
  it("a healthy key is returned as the same object", () => {
    expect(normalizeSnapshotState(healthy)).toBe(healthy);
  });
  it("a mid-batch snapshot (snapshot.sequence below state.sequence) is NOT flagged: through === state.sequence", () => {
    const snapshot = { sequence: 1, state: healthy }; // commitAtomic folded the batch to 2 before maybeSnapshot saved the state
    expect(snapshot.sequence).toBeLessThan(snapshot.state.sequence);
    expect(normalizeSnapshotState(snapshot.state)).toBe(healthy);
  });
  it("a 1.26-style copy (sequence advanced, through left behind) reads as overflow with through dropped, origins kept", () => {
    const stale = { ...healthy, sequence: healthy.sequence + 2 };
    const out = normalizeSnapshotState(stale);
    const k = keyOf(out);
    expect(k?.overflow).toBe(true);
    expect(k?.through).toBeUndefined();
    expect(k?.origins).toEqual(["a", "b"]);
  });
  it("an unproven (through-less) key stays overflow and is not re-validated by the fold; idempotent", () => {
    const stale = normalizeSnapshotState({ ...healthy, sequence: 99 });
    expect(normalizeSnapshotState(stale)).toBe(stale);
    const after = foldEvents([env(100, completed(), { origins: ["c"] })], stale);
    expect(keyOf(after)?.through).toBeUndefined();
    expect(keyOf(after)?.overflow).toBe(true);
  });
  it("an absent key stays absent", () => {
    const s = foldEvents([env(0, { eventType: "EXECUTION_STARTED", payload: {} }, undefined)]);
    expect(normalizeSnapshotState(s).variables[SEEN_ORIGINS_KEY]).toBeUndefined();
  });
  it("a malformed key fails closed", () => {
    const bad = { ...healthy, variables: { ...healthy.variables, [SEEN_ORIGINS_KEY]: "junk" } };
    expect(keyOf(normalizeSnapshotState(bad))?.overflow).toBe(true);
  });
});
