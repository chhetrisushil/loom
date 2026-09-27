import { step$ } from "@loom/core";
import type { EventEnvelope, ExecutionState, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner } from "./types";

// ── ADR 0105 D3 — a log a REAL 1.20.0 kernel wrote, replayed by 1.21.0 ─────────
//
// A faithful replica of the 1.20.0 fold, in-repo: the 1.20.0 `STEP_FAILED` handler was the
// current one plus `status: "failed"` — nothing else in the fold changed in 1.21.0 — so the
// mocked `ReplayVM` applies the current handler and, while `legacy.on`, sets that status after
// every `STEP_FAILED`. Everything that reads the fold (`answerEvents`, `isStatusOnlyResume`,
// `resumeAs`'s terminal branch) then behaves exactly as the 1.20.0 kernel did, and the log it
// writes is the log that kernel wrote. `normalizeSnapshotState` is the identity while `legacy.on`
// (1.20.0 had none).

const legacy = vi.hoisted(() => ({ on: false }));

vi.mock("@loom/replay-vm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@loom/replay-vm")>();
  type Mutable = { state: ExecutionState };
  class ReplayVM extends actual.ReplayVM {
    constructor(events: EventEnvelope[], initial?: Partial<ExecutionState>) {
      super([], initial);
      for (const e of events) this.applyEvent(e);
    }
    override applyEvent(event: EventEnvelope): void {
      super.applyEvent(event);
      if (legacy.on && event.eventType === "STEP_FAILED") {
        const self = this as unknown as Mutable;
        self.state = { ...self.state, status: "failed" };
      }
    }
  }
  return {
    ...actual,
    ReplayVM,
    normalizeSnapshotState: <T>(s: T): T =>
      legacy.on ? s : (actual.normalizeSnapshotState(s as Partial<ExecutionState>) as T),
  };
});

const io = { inputSchema: z.object({}), outputSchema: z.any() };
const slow = step$({ id: "slow", name: "slow", toolId: "tool-slow", ...io });
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

function boot(stores?: {
  eventStore: InMemoryAsyncEventStore;
  snapshotStore: InMemoryAsyncSnapshotStore;
}) {
  const effects = new EffectRuntime();
  effects.register(
    "tool-slow",
    new ToolEffect(async () => {
      await settle(20);
      throw new Error("late boom");
    })
  );
  const s = stores ?? {
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
  };
  const warnings: string[] = [];
  const runtime = new WorkflowRuntime({
    ...s,
    effectRuntime: effects,
    onWarn: (m) => warnings.push(m),
  });
  const definition: FlowDefinition<Record<string, never>, unknown> = {
    _tag: "FlowDefinition",
    id: "par",
    name: "par",
    version: "1.0.0",
    inputSchema: io.inputSchema,
    outputSchema: io.outputSchema,
    steps: [slow],
  };
  const runner: FlowRunner<Record<string, never>, unknown> = async (ctx) => {
    const [, answer] = await Promise.all([
      ctx.run(slow, {}).catch(() => "caught"),
      ctx.suspend<unknown>({ on: "Approval" }),
    ]);
    return { answer };
  };
  runtime.registerFlow(definition, runner);
  return { runtime, stores: s, warnings, flow: { definition, runner } };
}

describe("a 1.20.0 resumeAs after a late sibling failure, replayed by 1.21.0 (ADR 0105 D3)", () => {
  it("1.20.0 wrote a status-only null; 1.21.0 serves it to the gate, and the runtime warns", async () => {
    const old = boot();
    legacy.on = true;
    try {
      const h = await old.runtime.start(old.flow, {}, { executionId: "x" });
      await h.waitForSuspend();
      await settle(60); // the sibling fails after the park
      // The replica is faithful: the 1.20.0 fold called this parked execution "failed"…
      expect((await old.runtime.loadState("x"))?.status).toBe("failed");

      // …so an operator's resumeAs took the TERMINAL branch and wrote EXECUTION_RESUMED(null).
      const migrated = await old.runtime.resumeAs(
        "x",
        "par",
        { eventType: "Fixup", payload: { note: "operator" } },
        { strategy: "operator-ack" }
      );
      await migrated.waitForSuspend(); // no passthrough under 1.20.0: the gate re-parks
      await settle(60);
      const written = await old.stores.eventStore.read("x");
      expect(written.some((e) => e.eventType === "EXECUTION_RESUMED" && e.payload === null)).toBe(
        true
      );
    } finally {
      legacy.on = false;
    }

    // A copy of the log with NO snapshots, taken before the upgrade touches anything.
    const logOnly = new InMemoryAsyncEventStore();
    await logOnly.appendBatch(await old.stores.eventStore.read("x"));

    // Upgrade: a 1.21.0 process over the same stores. The execution reads parked again…
    const next = boot(old.stores);
    expect((await next.runtime.loadState("x"))?.status).toBe("suspended");
    // …and answering the gate is WARNED about (the log holds the 1.20.0 status-only null).
    const answer = { eventType: "Approval", payload: { ok: true } };
    const viaSnapshot = await (await next.runtime.resume("x", answer)).waitForCompletion();
    expect(next.warnings.some((m) => m.includes("null resume(s)"))).toBe(true);
    // Folded from the 1.20.0 SUSPEND SNAPSHOT (which never counted the null) + tail, the gate
    // takes the operator's answer…
    expect(viaSnapshot.variables._output).toEqual({ answer: { ok: true } });

    // …but folded from the LOG ALONE, 1.21.0 serves the null to the gate first: the gate passes
    // without approval. The outcome of this legacy shape depends on which snapshot exists —
    // recorded in ADR 0105 D3 as the residual the warning covers.
    const bare = boot({ eventStore: logOnly, snapshotStore: new InMemoryAsyncSnapshotStore() });
    const viaLog = await (await bare.runtime.resume("x", answer)).waitForCompletion();
    expect(bare.warnings.some((m) => m.includes("null resume(s)"))).toBe(true);
    expect(viaLog.variables._output).toEqual({ answer: null });
  });
});
