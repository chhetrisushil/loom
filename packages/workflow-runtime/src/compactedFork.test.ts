import { step$ } from "@loom/core";
import type { ExecutionState, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { type EventStore, InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LogLifecycle } from "./LogLifecycle";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { CompactedForkPointError } from "./types";
import type { FlowRunner } from "./types";

// ADR 0107 (A) — `fork()` of a compacted parent. Its contract: the child's log is the parent's
// prefix `[0..at]` and its state is the fold at `at`. Compaction removes the events below its
// checkpoint, so a fork point inside that hole is served EXACTLY (from a snapshot sitting at it)
// or refused — never folded across the hole into a plausible wrong state.

const io = z.object({ n: z.number() });
const s1 = step$({ id: "s1", name: "s1", toolId: "t1", inputSchema: io, outputSchema: io });
const s2 = step$({ id: "s2", name: "s2", toolId: "t2", inputSchema: io, outputSchema: io });
const s3 = step$({ id: "s3", name: "s3", toolId: "t3", inputSchema: io, outputSchema: io });

const FLOW = "fork-compacted";
const FINDING = "FINDING_RECORDED";

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
  ctx.emit(FINDING, { finding: "f1" });
  await ctx.suspend({ on: "go1" });
  const b = await ctx.run(s2, a);
  await ctx.suspend({ on: "go2" });
  const c = await ctx.run(s3, b);
  return { n: c.n };
};

/** An event store without the native prefix copy — `fork()` then copies event by event. */
function withoutCopyPrefix(store: InMemoryAsyncEventStore): EventStore {
  return new Proxy(store, {
    get: (target, key, receiver) =>
      key === "copyPrefix" ? undefined : Reflect.get(target, key, receiver),
  });
}

function boot(copyPrefix = true) {
  const effects = new EffectRuntime();
  for (const id of ["t1", "t2", "t3"]) {
    effects.register(id, new ToolEffect(async (x: { n: number }) => ({ n: x.n + 1 })));
  }
  const raw = new InMemoryAsyncEventStore();
  const eventStore = copyPrefix ? raw : withoutCopyPrefix(raw);
  const snapshotStore = new InMemoryAsyncSnapshotStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore,
    effectRuntime: effects,
    now: () => 1_000,
    onWarn: () => {},
  });
  runtime.registerFlow(definition, runner);
  return { runtime, eventStore, snapshotStore };
}
type App = ReturnType<typeof boot>;

async function toGate(app: App, id: string, gates: 1 | 2): Promise<void> {
  const h = await app.runtime.start({ definition, runner }, { n: 1 }, { executionId: id });
  await h.waitForSuspend();
  if (gates === 2) {
    const r = await app.runtime.resume(id, { eventType: "go1", payload: { answer: "go1" } });
    await r.waitForSuspend();
  }
}

/** The state `fork()` must return at `at`: the same fork on a never-compacted twin. */
async function reference(gates: 1 | 2, at: number): Promise<ExecutionState> {
  const app = boot();
  await toGate(app, "twin", gates);
  return (await app.runtime.fork("twin", at, { executionId: "ref" })).state;
}

/** Compare states across two executions: only the child id differs. */
const same = (a: ExecutionState, b: ExecutionState) =>
  expect({ ...a, executionId: "_" }).toEqual({ ...b, executionId: "_" });

async function nothingWritten(app: App, child: string): Promise<void> {
  expect(await app.eventStore.read(child)).toEqual([]);
  expect(await app.snapshotStore.loadLatest(child)).toBeNull();
}

