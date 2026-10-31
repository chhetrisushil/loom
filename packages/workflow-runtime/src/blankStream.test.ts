import { step$ } from "@loom/core";
import type { EventEnvelope, ExecutionState, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import {
  DuplicateSequenceError,
  type EventStore,
  InMemoryAsyncEventStore,
  headOf,
} from "@loom/event-runtime";
import {
  EncryptingEventStore,
  InMemoryKeyStore,
  encryptValue,
  mapPaths,
} from "@loom/plugin-crypto";
import { ReplayVM } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BlankStreamUnrepairedError, LIFECYCLE_STREAM, LogLifecycle } from "./LogLifecycle";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { WorkflowRuntimeDeps } from "./WorkflowRuntime";
import { REHOMED_FROM_KEY } from "./blankStream";
import type { FlowRunner } from "./types";

// ADR 0107 (B) — the events the pre-0106 compaction bug wrote to execution "". A resume folded
// on a blank checkpoint journaled under the blank identity: its events landed in "" at the
// sequences its own execution would have used, while the runtime saved its suspend snapshot
// under the REAL id, with the blank state. `pre0106` rebuilds exactly that store image (the
// envelopes as the old journal stamped them: executionId/workflowId "", id `-<sequence>`, no
// metadata), which a probe against the pre-fix build (d625781) confirmed.

const io = z.object({ n: z.number() });
const s1 = step$({ id: "s1", name: "s1", toolId: "t1", inputSchema: io, outputSchema: io });
const s2 = step$({ id: "s2", name: "s2", toolId: "t2", inputSchema: io, outputSchema: io });
const s3 = step$({ id: "s3", name: "s3", toolId: "t3", inputSchema: io, outputSchema: io });
const FLOW = "blank-stream";

const definition: FlowDefinition<{ n: number }, { n: number }> = {
  _tag: "FlowDefinition",
  id: FLOW,
  name: FLOW,
  version: "1.0.0",
  inputSchema: io,
  outputSchema: io,
  steps: [s1, s2, s3],
};

const runner: FlowRunner<{ n: number }, { n: number }> = async (ctx, input) => {
  const a = await ctx.run(s1, input);
  await ctx.suspend({ on: "go1" });
  const b = await ctx.run(s2, a);
  await ctx.suspend({ on: "go2" });
  const c = await ctx.run(s3, b);
  return { n: c.n };
};

function boot(
  wrap?: (raw: InMemoryAsyncEventStore) => EventStore,
  extra: Partial<WorkflowRuntimeDeps> = {}
) {
  const effects = new EffectRuntime();
  for (const id of ["t1", "t2", "t3"]) {
    effects.register(id, new ToolEffect(async (x: { n: number }) => ({ n: x.n + 1 })));
  }
  const raw = new InMemoryAsyncEventStore();
  const eventStore = wrap?.(raw) ?? raw;
  const snapshotStore = new InMemoryAsyncSnapshotStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore,
    effectRuntime: effects,
    now: () => 1_000,
    onWarn: () => {},
    allowPlaintextCheckpoints: true, // ADR 0130 D8: not under test here
    ...extra,
  });
  runtime.registerFlow(definition, runner);
  return {
    runtime,
    eventStore,
    raw,
    snapshotStore,
    life: new LogLifecycle(eventStore, snapshotStore),
  };
}
type App = ReturnType<typeof boot>;

const blank = (s: ExecutionState): ExecutionState => ({
  ...s,
  executionId: "",
  workflowId: "",
  workflowVersion: "",
});

/** The uncompacted history of one execution with input `n`: its log and its gate tips. */
async function history(n: number) {
  const app = boot();
  const h = await app.runtime.start({ definition, runner }, { n }, { executionId: "x" });
  await h.waitForSuspend();
  const gate1 = (await headOf(app.eventStore, "x"))!;
  await (await app.runtime.resume("x", { eventType: "go1", payload: { n } })).waitForSuspend();
  const gate2 = (await headOf(app.eventStore, "x"))!;
  await (await app.runtime.resume("x", { eventType: "go2", payload: { n } })).waitForCompletion();
  const log = await app.eventStore.read("x");
  const at = (q: number) => new ReplayVM(log.filter((e) => e.sequence <= q)).getState();
  return { log, gate1, gate2, done: log[log.length - 1]!.sequence, at };
}
type History = Awaited<ReturnType<typeof history>>;

/**
 * Write, into `app`, execution `id` as the pre-0106 code left it: started, parked at gate 1,
 * compacted (blank checkpoint, log `[0]`), then resumed `through` gate 2 (the run's events in
 * "", its suspend snapshot under `id` with the blank state) and — `completed` — resumed again
 * to completion without a checkpoint.
 */
async function pre0106(
  app: App,
  id: string,
  h: History,
  stage: "compacted" | "resumed" | "completed"
): Promise<void> {
  const own = (e: EventEnvelope): EventEnvelope => ({
    ...e,
    id: `${id}-${e.sequence}`,
    executionId: id,
  });
  const stray = (e: EventEnvelope): EventEnvelope => ({
    ...e,
    id: `-${e.sequence}`,
    executionId: "",
    workflowId: "",
  });
  await app.eventStore.append(own(h.log[0]!));
  const snap = (q: number, state: ExecutionState) =>
    app.snapshotStore.save({
      id: `${id}@${q}`,
      executionId: id,
      workflowId: FLOW,
      sequence: q,
      state,
      createdAt: 0,
    });
  await snap(h.gate1, { ...h.at(h.gate1), executionId: id }); // the runtime's own suspend snapshot
  await snap(h.gate1, blank(h.at(h.gate1))); // the pre-0106 compaction checkpoint
  if (stage === "compacted") return;
  for (const e of h.log.filter((e) => e.sequence > h.gate1 && e.sequence <= h.gate2)) {
    await app.eventStore.append(stray(e));
  }
  await snap(h.gate2, blank(h.at(h.gate2)));
  if (stage === "resumed") return;
  for (const e of h.log.filter((e) => e.sequence > h.gate2)) await app.eventStore.append(stray(e));
}

