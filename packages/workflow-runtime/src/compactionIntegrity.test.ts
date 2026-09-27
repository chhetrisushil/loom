import { step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { ReplayVM } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ExecutionJournal } from "./ExecutionJournal";
import { LogLifecycle } from "./LogLifecycle";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { SnapshotIdentityMismatchError } from "./types";
import type { ExecutionAuthorizer, FlowRunner, PrincipalChain } from "./types";

// L11 (ADR 0106) — compaction must be invisible to everything that reads the log afterwards:
// a resume across one compaction, or two, produces the same log suffix and the same state as
// the same execution never compacted; the checkpoint names its execution; and an app's
// pinned event kinds survive it (ADR 0055 D1).

const io = z.object({ n: z.number() });
const s1 = step$({ id: "s1", name: "s1", toolId: "t1", inputSchema: io, outputSchema: io });
const s2 = step$({ id: "s2", name: "s2", toolId: "t2", inputSchema: io, outputSchema: io });
const s3 = step$({ id: "s3", name: "s3", toolId: "t3", inputSchema: io, outputSchema: io });

const FLOW = "compaction-flow";
const FINDING = "FINDING_RECORDED";

const definition: FlowDefinition<{ n: number }, { n: number }> = {
  _tag: "FlowDefinition",
  id: FLOW,
  name: FLOW,
  version: "2.3.0",
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

const alice: PrincipalChain = { tenant: "acme", actor: "alice" };
const mallory: PrincipalChain = { tenant: "evil", actor: "mallory" };
const acmeOnly: ExecutionAuthorizer = {
  authorize: (req) =>
    req.principal?.tenant === "acme" ? { allowed: true } : { allowed: false, reason: "nope" },
};

function boot(opts: { authorizer?: ExecutionAuthorizer } = {}) {
  const warnings: string[] = [];
  const calls = { t1: 0, t2: 0, t3: 0 };
  const effects = new EffectRuntime();
  for (const id of ["t1", "t2", "t3"] as const) {
    effects.register(
      id,
      new ToolEffect(async (x: { n: number }) => {
        calls[id]++;
        return { n: x.n + 1 };
      })
    );
  }
  const eventStore = new InMemoryAsyncEventStore();
  const snapshotStore = new InMemoryAsyncSnapshotStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore,
    effectRuntime: effects,
    now: () => 1_000,
    onWarn: (m) => warnings.push(m),
    ...(opts.authorizer !== undefined && { executionAuthorizer: opts.authorizer }),
  });
  runtime.registerFlow(definition, runner);
  return { runtime, eventStore, snapshotStore, calls, warnings };
}

type App = ReturnType<typeof boot>;

async function toFirstGate(app: App, id: string): Promise<void> {
  const h = await app.runtime.start({ definition, runner }, { n: 1 }, { executionId: id });
  await h.waitForSuspend();
}

async function resume(app: App, id: string, on: string) {
  // Non-empty answers: an empty `{}` is indistinguishable from a pre-0104 stray passthrough
  // once compaction removed the RESUMED events around it (ADR 0104's classifier would warn).
  const h = await app.runtime.resume(id, { eventType: on, payload: { answer: on } });
  return on === "go2" ? h.waitForCompletion() : h.waitForSuspend();
}

/** The events of `log` above `floor`, keyed for comparison with the uncompacted control. */
const above = (log: EventEnvelope[], floor: number) => log.filter((e) => e.sequence > floor);

async function control() {
  const app = boot();
  await toFirstGate(app, "e");
  const atGate1 = await app.runtime.loadState("e");
  await resume(app, "e", "go1");
  const atGate2 = await app.runtime.loadState("e");
  await resume(app, "e", "go2");
  const done = await app.runtime.loadState("e");
  return { log: await app.eventStore.read("e"), atGate1, atGate2, done, calls: app.calls };
}

