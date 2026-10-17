import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope, ExecutionState, FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { SqliteEventStore, SqliteSnapshotStore } from "@loom/plugin-sqlite";
import { ReplayVM } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { refusal } from "./refusalTestUtil";
import { cmdRepairBlankStream, cmdRepairTerminalEvent, parseAssignments } from "./repair";

// `loom repair blank-stream` (ADR 0107) over a SQLite image of what the pre-0106 compaction bug
// left: e1 compacted at gate 1 (blank checkpoint, log `[0]`), resumed twice — the first run's
// events in "" with its suspend snapshot under e1, the second (to completion) in "" with no
// snapshot at all.

const io = z.object({}).passthrough();
const definition: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "f",
  name: "f",
  version: "1.0.0",
  inputSchema: io,
  outputSchema: io,
  steps: [],
};

async function history() {
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
    now: () => 1_000,
  });
  const runner = async (ctx: { suspend(c: { on: string }): Promise<unknown> }) => {
    await ctx.suspend({ on: "go1" });
    await ctx.suspend({ on: "go2" });
    return {};
  };
  runtime.registerFlow(definition, runner as never);
  await (await runtime.start("f", {}, { executionId: "x" })).waitForSuspend();
  const gate1 = (await eventStore.head("x"))!;
  await (await runtime.resume("x", { eventType: "go1", payload: { a: 1 } })).waitForSuspend();
  const gate2 = (await eventStore.head("x"))!;
  await (await runtime.resume("x", { eventType: "go2", payload: { a: 2 } })).waitForCompletion();
  const log = await eventStore.read("x");
  return { log, gate1, gate2, done: log[log.length - 1]!.sequence };
}

describe("loom repair blank-stream", () => {
  let dir: string;
  let db: string;
  let snap: string;
  let h: Awaited<ReturnType<typeof history>>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "loom-repair-"));
    db = join(dir, "events.db");
    snap = join(dir, "snap.db");
    h = await history();
    const events = new SqliteEventStore(db);
    const snaps = new SqliteSnapshotStore(snap);
    const fold = (q: number): ExecutionState => ({
      ...new ReplayVM(h.log.filter((e) => e.sequence <= q)).getState(),
      executionId: "",
      workflowId: "",
      workflowVersion: "",
    });
    const stray = (e: EventEnvelope): EventEnvelope => ({
      ...e,
      id: `-${e.sequence}`,
      executionId: "",
      workflowId: "",
    });
    await events.append({ ...h.log[0]!, id: "e1-0", executionId: "e1" });
    for (const e of h.log.filter((e) => e.sequence > h.gate1)) await events.append(stray(e));
    for (const q of [h.gate1, h.gate2]) {
      await snaps.save({
        id: `s${q}`,
        executionId: "e1",
        workflowId: "f",
        sequence: q,
        state: fold(q),
        createdAt: 0,
      });
    }
    events.close();
    await snaps.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("dry-runs by default: the proven segment, and the tail it will not guess", async () => {
    const out = await cmdRepairBlankStream({ db, snap, apply: false });
    expect(out).toContain("DRY RUN");
    expect(out).toContain(`${h.gate1 + 1}..${h.gate2}`);
    expect(out).toContain("would re-home (proven by snapshot)");
    expect(out).toContain(`${h.gate2 + 1}..${h.done}`);
    expect(out).toContain("UNATTRIBUTED");
    expect(out).toContain("candidate: e1");
    expect(out).toContain("--assign");
    const events = new SqliteEventStore(db);
    expect((await events.read("e1")).map((e) => e.sequence)).toEqual([0]);
    events.close();
  });

  it("--apply re-homes the proven segment; --assign re-homes the tail the operator vouches for", async () => {
    const first = await cmdRepairBlankStream({ db, snap, apply: true });
    expect(first).toContain("re-homed now: 1 segment(s)");
    const assigned = await cmdRepairBlankStream({
      db,
      snap,
      assign: `e1:${h.gate2 + 1}-${h.done}`,
      apply: true,
    });
    expect(assigned).toContain("re-homed now: 1 segment(s)");
    expect(assigned).not.toContain("UNATTRIBUTED");
    const events = new SqliteEventStore(db);
    const log = await events.read("e1");
    expect(log.map((e) => e.sequence)).toEqual([
      0,
      ...h.log.filter((e) => e.sequence > h.gate1).map((e) => e.sequence),
    ]);
    expect(
      (await events.read("__loom_lifecycle__")).map((f) => (f.payload as { proof: string }).proof)
    ).toEqual(["snapshot", "operator"]);
    events.close();
    // Nothing left to do — and a plain census does not ask for the assignment again.
    expect(await cmdRepairBlankStream({ db, snap, apply: true })).toContain("re-homed now: 0");
    const census = await cmdRepairBlankStream({ db, snap, apply: false });
    expect(census).not.toContain("UNATTRIBUTED");
    expect(census).toContain("rehomed (operator-assigned)");
  });

  it('after --apply it names what the repair cannot do: read models, and the key of subject ""', async () => {
    const out = await cmdRepairBlankStream({ db, snap, apply: true });
    expect(out).toContain('purge their "" rows and rebuild them');
    expect(out).toContain("destroy");
    expect(out).toContain('keys.destroy("")');
  });

  it("refuses to --apply ciphertext it cannot decrypt, pointing at --config", async () => {
    const events = new SqliteEventStore(db);
    await events.append({
      id: `-${h.done + 1}`,
      executionId: "",
      workflowId: "",
      eventType: "go3",
      sequence: h.done + 1,
      timestamp: 1,
      payload: { n: { __loomEnc: "loom/aes-256-gcm", iv: "a", tag: "b", data: "c" } },
    });
    events.close();
    expect(await cmdRepairBlankStream({ db, snap, apply: false })).toContain(
      "still carry ciphertext"
    );
    const out = await refusal(cmdRepairBlankStream({ db, snap, apply: true }));
    expect(out).toContain("refused --apply (nothing written)");
    expect(out).toContain("--config");
    const after = new SqliteEventStore(db);
    expect((await after.read("e1")).map((e) => e.sequence)).toEqual([0]);
    after.close();
  });

  it("needs the snapshot store — the proof lives there", async () => {
    expect(await refusal(cmdRepairBlankStream({ db, apply: false }))).toContain(
      "needs the snapshot store"
    );
  });

  it("parses --assign and refuses a malformed one", () => {
    expect(parseAssignments("e1:13-15, run-7:20-22")).toEqual([
      { executionId: "e1", fromSequence: 13, throughSequence: 15 },
      { executionId: "run-7", fromSequence: 20, throughSequence: 22 },
    ]);
    expect(() => parseAssignments("e1:13")).toThrow(/expected <executionId>:<from>-<through>/);
  });
});