const seqs = (log: EventEnvelope[]) => log.map((e) => e.sequence);
const range = (from: number, through: number) =>
  Array.from({ length: through - from + 1 }, (_, i) => from + i);

/**
 * The uncompacted history of an execution that CONTINUES at its second gate (ADR 0109): its tip is
 * `EXECUTION_CONTINUED`, so the snapshot a resume checkpointed there folds `continued`.
 */
async function continuedHistory(n: number) {
  const app = boot(undefined, { continueAsNewEnabled: true });
  app.runtime.registerFlow(definition, async (ctx, input) => {
    const a = await ctx.run(s1, input);
    await ctx.suspend({ on: "go1" });
    return ctx.continueAsNew({ n: a.n }) as never;
  });
  const h = await app.runtime.start({ definition, runner }, { n }, { executionId: "x" });
  await h.waitForSuspend();
  const gate1 = (await headOf(app.eventStore, "x"))!;
  await (await app.runtime.resume("x", { eventType: "go1", payload: { n } })).waitForCompletion();
  const log = await app.eventStore.read("x");
  const at = (q: number) => new ReplayVM(log.filter((e) => e.sequence <= q)).getState();
  const done = log[log.length - 1]!.sequence;
  expect(log[log.length - 1]!.eventType).toBe("EXECUTION_CONTINUED");
  return { log, gate1, gate2: done, done, at };
}

describe("ADR 0109 — the `continued` status in the blank-stream DRAINED set", () => {
  it("a blank checkpoint folding `continued` is a drained top: its segment is proven and rehomable", async () => {
    const h = await continuedHistory(1);
    expect(h.at(h.gate2).status).toBe("continued");
    const app = boot();
    await pre0106(app, "e1", h, "resumed"); // the run's events in "", a blank `continued` snapshot at its tip
    const census = await app.life.blankStreamCensus();
    expect(census.segments).toEqual([
      {
        executionId: "e1",
        fromSequence: h.gate1 + 1,
        throughSequence: h.gate2,
        proof: "snapshot",
        status: "rehomable",
      },
    ]);
    expect(census.unattributed).toEqual([]);
  });
});

describe("ADR 0107 (B) — census of the blank stream", () => {
  it("proves the segment a drained snapshot folds, and names — but never attributes — the tail above it", async () => {
    const h = await history(1);
    const app = boot();
    await pre0106(app, "e1", h, "completed");
    await pre0106(app, "e2", h, "compacted"); // its resume collided in "" and wrote nothing

    const census = await app.life.blankStreamCensus();
    expect(census.strayEvents).toBe(h.done - h.gate1);
    expect(census.affected.sort()).toEqual(["e1", "e2"]);
    expect(census.segments).toEqual([
      {
        executionId: "e1",
        fromSequence: h.gate1 + 1,
        throughSequence: h.gate2,
        proof: "snapshot",
        status: "rehomable",
      },
    ]);
    // The completion run took no checkpoint: nothing that survives names its writer.
    expect(census.unattributed).toEqual([
      {
        fromSequence: h.gate2 + 1,
        throughSequence: h.done,
        eventTypes: h.log.filter((e) => e.sequence > h.gate2).map((e) => e.eventType),
        candidates: ["e1"],
      },
    ]);
  });

  it("a tampered event breaks the proof — the segment is unattributed, with every candidate listed", async () => {
    const h = await history(1);
    const app = boot();
    // Both executions checkpointed at gate 1: either could have resumed into "" from there.
    await pre0106(app, "e2", h, "compacted");
    await pre0106(app, "e1", h, "resumed");
    const stray = await app.eventStore.read("");
    await app.eventStore.deleteExecution!("");
    for (const e of stray) {
      await app.eventStore.append(
        e.eventType === "EXECUTION_RESUMED" ? { ...e, payload: { n: 999 } } : e
      );
    }
    const census = await app.life.blankStreamCensus();
    expect(census.segments).toEqual([]);
    expect(census.unattributed).toHaveLength(1);
    expect(census.unattributed[0]!.candidates.sort()).toEqual(["e1", "e2"]);
    const repair = await app.life.rehomeBlankStream({ apply: true });
    expect(repair.rehomed).toEqual([]);
    expect(seqs(await app.eventStore.read("e1"))).toEqual([0]);
  });

  it("an empty blank stream costs no scan", async () => {
    const app = boot();
    expect(await app.life.blankStreamCensus()).toEqual({
      strayEvents: 0,
      scanned: 0,
      affected: [],
      segments: [],
      unattributed: [],
      ciphertext: false,
      shredded: false,
    });
  });
});