describe("L11 (a) — resume after compaction", () => {
  it("a resume across a compaction lands in the execution's own log and folds identically", async () => {
    const want = await control();
    const app = boot();
    await toFirstGate(app, "e");
    const through = await new LogLifecycle(app.eventStore, app.snapshotStore).compact("e");
    expect(through).not.toBeNull();

    await resume(app, "e", "go1");
    // Nothing was written anywhere but the execution's own log.
    expect(await app.eventStore.read("")).toEqual([]);
    const log = await app.eventStore.read("e");
    const gate2Tip = want.atGate2!.sequence;
    expect(above(log, through!)).toEqual(
      above(want.log, through!).filter((e) => e.sequence <= gate2Tip)
    );
    expect(await app.runtime.loadState("e")).toEqual(want.atGate2);
  });

  it("two compactions, a resume across each — same final log suffix, state and effect count", async () => {
    const want = await control();
    const app = boot();
    const life = new LogLifecycle(app.eventStore, app.snapshotStore);
    await toFirstGate(app, "e");
    await life.compact("e");
    await resume(app, "e", "go1");
    const second = await life.compact("e");
    expect(second).toBe(want.atGate2!.sequence);

    // The second checkpoint folded ON the first: s1's recorded output survives, so the
    // resumed runner serves it from the fold instead of re-running the effect.
    const checkpoint = await app.snapshotStore.loadLatest("e");
    expect(checkpoint!.state).toEqual(want.atGate2);

    await resume(app, "e", "go2");
    expect(app.calls).toEqual(want.calls);
    expect(above(await app.eventStore.read("e"), second!)).toEqual(above(want.log, second!));
    expect(await app.runtime.loadState("e")).toEqual(want.done);
  });

  it("refuses to compact a gapped log whose checkpoint is missing (the fold would be wrong)", async () => {
    const app = boot();
    const life = new LogLifecycle(app.eventStore, app.snapshotStore);
    await toFirstGate(app, "e");
    await life.compact("e");
    await resume(app, "e", "go1");
    await app.snapshotStore.deleteExecution!("e");
    const before = await app.eventStore.read("e");
    await expect(life.compact("e")).rejects.toThrow(/checkpoint/);
    expect(await app.eventStore.read("e")).toEqual(before);
  });
});

describe("L11 (b) — the checkpoint names its execution", () => {
  it("seeds executionId/workflowId from the log, not empty strings", async () => {
    const app = boot();
    const h = await app.runtime.start({ definition, runner }, { n: 1 }, { executionId: "b1" });
    await h.waitForSuspend();
    await new LogLifecycle(app.eventStore, app.snapshotStore).compact("b1");
    const snap = await app.snapshotStore.loadLatest("b1");
    expect(snap!.state.executionId).toBe("b1");
    expect(snap!.state.workflowId).toBe(FLOW);
    // The suspend checkpoint the runtime took carried the version; compaction keeps it.
    expect(snap!.state.workflowVersion).toBe("2.3.0");
  });

  it("a checkpoint with blank identity (written before the fix) still resumes into its own log", async () => {
    const want = await control();
    const app = boot();
    await toFirstGate(app, "e");
    const tip = (await app.eventStore.head("e"))!;
    const state = (await app.runtime.loadState("e"))!;
    await app.snapshotStore.save({
      id: "legacy",
      executionId: "e",
      workflowId: FLOW,
      sequence: tip,
      state: { ...state, executionId: "", workflowId: "", workflowVersion: "" },
      createdAt: 0,
    });
    await app.eventStore.truncatePrefix("e", tip);
    await resume(app, "e", "go1");
    expect(await app.eventStore.read("")).toEqual([]);
    expect(await app.runtime.loadState("e")).toEqual(want.atGate2);
  });
});