describe.each([
  ["native copyPrefix", true],
  ["event-by-event copy", false],
])("ADR 0107 (A) — fork of a compacted parent (%s)", (_label, copyPrefix) => {
  it("compacted through its tip ([0]): the checkpoint is forkable, served exactly, and the child resumes", async () => {
    const app = boot(copyPrefix);
    await toGate(app, "p", 1);
    const tip = (await app.eventStore.head("p"))!;
    expect(await new LogLifecycle(app.eventStore, app.snapshotStore).compact("p")).toBe(tip);
    expect((await app.eventStore.read("p")).map((e) => e.sequence)).toEqual([0]);

    // Before ADR 0107 this was "valid range 0..0": the checkpoint sat above the log's tip.
    const child = await app.runtime.fork("p", tip, { executionId: "c" });
    same(child.state, await reference(1, tip));
    expect(child.state.status).toBe("suspended");
    // The child has the parent's shape: `[0]` with its seed as the checkpoint above it.
    expect((await app.eventStore.read("c")).map((e) => e.sequence)).toEqual([0]);
    expect((await app.snapshotStore.loadLatest("c"))?.sequence).toBe(tip);

    const h = await app.runtime.resume("c", { eventType: "go1", payload: { answer: "go1" } });
    await h.waitForSuspend();
    expect((await app.runtime.loadState("c"))?.suspendedOn?.on).toBe("go2");
    expect(await app.eventStore.read("")).toEqual([]);
  });

  it("refuses every point inside the hole, writes nothing, and names the lowest forkable sequence", async () => {
    const app = boot(copyPrefix);
    await toGate(app, "p", 1);
    const tip = (await app.eventStore.head("p"))!;
    await new LogLifecycle(app.eventStore, app.snapshotStore).compact("p");
    for (let at = 1; at < tip; at++) {
      const err = await app.runtime.fork("p", at, { executionId: `c${at}` }).catch((e) => e);
      expect(err).toBeInstanceOf(CompactedForkPointError);
      expect(err).toMatchObject({ reason: "compacted", atSequence: at, forkableFrom: tip });
      await nothingWritten(app, `c${at}`);
    }
    // Sequence 0 survives every compaction, so its state is exact.
    same((await app.runtime.fork("p", 0, { executionId: "z" })).state, await reference(1, 0));
    // Past every event AND every snapshot is out of range, named against the folded tip.
    await expect(app.runtime.fork("p", tip + 1)).rejects.toThrow(`valid range 0..${tip}`);
  });

  it("an older suspend snapshot below a later checkpoint is forkable, served exactly", async () => {
    const app = boot(copyPrefix);
    await toGate(app, "p", 1);
    const gate1 = (await app.eventStore.head("p"))!;
    const r = await app.runtime.resume("p", { eventType: "go1", payload: { answer: "go1" } });
    await r.waitForSuspend();
    const gate2 = (await app.eventStore.head("p"))!;
    await new LogLifecycle(app.eventStore, app.snapshotStore).compact("p");

    const child = await app.runtime.fork("p", gate1, { executionId: "c" });
    same(child.state, await reference(2, gate1));
    expect(child.state.suspendedOn?.on).toBe("go1");
    // Between the two snapshots nothing anchors the fold.
    await expect(app.runtime.fork("p", gate1 + 1)).rejects.toBeInstanceOf(CompactedForkPointError);
    same((await app.runtime.fork("p", gate2)).state, await reference(2, gate2));
  });

  it("a pinned event kept ABOVE the checkpoint: the checkpoint and everything above it are forkable", async () => {
    const app = boot(copyPrefix);
    await toGate(app, "p", 1);
    const tip = (await app.eventStore.head("p"))!;
    const life = new LogLifecycle(app.eventStore, app.snapshotStore, {
      pinnedEventTypes: [FINDING],
    });
    const through = (await life.compact("p"))!;
    const log = await app.eventStore.read("p");
    const kept = log.find((e) => e.eventType === FINDING)!.sequence;
    expect(log.map((e) => e.sequence)).toEqual([0, kept, tip]);
    expect(kept).toBe(through + 1); // the finding directly precedes the suspend

    // At the checkpoint's own (removed) slot: only the bootstrap survives below it, so the
    // child is `[0]` seeded at the checkpoint — a legal shape.
    const atCheckpoint = await app.runtime.fork("p", through, { executionId: "cc" });
    same(atCheckpoint.state, await reference(1, through));
    expect((await app.eventStore.read("cc")).map((e) => e.sequence)).toEqual([0]);
    for (const at of [kept, tip]) {
      same((await app.runtime.fork("p", at)).state, await reference(1, at));
    }
    const below = await app.runtime.fork("p", through - 1).catch((e) => e);
    expect(below).toMatchObject({ reason: "compacted", forkableFrom: through });
  });

  it("a pinned event kept BELOW the checkpoint: the tail is forkable, the checkpoint's slot and the kept event are not", async () => {
    const app = boot(copyPrefix);
    await toGate(app, "p", 2);
    const tip = (await app.eventStore.head("p"))!;
    const life = new LogLifecycle(app.eventStore, app.snapshotStore, {
      pinnedEventTypes: [FINDING],
    });
    const through = await life.compact("p");
    expect(through).toBe(tip - 1); // the tip rule: the tip survives, the checkpoint sits below
    const log = await app.eventStore.read("p");
    const kept = log.find((e) => e.eventType === FINDING)!.sequence;
    expect(log.map((e) => e.sequence)).toEqual([0, kept, tip]);

    // Above the checkpoint every event survives: exact, and the child copies the kept event.
    const child = await app.runtime.fork("p", tip, { executionId: "c" });
    same(child.state, await reference(2, tip));
    expect((await app.eventStore.read("c")).map((e) => e.sequence)).toEqual([0, kept, tip]);

    // AT the checkpoint the state is exact, but the child would be `[0, kept]` with its seed
    // above that tip — a shape readers take for a never-compacted log. Refused.
    const atCheckpoint = await app.runtime
      .fork("p", through!, { executionId: "cc" })
      .catch((e) => e);
    expect(atCheckpoint).toMatchObject({
      reason: "checkpoint-above-prefix",
      forkableFrom: tip,
    });
    await nothingWritten(app, "cc");
    // The kept event survives, but the state around it does not.
    const atKept = await app.runtime.fork("p", kept, { executionId: "ck" }).catch((e) => e);
    expect(atKept).toMatchObject({ reason: "compacted", forkableFrom: tip });
    await nothingWritten(app, "ck");
  });

  it("a gapped parent whose checkpoint is gone is refused — no snapshot anchors anything above 0", async () => {
    const app = boot(copyPrefix);
    await toGate(app, "p", 2);
    const tip = (await app.eventStore.head("p"))!;
    const life = new LogLifecycle(app.eventStore, app.snapshotStore, {
      pinnedEventTypes: [FINDING],
    });
    await life.compact("p");
    await app.snapshotStore.deleteExecution!("p");
    // Before ADR 0107 this folded `[0, kept, tip]` from scratch: a plausible, wrong state.
    const err = await app.runtime.fork("p", tip, { executionId: "c" }).catch((e) => e);
    expect(err).toMatchObject({ reason: "compacted", forkableFrom: null });
    await nothingWritten(app, "c");
  });

  it("a never-compacted parent forks at every position, as before", async () => {
    const app = boot(copyPrefix);
    await toGate(app, "p", 2);
    const tip = (await app.eventStore.head("p"))!;
    for (let at = 0; at <= tip; at++) {
      const child = await app.runtime.fork("p", at, { executionId: `c${at}` });
      expect((await app.eventStore.read(`c${at}`)).length).toBe(at + 1);
      same(child.state, await reference(2, at));
    }
    await expect(app.runtime.fork("p", tip + 1)).rejects.toThrow(`valid range 0..${tip}`);
  });
});