describe("ADR 0107 (B) — the repair", () => {
  it("is a dry run by default", async () => {
    const h = await history(1);
    const app = boot();
    await pre0106(app, "e1", h, "completed");
    const dry = await app.life.rehomeBlankStream();
    expect(dry.segments[0]!.status).toBe("rehomable");
    expect(dry.rehomed).toEqual([]);
    expect(seqs(await app.eventStore.read("e1"))).toEqual([0]);
    expect(await app.eventStore.read(LIFECYCLE_STREAM)).toEqual([]);
  });

  it("re-homes a proven segment at its own sequences, journals it, and is idempotent", async () => {
    const h = await history(1);
    const app = boot();
    await pre0106(app, "e1", h, "completed");
    const repair = await app.life.rehomeBlankStream({ apply: true, now: 7 });
    expect(repair.rehomed.map((s) => [s.executionId, s.fromSequence, s.throughSequence])).toEqual([
      ["e1", h.gate1 + 1, h.gate2],
    ]);

    const log = await app.eventStore.read("e1");
    // The checkpoint's slot stays missing: the log has the shape of one compacted at gate 1.
    expect(seqs(log)).toEqual([0, ...range(h.gate1 + 1, h.gate2)]);
    for (const e of log.slice(1)) {
      expect(e).toMatchObject({ executionId: "e1", workflowId: FLOW, id: `e1-${e.sequence}` });
      expect(e.metadata?.[REHOMED_FROM_KEY]).toBe(`-${e.sequence}`);
      const original = h.log.find((o) => o.sequence === e.sequence)!;
      expect({ ...e, id: "", executionId: "", metadata: undefined }).toEqual({
        ...original,
        id: "",
        executionId: "",
        metadata: undefined,
      });
    }
    // The checkpoint plus the re-homed events fold to the snapshot the resumed run took.
    const checkpoint = (await app.snapshotStore.loadLatestBefore("e1", h.gate1))!;
    const refolded = new ReplayVM(log.slice(1), checkpoint.state).getState();
    expect(blank(refolded)).toEqual(blank(h.at(h.gate2)));

    const facts = await app.eventStore.read(LIFECYCLE_STREAM);
    expect(facts.map((f) => [f.eventType, f.payload, f.timestamp])).toEqual([
      [
        "EVENTS_REHOMED",
        {
          executionId: "e1",
          fromSequence: h.gate1 + 1,
          throughSequence: h.gate2,
          proof: "snapshot",
          count: h.gate2 - h.gate1,
        },
        7,
      ],
    ]);
    expect(new ReplayVM(facts).getState().variables._lifecycle).toEqual([
      {
        op: "rehomed",
        executionId: "e1",
        fromSequence: h.gate1 + 1,
        throughSequence: h.gate2,
        proof: "snapshot",
        at: 7,
      },
    ]);

    // Again: nothing to do, nothing written.
    const again = await app.life.rehomeBlankStream({ apply: true });
    expect(again.segments[0]!.status).toBe("rehomed");
    expect(again.rehomed).toEqual([]);
    expect(await app.eventStore.read(LIFECYCLE_STREAM)).toHaveLength(1);
    // The blank stream is left as evidence.
    expect(await app.eventStore.read("")).toHaveLength(h.done - h.gate1);
  });

  it("finishes a repair that stopped halfway", async () => {
    const h = await history(1);
    const app = boot();
    await pre0106(app, "e1", h, "resumed");
    const first = (await app.eventStore.read(""))[0]!;
    await app.eventStore.append({
      ...first,
      executionId: "e1",
      workflowId: FLOW,
      id: `e1-${first.sequence}`,
      metadata: { [REHOMED_FROM_KEY]: first.id },
    });
    const repair = await app.life.rehomeBlankStream({ apply: true });
    expect(repair.rehomed).toHaveLength(1);
    expect(seqs(await app.eventStore.read("e1"))).toEqual([0, ...range(h.gate1 + 1, h.gate2)]);
  });

  it("an operator assignment re-homes the unprovable tail — after checking it folds — and the execution completes", async () => {
    const h = await history(1);
    const app = boot();
    await pre0106(app, "e1", h, "completed");
    // Before: the runtime believes e1 is still parked at gate 2; its completion is in "".
    expect((await app.runtime.loadState("e1"))?.status).toBe("suspended");
    const assign = [{ executionId: "e1", fromSequence: h.gate2 + 1, throughSequence: h.done }];
    const repair = await app.life.rehomeBlankStream({ apply: true, assign });
    expect(repair.rehomed.map((s) => s.proof)).toEqual(["snapshot", "operator"]);
    expect(repair.unattributed).toEqual([]);
    expect(seqs(await app.eventStore.read("e1"))).toEqual([0, ...range(h.gate1 + 1, h.done)]);
    const state = (await app.runtime.loadState("e1"))!;
    expect(state.status).toBe("completed");
    expect(blank(state)).toEqual(blank(h.at(h.done)));
  });

  it("refuses an assignment that does not fold onto the named execution", async () => {
    const h = await history(1);
    const app = boot();
    await pre0106(app, "e1", h, "completed");
    await pre0106(app, "e2", h, "compacted");
    const census = await app.life.blankStreamCensus({
      assign: [
        { executionId: "e2", fromSequence: h.gate2 + 1, throughSequence: h.done }, // no snapshot at gate 2
        { executionId: "e1", fromSequence: h.gate1 + 1, throughSequence: h.gate2 }, // proven already
        { executionId: "e1", fromSequence: h.done, throughSequence: h.done + 5 }, // not in ""
        { executionId: "nobody", fromSequence: h.gate2 + 1, throughSequence: h.done },
      ],
    });
    const operator = census.segments.filter((s) => s.proof === "operator");
    expect(operator.map((s) => s.status)).toEqual(["invalid", "invalid", "invalid", "invalid"]);
    expect(operator.map((s) => s.detail)).toEqual([
      expect.stringContaining("already proven for e1"),
      expect.stringContaining(`e2 has no pre-0106 (blank) snapshot at ${h.gate2}`),
      expect.stringContaining("no such execution"),
      expect.stringContaining("does not hold every sequence"),
    ]);
  });

  it("refuses when the execution's own log holds an event where the history goes (a pre-0106 denial)", async () => {
    const h = await history(1);
    const app = boot();
    await pre0106(app, "e1", h, "resumed");
    await app.eventStore.append({
      id: `e1-${h.gate1 + 1}-denied`,
      workflowId: FLOW,
      executionId: "e1",
      eventType: "EXECUTION_DENIED",
      sequence: h.gate1 + 1,
      timestamp: 1,
      payload: { op: "resume" },
    });
    const repair = await app.life.rehomeBlankStream({ apply: true });
    expect(repair.segments[0]).toMatchObject({ status: "occupied" });
    expect(repair.rehomed).toEqual([]);
    expect(seqs(await app.eventStore.read("e1"))).toEqual([0, h.gate1 + 1]);
  });

  it("refuses a denial below the checkpoint that would make the log read as never compacted", async () => {
    const h = await history(1);
    const app = boot();
    await pre0106(app, "e1", h, "resumed");
    // The pre-0106 denial path wrote at the log's last event + 1: slot 1 of `[0]`. With every
    // slot from 2 up re-homed the log would be gap-free, and fold from scratch.
    for (let q = 1; q <= h.gate1; q++) {
      await app.eventStore.append({
        id: `e1-${q}-x`,
        workflowId: FLOW,
        executionId: "e1",
        eventType: "EXECUTION_DENIED",
        sequence: q,
        timestamp: 1,
        payload: { op: "resume" },
      });
    }
    const repair = await app.life.rehomeBlankStream({ apply: true });
    expect(repair.segments[0]).toMatchObject({
      status: "occupied",
      detail: expect.stringContaining("reads as never compacted"),
    });
    expect(repair.rehomed).toEqual([]);
  });

  it("an execution resumed after the fix and compacted again is superseded — its checkpoint already folds these events", async () => {
    const h = await history(1);
    const app = boot();
    await pre0106(app, "e1", h, "resumed");
    // The fixed runtime resumes e1 from its blank gate-2 snapshot into its OWN log…
    await (
      await app.runtime.resume("e1", { eventType: "go2", payload: { n: 1 } })
    ).waitForCompletion();
    expect(seqs(await app.eventStore.read("e1"))).toEqual([0, ...range(h.gate2 + 1, h.done)]);
    // …before the repair, the segment below continues straight into that log: re-homable.
    expect((await app.life.blankStreamCensus()).segments[0]!.status).toBe("rehomable");
    // …and compacted after the fix: the segment now sits below a later checkpoint.
    await app.life.compact("e1");
    const repair = await app.life.rehomeBlankStream({ apply: true });
    expect(repair.segments[0]!.status).toBe("superseded");
    expect(repair.rehomed).toEqual([]);
  });
});