describe("L11 (c) — pinned event kinds survive compaction (ADR 0055 D1)", () => {
  it("keeps every pinned-kind event through two compactions; the fold is unchanged", async () => {
    const want = await control();
    const app = boot();
    const life = new LogLifecycle(app.eventStore, app.snapshotStore, {
      pinnedEventTypes: [FINDING],
    });
    await toFirstGate(app, "e");
    const finding = (await app.eventStore.read("e")).find((e) => e.eventType === FINDING)!;
    await life.compact("e");
    expect((await app.eventStore.read("e")).filter((e) => e.eventType === FINDING)).toEqual([
      finding,
    ]);
    await resume(app, "e", "go1");
    await life.compact("e");
    await resume(app, "e", "go2");

    const log = await app.eventStore.read("e");
    expect(log.filter((e) => e.eventType === FINDING)).toEqual([finding]);
    expect(await app.runtime.loadState("e")).toEqual(want.done);
    expect(app.calls).toEqual(want.calls);
  });

  it("a pinned execution is not compacted when no pinned event kinds are declared", async () => {
    const app = boot();
    await toFirstGate(app, "e");
    const before = await app.eventStore.read("e");
    const life = new LogLifecycle(app.eventStore, app.snapshotStore, { pinned: () => true });
    expect(await life.compact("e")).toBeNull();
    expect(await app.eventStore.read("e")).toEqual(before);
  });
});

describe("L11 (c) — the edges of keeping pinned kinds", () => {
  it("on a store without truncatePrefixKeeping, compaction stops below the first kept event — and says so", async () => {
    const app = boot();
    await toFirstGate(app, "e");
    await resume(app, "e", "go1"); // a non-kept tail above the finding
    const inner = app.eventStore;
    // The SPI 1.4.0 surface: truncatePrefix, no truncatePrefixKeeping.
    const legacy = {
      append: inner.append.bind(inner),
      read: inner.read.bind(inner),
      readFrom: inner.readFrom.bind(inner),
      subscribe: inner.subscribe.bind(inner),
      close: inner.close.bind(inner),
      truncatePrefix: inner.truncatePrefix.bind(inner),
    };
    const before = await inner.read("e");
    const finding = before.find((e) => e.eventType === FINDING)!;
    const warned: string[] = [];
    const life = new LogLifecycle(legacy, app.snapshotStore, {
      pinnedEventTypes: [FINDING],
      onWarn: (m) => warned.push(m),
    });
    const through = await life.compact("e");
    expect(through).toBe(finding.sequence - 1);
    expect(warned).toEqual([expect.stringMatching(/truncatePrefixKeeping.*never be compacted/)]);
    const after = await inner.read("e");
    expect(after.map((e) => e.sequence)).toEqual(
      before.filter((e) => e.sequence === 0 || e.sequence > through!).map((e) => e.sequence)
    );
    // Every later pass is stuck below the finding, and warns again.
    expect(await life.compact("e")).toBeNull();
    expect(warned).toHaveLength(2);
    await resume(app, "e", "go2");
    expect((await app.runtime.loadState("e"))?.status).toBe("completed");
  });

  it("refuses kernel event kinds — including the kernel's own resume signals — and non-strings", () => {
    const app = boot();
    const lifeWith = (pinnedEventTypes: unknown[]) => () =>
      new LogLifecycle(app.eventStore, app.snapshotStore, {
        pinnedEventTypes: pinnedEventTypes as string[],
      });
    expect(lifeWith([FINDING, "STEP_COMPLETED"])).toThrow(/STEP_COMPLETED/);
    expect(lifeWith(["EXECUTION_RECOVERED"])).toThrow(/EXECUTION_RECOVERED/);
    expect(lifeWith(["EffectInDoubtResolved"])).toThrow(/EffectInDoubtResolved/);
    expect(lifeWith([""])).toThrow(/non-empty strings/);
    expect(lifeWith([null])).toThrow(/non-empty strings/);
    expect(lifeWith([FINDING])).not.toThrow();
  });

  it("retention reads a log compacted around a kept event as the terminal execution it is", async () => {
    const app = boot();
    const at = (sequence: number, eventType: string, payload: unknown): EventEnvelope => ({
      id: `r-${sequence}`,
      workflowId: FLOW,
      executionId: "r",
      eventType,
      sequence,
      timestamp: 10,
      payload,
    });
    await app.eventStore.append(at(0, "EXECUTION_STARTED", { input: { n: 1 } }));
    await app.eventStore.append(at(1, "STEP_STARTED", { stepId: "s1" }));
    await app.eventStore.append(at(2, FINDING, { finding: "f" }));
    await app.eventStore.append(at(3, "STEP_COMPLETED", { stepId: "s1", output: { n: 2 } }));
    await app.eventStore.append(at(4, "EXECUTION_COMPLETED", { output: { n: 2 } }));
    const life = new LogLifecycle(app.eventStore, app.snapshotStore, {
      pinnedEventTypes: [FINDING],
    });
    // The tip rule: kept events survive, so the tip does too and the checkpoint is below it.
    expect(await life.compact("r")).toBe(3);
    expect((await app.eventStore.read("r")).map((e) => e.sequence)).toEqual([0, 2, 4]);
    expect(await life.evaluate("r", { terminalTtlMs: 0 }, 1_000)).toBe("reclaimable");
    expect(await life.compact("r")).toBeNull();
  });

  it("the tip rule — with kept events, compaction never removes the tip", async () => {
    const app = boot();
    const life = new LogLifecycle(app.eventStore, app.snapshotStore, {
      pinnedEventTypes: [FINDING],
    });
    await toFirstGate(app, "e");
    await resume(app, "e", "go1");
    const before = await app.eventStore.read("e");
    const tip = before.at(-1)!.sequence;
    const through = await life.compact("e");
    expect(through).toBe(tip - 1);
    const after = await app.eventStore.read("e");
    expect(after.at(-1)!.sequence).toBe(tip);
    // The checkpoint's slot is the highest missing sequence.
    expect(after.some((e) => e.sequence === through)).toBe(false);
    expect((await app.snapshotStore.loadLatestBefore("e", through!))?.sequence).toBe(through);
  });

  it("a pinned execution is never compacted, even with pinnedEventTypes declared (ADR 0055 D1)", async () => {
    const app = boot();
    await toFirstGate(app, "e");
    const before = await app.eventStore.read("e");
    const life = new LogLifecycle(app.eventStore, app.snapshotStore, {
      pinned: () => true,
      pinnedEventTypes: [FINDING],
    });
    expect(await life.compact("e")).toBeNull();
    expect(await app.eventStore.read("e")).toEqual(before);
  });

  it("compaction runs print no stray-passthrough warning (ADR 0104)", async () => {
    const app = boot();
    const life = new LogLifecycle(app.eventStore, app.snapshotStore, {
      pinnedEventTypes: [FINDING],
    });
    await toFirstGate(app, "e");
    await life.compact("e");
    await resume(app, "e", "go1");
    await life.compact("e");
    await resume(app, "e", "go2");
    expect(app.warnings).toEqual([]);
  });
});