describe("ADR 0107 — the blank executionId is reserved", () => {
  it("start, resume, resumeAs, cancel, fork and restoreFromState refuse it; loadState finds nothing", async () => {
    const app = boot();
    await toGate(app, "p", 1);
    // A stray event, as the pre-0106 bug left them.
    await app.eventStore.append({
      id: "-9",
      workflowId: "",
      executionId: "",
      eventType: "EXECUTION_SUSPENDED",
      sequence: 9,
      timestamp: 1,
      payload: { condition: { on: "go2" } },
    });
    const state = (await app.runtime.loadState("p"))!;
    const refusals = [
      app.runtime.start({ definition, runner }, { n: 1 }, { executionId: "" }),
      app.runtime.resume("", { eventType: "go2", payload: {} }),
      app.runtime.resumeAs(
        "",
        FLOW,
        { eventType: "go2", payload: {} },
        { strategy: "operator-ack" }
      ),
      app.runtime.cancel(""),
      app.runtime.fork("", 9),
      app.runtime.fork("p", 0, { executionId: "" }),
      app.runtime.restoreFromState({ ...state, executionId: "" }),
    ];
    for (const r of refusals) await expect(r).rejects.toThrow(/reserved: a blank identity/);
    expect(await app.runtime.loadState("")).toBeNull();
    expect((await app.eventStore.read("")).map((e) => e.id)).toEqual(["-9"]);
    await expect(new LogLifecycle(app.eventStore, app.snapshotStore).compact("")).rejects.toThrow(
      /blank id names no execution/
    );
  });
});