/**
 * A pre-0106 image, spelled out: `id`'s bootstrap, the runtime's own (named) snapshot plus a
 * blank compaction checkpoint at `checkpoint`, blank snapshots the resumed runs took at `blanks`,
 * and the stray events `(checkpoint, through]` in "" (slots already there are left alone — two
 * executions can write the same history).
 */
async function image(
  app: App,
  id: string,
  h: History,
  o: { checkpoint: number; blanks: number[]; through: number; named?: number[] }
): Promise<void> {
  await app.raw.append({ ...h.log[0]!, id: `${id}-0`, executionId: id });
  const save = (q: number, state: ExecutionState) =>
    app.snapshotStore.save({
      id: `${id}@${q}@${Math.random()}`,
      executionId: id,
      workflowId: FLOW,
      sequence: q,
      state,
      createdAt: 0,
    });
  for (const q of o.named ?? [o.checkpoint]) await save(q, { ...h.at(q), executionId: id });
  await save(o.checkpoint, blank(h.at(o.checkpoint)));
  for (const q of o.blanks) await save(q, blank(h.at(q)));
  const present = new Set((await app.raw.read("")).map((e) => e.sequence));
  for (const e of h.log.filter((e) => e.sequence > o.checkpoint && e.sequence <= o.through)) {
    if (present.has(e.sequence)) continue;
    await app.raw.append({ ...e, id: `-${e.sequence}`, executionId: "", workflowId: "" });
  }
}

const spans = (census: {
  segments: Array<{
    executionId: string;
    fromSequence: number;
    throughSequence: number;
    status: string;
  }>;
}) =>
  census.segments.map((s) => `${s.executionId}:${s.fromSequence}-${s.throughSequence}:${s.status}`);

/**
 * What the pre-0106 journal wrote: a record sealed under the blank subject "". The crypto layer
 * no longer WRITES under "" (review P3), so the legacy rows are seeded straight into the raw store.
 */
async function appendLegacyBlank(
  raw: EventStore,
  keys: InMemoryKeyStore,
  sensitive: Record<string, string[]>,
  e: EventEnvelope
): Promise<void> {
  const key = await keys.getOrCreate("");
  const paths = sensitive[e.eventType] ?? [];
  await raw.append({
    ...e,
    payload: mapPaths(e.payload, paths, (v) => encryptValue(key, v)),
  } as EventEnvelope);
}