describe("L11 P1 — a denied resume never writes into the checkpoint's slot", () => {
  const flowOneGate: FlowRunner<{ n: number }, { n: number }> = async (ctx, input) => {
    await ctx.suspend({ on: "go1" });
    return input;
  };

  it("finding then suspend: compact, unauthorized resume, compact again — still suspended", async () => {
    const app = boot({ authorizer: acmeOnly });
    const life = new LogLifecycle(app.eventStore, app.snapshotStore, {
      pinnedEventTypes: [FINDING],
    });
    const h = await app.runtime.start(
      { definition, runner },
      { n: 1 },
      {
        executionId: "d",
        principal: alice,
      }
    );
    await h.waitForSuspend();
    const want = await app.runtime.loadState("d");
    const first = await life.compact("d");
    await expect(
      app.runtime.resume("d", { eventType: "go1", payload: { a: 1 } }, { principal: mallory })
    ).rejects.toThrow(/denied/);
    const denied = (await app.eventStore.read("d")).find((e) => e.eventType === "EXECUTION_DENIED");
    expect(denied!.sequence).toBeGreaterThan(first!);
    await life.compact("d");
    const state = await app.runtime.loadState("d");
    expect(state?.status).toBe("suspended");
    expect(state?.suspendedOn).toEqual(want?.suspendedOn);
    const r = await app.runtime.resume(
      "d",
      { eventType: "go1", payload: { a: 1 } },
      {
        principal: alice,
      }
    );
    expect((await r.waitForSuspend()).suspendedOn?.on).toBe("go2");
  });

  it("immediate suspend (log [0] after compaction, checkpoint above the tip) — the denial lands above the checkpoint", async () => {
    const app = boot({ authorizer: acmeOnly });
    const def = { ...definition, id: "one-gate", name: "one-gate", steps: [] };
    app.runtime.registerFlow(def, flowOneGate);
    const h = await app.runtime.start(
      { definition: def, runner: flowOneGate },
      { n: 1 },
      {
        executionId: "i",
        principal: alice,
      }
    );
    await h.waitForSuspend();
    const life = new LogLifecycle(app.eventStore, app.snapshotStore);
    const through = await life.compact("i");
    expect((await app.eventStore.read("i")).map((e) => e.sequence)).toEqual([0]);
    await expect(
      app.runtime.resume("i", { eventType: "go1", payload: { a: 1 } }, { principal: mallory })
    ).rejects.toThrow(/denied/);
    const log = await app.eventStore.read("i");
    expect(log.map((e) => e.sequence)).toEqual([0, through! + 1]);
    await life.compact("i");
    expect((await app.runtime.loadState("i"))?.status).toBe("suspended");
    const r = await app.runtime.resume(
      "i",
      { eventType: "go1", payload: { a: 1 } },
      {
        principal: alice,
      }
    );
    expect((await r.waitForCompletion()).status).toBe("completed");
  });
});

