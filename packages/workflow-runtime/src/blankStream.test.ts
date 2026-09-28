import { step$ } from "@loom/core";
import type { EventEnvelope, ExecutionState, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { ReplayVM } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LIFECYCLE_STREAM, LogLifecycle } from "./LogLifecycle";
import { WorkflowRuntime } from "./WorkflowRuntime";
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

function boot() {
  const effects = new EffectRuntime();
  for (const id of ["t1", "t2", "t3"]) {
    effects.register(id, new ToolEffect(async (x: { n: number }) => ({ n: x.n + 1 })));
  }
  const eventStore = new InMemoryAsyncEventStore();
  const snapshotStore = new InMemoryAsyncSnapshotStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore,
    effectRuntime: effects,
    now: () => 1_000,
    onWarn: () => {},
  });
  runtime.registerFlow(definition, runner);
  return { runtime, eventStore, snapshotStore, life: new LogLifecycle(eventStore, snapshotStore) };
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
  const gate1 = (await app.eventStore.head("x"))!;
  await (await app.runtime.resume("x", { eventType: "go1", payload: { n } })).waitForSuspend();
  const gate2 = (await app.eventStore.head("x"))!;
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
      expect.stringContaining(`no snapshot of e2 at ${h.gate2}`),
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