describe("ADR 0107 (B) — review round 1", () => {
  it("two executions' segments interleaved in one stream are each proven and re-homed", async () => {
    const h = await history(1);
    const app = boot();
    // e1 resumed gate 1 → gate 2; e2 (compacted at gate 2) resumed gate 2 → done, with a
    // settle checkpoint (snapshotEvery) at completion.
    await image(app, "e1", h, { checkpoint: h.gate1, blanks: [h.gate2], through: h.gate2 });
    await image(app, "e2", h, {
      checkpoint: h.gate2,
      named: [h.gate1, h.gate2],
      blanks: [h.done],
      through: h.done,
    });
    const repair = await app.life.rehomeBlankStream({ apply: true });
    expect(spans(repair)).toEqual([
      `e1:${h.gate1 + 1}-${h.gate2}:rehomed`,
      `e2:${h.gate2 + 1}-${h.done}:rehomed`,
    ]);
    expect(repair.unattributed).toEqual([]);
    expect((await app.runtime.loadState("e2"))?.status).toBe("completed");
    expect(seqs(await app.eventStore.read("e2"))).toEqual([0, ...range(h.gate2 + 1, h.done)]);
  });

  it("two executions proving the same slots are a conflict — nothing is written", async () => {
    const h = await history(1);
    const app = boot();
    for (const id of ["e1", "e2"]) {
      await image(app, id, h, { checkpoint: h.gate1, blanks: [h.gate2], through: h.gate2 });
    }
    const repair = await app.life.rehomeBlankStream({ apply: true });
    expect(repair.segments.map((s) => s.status)).toEqual(["conflict", "conflict"]);
    expect(repair.rehomed).toEqual([]);
    expect(repair.unattributed[0]?.candidates.sort()).toEqual(["e1", "e2"]);
    for (const id of ["e1", "e2"]) expect(seqs(await app.eventStore.read(id))).toEqual([0]);
  });

  it("a pre-0106 COMPACTION checkpoint over a named base proves nothing (P2-2)", async () => {
    const h = await history(1);
    const app = boot();
    // X ran to gate 2 in its own log and was compacted there: blank checkpoint at gate 2 over
    // its runtime snapshot at gate 1. Y was compacted at gate 1 and its resume wrote (gate1,
    // gate2] into "", but Y's suspend snapshot was lost.
    await image(app, "X", h, {
      checkpoint: h.gate2,
      named: [h.gate1],
      blanks: [],
      through: h.gate1,
    });
    await image(app, "Y", h, { checkpoint: h.gate1, blanks: [], through: h.gate2 });
    const census = await app.life.blankStreamCensus();
    expect(census.segments).toEqual([]);
    expect(census.unattributed).toEqual([
      expect.objectContaining({
        fromSequence: h.gate1 + 1,
        throughSequence: h.gate2,
        candidates: ["Y"],
      }),
    ]);
  });

  it("a cadence (running) snapshot inside the resumed run does not strand a hole (P2-3, snapshotEvery)", async () => {
    const h = await history(1);
    const r = h.gate1 + 2;
    expect(h.at(r).status).toBe("running");
    const app = boot();
    await image(app, "e1", h, { checkpoint: h.gate1, blanks: [r, h.gate2], through: h.gate2 });
    const repair = await app.life.rehomeBlankStream({ apply: true });
    expect(spans(repair)).toEqual([`e1:${h.gate1 + 1}-${h.gate2}:rehomed`]);
    expect(seqs(await app.eventStore.read("e1"))).toEqual([0, ...range(h.gate1 + 1, h.gate2)]);

    // A cadence snapshot the fold does NOT reproduce stops the walk: only the part above it is
    // proven, and the rest is listed, never guessed.
    const bad = boot();
    await image(bad, "e1", h, { checkpoint: h.gate1, blanks: [h.gate2], through: h.gate2 });
    await bad.snapshotStore.save({
      id: "cadence",
      executionId: "e1",
      workflowId: FLOW,
      sequence: r,
      state: { ...blank(h.at(r)), updatedAt: 42 },
      createdAt: 0,
    });
    const census = await bad.life.blankStreamCensus();
    expect(spans(census)).toEqual([`e1:${r + 1}-${h.gate2}:rehomable`]);
    expect(census.unattributed.map((u) => [u.fromSequence, u.throughSequence])).toEqual([
      [h.gate1 + 1, r],
    ]);
  });

  it("an assignment never grafts a stray run onto a healthy execution, even one compacted after the fix (P2-1)", async () => {
    const h = await history(1);
    const app = boot();
    await pre0106(app, "e1", h, "completed");
    // Z: healthy, compacted after the fix through its tip at gate 2 (its checkpoint names Z).
    await (
      await app.runtime.start({ definition, runner }, { n: 5 }, { executionId: "Z" })
    ).waitForSuspend();
    await (await app.runtime.resume("Z", { eventType: "go1", payload: { n: 5 } })).waitForSuspend();
    await app.life.compact("Z");
    const repair = await app.life.rehomeBlankStream({
      apply: true,
      assign: [{ executionId: "Z", fromSequence: h.gate2 + 1, throughSequence: h.done }],
    });
    const operator = repair.segments.filter((s) => s.proof === "operator");
    expect(operator.map((s) => [s.executionId, s.status])).toEqual([["Z", "invalid"]]);
    expect(operator[0]!.detail).toContain(`Z has no pre-0106 (blank) snapshot at ${h.gate2}`);
    expect((await app.runtime.loadState("Z"))?.status).toBe("suspended");
    expect(seqs(await app.eventStore.read("Z"))).toEqual([0]);

    // The right execution, but a range that does not open with the resume of its gate.
    const other = boot();
    await image(other, "e1", h, { checkpoint: h.gate1, blanks: [h.gate2 + 1], through: h.done });
    const census = await other.life.blankStreamCensus({
      assign: [{ executionId: "e1", fromSequence: h.gate2 + 2, throughSequence: h.done }],
    });
    const assigned = census.segments.find((s) => s.proof === "operator")!;
    expect(assigned.status).toBe("invalid");
    expect(assigned.detail).toContain("must open with the resume answering");
  });

  it("re-homes into a fenced execution under a new fence, and leaves an unfenced one unfenced (P1)", async () => {
    const h = await history(1);
    const app = boot();
    await image(app, "e1", h, { checkpoint: h.gate1, blanks: [h.gate2], through: h.gate2 });
    await image(app, "e2", h, {
      checkpoint: h.gate2,
      named: [h.gate1, h.gate2],
      blanks: [h.done],
      through: h.done,
    });
    await app.raw.acquireFence("e1"); // a worker, a fenced TimerService or cancel() once did this
    const repair = await app.life.rehomeBlankStream({ apply: true });
    expect(repair.failed).toEqual([]);
    expect(repair.rehomed).toHaveLength(2);
    const e1 = await app.eventStore.read("e1");
    expect(e1.slice(1).every((e) => e.metadata?.fence === 2)).toBe(true);
    const e2 = await app.eventStore.read("e2");
    expect(e2.slice(1).every((e) => e.metadata?.fence === undefined)).toBe(true);
    // e2 was never fenced, and still takes an unfenced write.
    await app.raw.append({ ...e2[e2.length - 1]!, id: "later", sequence: h.done + 1 });
  });

  it("one execution failing does not stop the others; its failure is reported (P1)", async () => {
    const h = await history(1);
    const app = boot(
      (raw) =>
        new Proxy(raw, {
          get: (t, k, r) =>
            k === "appendBatch"
              ? async (batch: EventEnvelope[]) => {
                  if (batch[0]?.executionId === "e1") throw new Error("disk full");
                  return t.appendBatch(batch);
                }
              : Reflect.get(t, k, r),
        })
    );
    await image(app, "e1", h, { checkpoint: h.gate1, blanks: [h.gate2], through: h.gate2 });
    await image(app, "e2", h, {
      checkpoint: h.gate2,
      named: [h.gate1, h.gate2],
      blanks: [h.done],
      through: h.done,
    });
    const repair = await app.life.rehomeBlankStream({ apply: true });
    expect(repair.failed).toEqual([{ executionId: "e1", error: "disk full" }]);
    expect(repair.rehomed.map((s) => s.executionId)).toEqual(["e2"]);
    expect(seqs(await app.eventStore.read("e1"))).toEqual([0]);
  });

  it("all of one execution's slots land in ONE batch (P3-2)", async () => {
    const h = await history(1);
    const batches: number[][] = [];
    const app = boot(
      (raw) =>
        new Proxy(raw, {
          get: (t, k, r) =>
            k === "appendBatch"
              ? async (batch: EventEnvelope[]) => {
                  batches.push(batch.map((e) => e.sequence));
                  return t.appendBatch(batch);
                }
              : Reflect.get(t, k, r),
        })
    );
    await pre0106(app, "e1", h, "completed");
    await app.life.rehomeBlankStream({
      apply: true,
      assign: [{ executionId: "e1", fromSequence: h.gate2 + 1, throughSequence: h.done }],
    });
    expect(batches).toEqual([range(h.gate1 + 1, h.done)]);
  });

  it("a fact that did not land is written by the next run; a lifecycle write conflict is retried (P3-3)", async () => {
    const h = await history(1);
    let failLifecycle: "error" | "conflict" | undefined = "error";
    const app = boot(
      (raw) =>
        new Proxy(raw, {
          get: (t, k, r) =>
            k === "append"
              ? async (e: EventEnvelope) => {
                  const mode = e.executionId === LIFECYCLE_STREAM ? failLifecycle : undefined;
                  if (mode !== undefined) {
                    failLifecycle = undefined;
                    if (mode === "conflict")
                      throw new DuplicateSequenceError(e.executionId, e.sequence);
                    throw new Error("lifecycle stream unavailable");
                  }
                  return t.append(e);
                }
              : Reflect.get(t, k, r),
        })
    );
    await pre0106(app, "e1", h, "resumed");
    const first = await app.life.rehomeBlankStream({ apply: true });
    expect(first.rehomed).toHaveLength(1);
    expect(first.failed[0]?.error).toContain("EVENTS_REHOMED fact did not land");
    expect(await app.raw.read(LIFECYCLE_STREAM)).toEqual([]);

    failLifecycle = "conflict";
    const second = await app.life.rehomeBlankStream({ apply: true });
    expect(second.rehomed).toEqual([]);
    expect(second.failed).toEqual([]);
    expect((await app.raw.read(LIFECYCLE_STREAM)).map((f) => f.eventType)).toEqual([
      "EVENTS_REHOMED",
    ]);
    // And not again.
    await app.life.rehomeBlankStream({ apply: true });
    expect(await app.raw.read(LIFECYCLE_STREAM)).toHaveLength(1);
  });

  it("refuses an execution that changed between the census and the apply (P3-6)", async () => {
    const h = await history(1);
    let raced = false;
    const app = boot(
      (raw) =>
        new Proxy(raw, {
          get: (t, k, r) =>
            k === "read"
              ? async (id: string) => {
                  const out = await t.read(id);
                  if (id === "e1" && !raced) {
                    raced = true; // a concurrent writer lands right after the census read
                    await t.append({
                      ...h.log[h.log.length - 1]!,
                      id: "late",
                      executionId: "e1",
                      sequence: 99,
                    });
                  }
                  return out;
                }
              : Reflect.get(t, k, r),
        })
    );
    await pre0106(app, "e1", h, "resumed");
    const repair = await app.life.rehomeBlankStream({ apply: true });
    expect(repair.rehomed).toEqual([]);
    expect(repair.failed[0]?.error).toContain("changed since the census");
    expect(seqs(await app.raw.read("e1"))).toEqual([0, 99]);
  });

  it("encrypted at rest: through the app's encrypting store it re-homes under the execution's key; the raw store refuses (P2-4)", async () => {
    const h = await history(1);
    const keys = new InMemoryKeyStore();
    const sensitive = { go1: ["n"], EXECUTION_RESUMED: ["n"] };
    const app = boot((raw) => new EncryptingEventStore(raw, keys, { sensitive }));
    // The pre-0106 journal wrote through the encrypting store as execution "": key "".
    const enc = app.eventStore;
    await app.raw.append({ ...h.log[0]!, id: "e1-0", executionId: "e1" });
    for (const q of [h.gate1]) {
      await app.snapshotStore.save({
        id: `c${q}`,
        executionId: "e1",
        workflowId: FLOW,
        sequence: q,
        state: blank(h.at(q)),
        createdAt: 0,
      });
    }
    await app.snapshotStore.save({
      id: "s",
      executionId: "e1",
      workflowId: FLOW,
      sequence: h.gate2,
      state: blank(h.at(h.gate2)),
      createdAt: 0,
    });
    for (const e of h.log.filter((e) => e.sequence > h.gate1 && e.sequence <= h.gate2)) {
      await appendLegacyBlank(app.raw, keys, sensitive, {
        ...e,
        id: `-${e.sequence}`,
        executionId: "",
        workflowId: "",
      });
    }
    // Raw: the payloads are ciphertext it cannot read. The census says so; the apply refuses.
    const rawLife = new LogLifecycle(app.raw, app.snapshotStore);
    expect((await rawLife.blankStreamCensus()).ciphertext).toBe(true);
    await expect(rawLife.rehomeBlankStream({ apply: true })).rejects.toThrow(/ciphertext/);
    expect(seqs(await app.raw.read("e1"))).toEqual([0]);
    // Through the app's stores: decrypted, proven, and re-encrypted under e1's key.
    const repair = await app.life.rehomeBlankStream({ apply: true });
    expect(repair.ciphertext).toBe(false);
    expect(repair.rehomed).toHaveLength(1);
    const resumed = (await enc.read("e1")).find((e) => e.eventType === "go1")!;
    expect(resumed.payload).toEqual({ n: 1 });
    const atRest = (await app.raw.read("e1")).find((e) => e.eventType === "go1")!;
    expect((atRest.payload as { n: unknown }).n).toMatchObject({ __loomEnc: "loom/aes-256-gcm" });
    expect(await keys.get("e1")).not.toBeNull();
  });
});