describe("L11 P3 — identity at every snapshot-seeded path", () => {
  /** Suspend at go1, then replace every snapshot with one blank checkpoint and compact. */
  async function legacyCheckpoint(app: App, id: string): Promise<number> {
    await toFirstGate(app, id);
    const tip = (await app.eventStore.head(id))!;
    const state = (await app.runtime.loadState(id))!;
    await app.snapshotStore.deleteExecution!(id);
    await app.snapshotStore.save({
      id: `legacy-${id}`,
      executionId: id,
      workflowId: FLOW,
      sequence: tip,
      state: { ...state, executionId: "", workflowId: "", workflowVersion: "" },
      createdAt: 0,
    });
    await app.eventStore.truncatePrefix(id, tip);
    return tip;
  }

  it("resumeAs over a blank checkpoint writes into the execution's own log", async () => {
    const app = boot();
    await legacyCheckpoint(app, "e");
    const h = await app.runtime.resumeAs(
      "e",
      FLOW,
      { eventType: "go1", payload: { answer: "go1" } },
      { strategy: "operator-ack" }
    );
    const parked = await h.waitForSuspend();
    expect(parked.executionId).toBe("e");
    expect(parked.workflowId).toBe(FLOW);
    expect(parked.workflowVersion).toBe("2.3.0");
    expect(await app.eventStore.read("")).toEqual([]);
    expect((await app.eventStore.read("e")).some((e) => e.eventType === "EXECUTION_MIGRATED")).toBe(
      true
    );
  });

  it("loadState over a blank checkpoint names the execution and the registered version", async () => {
    const app = boot();
    await legacyCheckpoint(app, "e");
    const state = await app.runtime.loadState("e");
    expect(state?.executionId).toBe("e");
    expect(state?.workflowId).toBe(FLOW);
    expect(state?.workflowVersion).toBe("2.3.0");
  });

  it("cancel over a blank checkpoint records EXECUTION_CANCELLED under the right workflow", async () => {
    const app = boot();
    await legacyCheckpoint(app, "e");
    expect(await app.runtime.cancel("e", "stop")).toBe(true);
    const cancelled = (await app.eventStore.read("e")).find(
      (e) => e.eventType === "EXECUTION_CANCELLED"
    );
    expect(cancelled?.workflowId).toBe(FLOW);
    expect((await app.runtime.loadState("e"))?.status).toBe("cancelled");
  });

  it("fork at a blank checkpoint takes the workflowId from the log (the || chain)", async () => {
    const app = boot();
    await toFirstGate(app, "e");
    const tip = (await app.eventStore.head("e"))!;
    const log = await app.eventStore.read("e");
    const state = new ReplayVM(log.filter((e) => e.sequence < tip)).getState();
    await app.snapshotStore.deleteExecution!("e");
    await app.snapshotStore.save({
      id: "legacy",
      executionId: "e",
      workflowId: FLOW,
      sequence: tip - 1,
      state: { ...state, executionId: "", workflowId: "", workflowVersion: "" },
      createdAt: 0,
    });
    await app.eventStore.truncatePrefix("e", tip - 1); // [0, tip], blank checkpoint at tip − 1
    // At the checkpoint: no window events above it, so the anchor (sequence 0) names it.
    const atCheckpoint = await app.runtime.fork("e", tip - 1, { executionId: "c1" });
    expect(atCheckpoint.state.workflowId).toBe(FLOW);
    expect(atCheckpoint.state.executionId).toBe("c1");
    expect((await app.snapshotStore.loadLatest("c1"))?.workflowId).toBe(FLOW);
    // At the tip: the window event above the blank checkpoint names it.
    const atTip = await app.runtime.fork("e", tip, { executionId: "c2" });
    expect(atTip.state.workflowId).toBe(FLOW);
    expect(atTip.state.status).toBe("suspended");
    const h = await app.runtime.resume("c2", { eventType: "go1", payload: { answer: "go1" } });
    await h.waitForSuspend();
    expect(await app.eventStore.read("")).toEqual([]);
  });

  it("a NON-blank snapshot naming another execution is refused, not papered over", async () => {
    const app = boot();
    await toFirstGate(app, "e");
    const tip = (await app.eventStore.head("e"))!;
    const state = (await app.runtime.loadState("e"))!;
    await app.snapshotStore.save({
      id: "foreign",
      executionId: "e",
      workflowId: FLOW,
      sequence: tip,
      state: { ...state, executionId: "someone-else" },
      createdAt: 0,
    });
    const before = await app.eventStore.read("e");
    await expect(
      app.runtime.resume("e", { eventType: "go1", payload: { answer: "go1" } })
    ).rejects.toThrow(SnapshotIdentityMismatchError);
    await expect(app.runtime.loadState("e")).rejects.toThrow(SnapshotIdentityMismatchError);
    expect(await app.eventStore.read("e")).toEqual(before);
  });

  it("the journal writes under the identity it was given, not the vm state's", async () => {
    const store = new InMemoryAsyncEventStore();
    const vm = new ReplayVM([], { executionId: "wrong", workflowId: "other", workflowVersion: "" });
    const journal = new ExecutionJournal(
      store,
      { executionId: "right", workflowId: FLOW },
      vm,
      undefined,
      () => {}
    );
    journal.commit("SOMETHING_HAPPENED", { x: 1 });
    await journal.drain();
    const [event] = await store.read("right");
    expect(event).toMatchObject({ executionId: "right", workflowId: FLOW, id: "right-0" });
    expect(await store.read("wrong")).toEqual([]);
  });

  it("the journal refuses a blank identity — a legacy restoreFromState state writes nothing", async () => {
    const store = new InMemoryAsyncEventStore();
    expect(
      () =>
        new ExecutionJournal(
          store,
          { executionId: "", workflowId: FLOW },
          new ReplayVM([]),
          undefined,
          () => {}
        )
    ).toThrow(/blank identity/);
    const app = boot();
    await toFirstGate(app, "e");
    const state = (await app.runtime.loadState("e"))!;
    await expect(
      app.runtime.restoreFromState(
        { ...state, executionId: "" },
        { eventType: "go1", payload: { answer: "go1" } }
      )
    ).rejects.toThrow(/blank identity/);
    expect(await app.eventStore.read("")).toEqual([]);
  });

  it("the gap path fills a legacy blank workflowVersion from the latest snapshot", async () => {
    const app = boot();
    await legacyCheckpoint(app, "e");
    await resume(app, "e", "go1"); // the runtime's suspend checkpoint at the tip carries 2.3.0
    // Keep the gate event so the tip rule compacts BELOW the tip, onto the legacy base.
    const life = new LogLifecycle(app.eventStore, app.snapshotStore, { pinnedEventTypes: ["go1"] });
    const through = await life.compact("e");
    const checkpoint = await app.snapshotStore.loadLatestBefore("e", through!);
    expect(checkpoint?.sequence).toBe(through);
    expect(checkpoint?.state.workflowVersion).toBe("2.3.0");
  });
});