describe("loom repair terminal-event (ADR 0116 migration)", () => {
  let dir: string;
  let db: string;
  let snap: string;
  const decideRunner = async (ctx: { decide(id: string, f: () => string): Promise<string> }) => {
    await ctx.decide("route", () => "opus");
    return {};
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "loom-repair-te-"));
    db = join(dir, "events.db");
    snap = join(dir, "snap.db");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const stores = () => ({ events: new SqliteEventStore(db), snaps: new SqliteSnapshotStore(snap) });
  const runtimeOver = (events: SqliteEventStore, snaps: SqliteSnapshotStore) => {
    const runtime = new WorkflowRuntime({
      eventStore: events,
      snapshotStore: snaps,
      effectRuntime: new EffectRuntime(),
    });
    runtime.registerFlow(definition, decideRunner as never);
    return runtime;
  };

  it("restores the terminal event of a pre-0116 [0]+checkpoint execution so a late outcome lands", async () => {
    const { events, snaps } = stores();
    const runtime = runtimeOver(events, snaps);
    await (await runtime.start("f", {}, { executionId: "done" })).waitForCompletion();
    await (await runtime.start("f", {}, { executionId: "intact" })).waitForCompletion();
    const state = (await runtime.loadState("done"))!;
    // the OLD compaction shape: checkpoint at the tip, log truncated through it
    await snaps.save({
      id: "old",
      executionId: "done",
      workflowId: "f",
      sequence: state.sequence,
      state,
      createdAt: 0,
    });
    await events.truncatePrefix!("done", state.sequence);
    await expect(
      runtime.recordOutcome("done", { decisionId: "route", key: "k", score: 1 })
    ).rejects.toThrow(/compacted/);
    events.close();
    await snaps.close();

    const dry = await cmdRepairTerminalEvent({ db, snap, apply: false });
    expect(dry).toContain("DRY RUN");
    expect(dry).toContain(`would restore EXECUTION_COMPLETED at sequence ${state.sequence + 1}`);
    expect(dry).not.toContain("intact");
    const applied = await cmdRepairTerminalEvent({ db, snap, apply: true });
    expect(applied).toContain(`restored EXECUTION_COMPLETED at sequence ${state.sequence + 1}`);
    expect(applied).toContain("1 restored");
    // idempotent: a second run finds nothing to do
    expect(await cmdRepairTerminalEvent({ db, snap, apply: true })).toContain("0 restored");

    const after = stores();
    const rt = runtimeOver(after.events, after.snaps);
    expect(await rt.recordOutcome("done", { decisionId: "route", key: "k", score: 1 })).toEqual({
      appended: true,
      sequence: state.sequence + 2,
    });
    expect((await rt.loadState("done"))!.status).toBe("completed");
    after.events.close();
    await after.snaps.close();
  });

  it("asks for the snapshot store, and leaves a non-terminal execution alone", async () => {
    new SqliteEventStore(db).close();
    expect(await refusal(cmdRepairTerminalEvent({ db, apply: true }))).toMatch(
      /needs the snapshot store/
    );
  });
});