describe("ADR 0107 (B) — review round 2", () => {
  /**
   * e1 compacted at gate 1, with its gate-2 snapshot re-parked by `park` and the stray tail
   * above it built by `tail` — the shapes the other resume paths record.
   */
  async function tailed(
    app: App,
    h: History,
    park: (s: ExecutionState) => ExecutionState,
    tail: (events: EventEnvelope[]) => Array<Omit<EventEnvelope, "sequence" | "id">>
  ): Promise<number> {
    await image(app, "e1", h, { checkpoint: h.gate1, blanks: [], through: h.gate2 });
    await app.snapshotStore.save({
      id: "seed",
      executionId: "e1",
      workflowId: FLOW,
      sequence: h.gate2,
      state: park(blank(h.at(h.gate2))),
      createdAt: 0,
    });
    const events = tail(h.log.filter((e) => e.sequence > h.gate2));
    let q = h.gate2;
    for (const e of events) {
      q++;
      await app.raw.append({ ...e, sequence: q, id: `-${q}`, executionId: "", workflowId: "" });
    }
    return q;
  }
  const timed = (s: ExecutionState): ExecutionState => ({
    ...s,
    suspendedOn: { ...s.suspendedOn!, wakeAt: 5_000 },
  });

  it("assigns a tail a TimerService resume wrote (TIMER_FIRED at the park's wakeAt) — and refuses another wakeAt (P3-A)", async () => {
    const h = await history(1);
    for (const [wakeAt, want] of [
      [5_000, "rehomed"],
      [6_000, "invalid"],
    ] as const) {
      const app = boot();
      const through = await tailed(app, h, timed, (events) =>
        events.map((e, i) =>
          i === 0 ? { ...e, eventType: "TIMER_FIRED", payload: { wakeAt } } : e
        )
      );
      const repair = await app.life.rehomeBlankStream({
        apply: true,
        assign: [{ executionId: "e1", fromSequence: h.gate2 + 1, throughSequence: through }],
      });
      const seg = repair.segments.find((s) => s.proof === "operator")!;
      expect(seg.status).toBe(want);
      if (want === "invalid") expect(seg.detail).toContain("TIMER_FIRED at 5000");
    }
  });

  it("assigns a tail a resumeAs wrote (EXECUTION_MIGRATED before the answer) (P3-A)", async () => {
    const h = await history(1);
    const app = boot();
    const through = await tailed(
      app,
      h,
      (s) => s,
      (events) => [
        {
          ...events[0]!,
          eventType: "EXECUTION_MIGRATED",
          payload: { toFlowId: FLOW, strategy: "operator-ack" },
        },
        ...events,
      ]
    );
    const census = await app.life.blankStreamCensus({
      assign: [{ executionId: "e1", fromSequence: h.gate2 + 1, throughSequence: through }],
    });
    expect(census.segments.find((s) => s.proof === "operator")?.status).toBe("rehomable");
  });

  it("after an operator repair, the census reports the range re-homed, not unattributed (P3-B)", async () => {
    const h = await history(1);
    const app = boot();
    await pre0106(app, "e1", h, "completed");
    const assign = [{ executionId: "e1", fromSequence: h.gate2 + 1, throughSequence: h.done }];
    await app.life.rehomeBlankStream({ apply: true, assign });
    const census = await app.life.blankStreamCensus();
    expect(census.unattributed).toEqual([]);
    expect(spans(census)).toEqual([
      `e1:${h.gate1 + 1}-${h.gate2}:rehomed`,
      `e1:${h.gate2 + 1}-${h.done}:rehomed`,
    ]);
    expect(census.segments.map((s) => s.proof)).toEqual(["snapshot", "operator"]);
    // Its fact is not written twice.
    await app.life.rehomeBlankStream({ apply: true });
    expect(await app.raw.read(LIFECYCLE_STREAM)).toHaveLength(2);
  });

  it("refuses to copy { $shredded } placeholders a tolerant store reads for a destroyed key (P2-4 minor)", async () => {
    const h = await history(1);
    const keys = new InMemoryKeyStore();
    const sensitive = { go1: ["n"], EXECUTION_RESUMED: ["n"] };
    const app = boot(
      (raw) => new EncryptingEventStore(raw, keys, { sensitive, onShredded: "tolerate" })
    );
    await image(app, "e1", h, { checkpoint: h.gate1, blanks: [h.gate2], through: h.gate1 });
    for (const e of h.log.filter((e) => e.sequence > h.gate1 && e.sequence <= h.gate2)) {
      await appendLegacyBlank(app.raw, keys, sensitive, {
        ...e,
        id: `-${e.sequence}`,
        executionId: "",
        workflowId: "",
      });
    }
    await keys.destroy("");
    // A REAL shred leaves its durable tombstone (a tolerant store redacts only beside one; a key
    // that is merely absent is key-unavailable, ADR 0130 D7).
    const last = (await app.raw.read("")).at(-1)?.sequence ?? -1;
    await app.raw.append({
      id: "tomb-blank",
      workflowId: "",
      executionId: "",
      eventType: "PAYLOAD_SHREDDED",
      sequence: last + 1,
      timestamp: 1,
      payload: { subjectId: "" },
    } as never);
    const census = await app.life.blankStreamCensus();
    expect(census.shredded).toBe(true);
    await expect(
      app.life.rehomeBlankStream({
        apply: true,
        assign: [{ executionId: "e1", fromSequence: h.gate1 + 1, throughSequence: h.gate2 }],
      })
    ).rejects.toThrow(/\$shredded/);
    expect(seqs(await app.raw.read("e1"))).toEqual([0]);
  });
});

describe("ADR 0134 D6 - snapshot pruning refuses while the blank stream is unrepaired", () => {
  const countSnapshots = async (app: App, id: string, top: number) => {
    let n = 0;
    for (let q = 0; q <= top; q++) if ((await app.snapshotStore.loadAt(id, q)) !== null) n++;
    return n;
  };

  it("refuses with a re-homable blank stream, deletes nothing; succeeds after the repair (which leaves \"\" in place)", async () => {
    const h = await history(1);
    const app = boot();
    await pre0106(app, "e1", h, "resumed");
    const before = await countSnapshots(app, "e1", h.done);
    expect(before).toBeGreaterThan(0);
    let deletes = 0;
    const inner = app.snapshotStore.pruneSnapshots!.bind(app.snapshotStore);
    app.snapshotStore.pruneSnapshots = async (...a) => {
      deletes++;
      return inner(...a);
    };

    await expect(app.life.pruneSnapshots("e1")).rejects.toThrow(BlankStreamUnrepairedError);
    expect(deletes).toBe(0);
    expect(await countSnapshots(app, "e1", h.done)).toBe(before);

    await app.life.rehomeBlankStream({ apply: true });
    expect(await headOf(app.eventStore, "")).not.toBeNull(); // the evidence stays
    await expect(app.life.pruneSnapshots("e1")).resolves.toBeGreaterThanOrEqual(0);
  });

  it("refuses with an unattributed run (the repair cannot settle it unassisted)", async () => {
    const h = await history(1);
    const app = boot();
    await pre0106(app, "e1", h, "completed");
    await app.life.rehomeBlankStream({ apply: true });
    await expect(app.life.pruneSnapshots("e1")).rejects.toThrow(BlankStreamUnrepairedError);
  });

  it("proceeds when there never was a blank stream, with one head read and no census", async () => {
    const app = boot();
    const h = await app.runtime.start({ definition, runner }, { n: 1 }, { executionId: "ok" });
    await h.waitForSuspend();
    let listed = 0;
    const list = app.eventStore.listExecutions?.bind(app.eventStore);
    if (list !== undefined)
      app.eventStore.listExecutions = async (...a: []) => {
        listed++;
        return list(...a);
      };
    await expect(app.life.pruneSnapshots("ok")).resolves.toBeGreaterThanOrEqual(0);
    expect(listed).toBe(0);
  });
});
