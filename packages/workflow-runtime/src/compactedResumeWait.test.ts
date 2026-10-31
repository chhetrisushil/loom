import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LogLifecycle } from "./LogLifecycle";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { until } from "./__tests__/r2Harness";
import { ExecutionTerminatedError } from "./executionTerminated";
import type { ExecutionHandle, FlowRunner } from "./types";

// Issue #710 — "the second resume of a compacted execution never resolves waitForSuspend".
// Root cause: NOT compaction. In the reported shape (PR #709's 4-gate flow, compacted at gate 3,
// resumed at gates 3 and 4) the second resume answers the LAST gate, so the run COMPLETES, and a
// handle whose run terminated without parking never settled `waitForSuspend` (only
// `waitForCompletion`). The same happened with no compaction at all. The fix is the contract:
// `waitForSuspend` rejects with `ExecutionTerminatedError` on a terminal run. These cases pin that
// compaction is invisible to the handle: every resume's settlement matches the uncompacted control.

const io = z.object({ n: z.number() });
const mk = (i: number) =>
  step$({ id: `s${i}`, name: `s${i}`, toolId: `t${i}`, inputSchema: io, outputSchema: io });
const GATES = 4;
const steps = Array.from({ length: GATES + 1 }, (_, i) => mk(i + 1));

const FLOW = "compacted-resume-wait";
const definition: FlowDefinition<{ n: number }, { n: number }> = {
  _tag: "FlowDefinition",
  id: FLOW,
  name: FLOW,
  version: "1.0.0",
  inputSchema: io,
  outputSchema: io,
  steps,
};

const runner: FlowRunner<{ n: number }, { n: number }> = async (ctx, input) => {
  let v = input;
  for (let i = 0; i < steps.length; i++) {
    v = await ctx.run(steps[i]!, v);
    if (i < GATES) await ctx.suspend({ on: `go${i + 1}` });
  }
  return { n: v.n };
};

type Stores = { eventStore: InMemoryAsyncEventStore; snapshotStore: InMemoryAsyncSnapshotStore };

function boot(stores?: Stores, opts: { snapshotEvery?: number } = {}) {
  const effects = new EffectRuntime();
  for (const s of steps) {
    effects.register(s.toolId!, new ToolEffect(async (x: { n: number }) => ({ n: x.n + 1 })));
  }
  const eventStore = stores?.eventStore ?? new InMemoryAsyncEventStore();
  const snapshotStore = stores?.snapshotStore ?? new InMemoryAsyncSnapshotStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore,
    effectRuntime: effects,
    now: () => 1_000,
    onWarn: () => {},
    ...(opts.snapshotEvery !== undefined && { snapshotEvery: opts.snapshotEvery }),
  });
  runtime.registerFlow(definition, runner);
  return { runtime, eventStore, snapshotStore };
}

type App = ReturnType<typeof boot>;

/**
 * How a resume's handle settled, observed on a CONDITION, never a sleep: wait until the durable
 * state has moved past `gate` (parked on a later gate, or completed), then until the handle has
 * settled the promise that state calls for. A handle that never settles fails `until` (a test
 * failure, not a suite timeout). `waitForSuspend` is then sampled for the terminal case.
 */
async function settlement(app: App, id: string, h: ExecutionHandle, from: number) {
  let suspended: string | undefined;
  let completed: string | undefined;
  void h.waitForSuspend().then(
    (s) => {
      suspended = s.status;
    },
    (e: unknown) => {
      suspended = e instanceof ExecutionTerminatedError ? `terminated:${e.status}` : "rejected";
    }
  );
  void h.waitForCompletion().then(
    (s) => {
      completed = s.status;
    },
    () => {
      completed = "rejected";
    }
  );
  let status: string | undefined;
  await until(async () => {
    const st = await app.runtime.loadState(id);
    status = st?.status;
    return (status === "suspended" || status === "completed") && st!.sequence > from + 1;
  }, 5_000);
  await until(
    () => suspended !== undefined && (status !== "completed" || completed !== undefined),
    5_000
  );
  return { status, suspended, completed };
}

async function resumeGate(app: App, id: string, gate: number) {
  const from = (await app.runtime.loadState(id))!.sequence;
  const h = await app.runtime.resume(id, {
    eventType: `go${gate}`,
    payload: { answer: `go${gate}` },
  });
  return settlement(app, id, h, from);
}

async function toFirstGate(app: App, id: string) {
  const h = await app.runtime.start({ definition, runner }, { n: 1 }, { executionId: id });
  await h.waitForSuspend();
}

const PARKED = { status: "suspended", suspended: "suspended", completed: undefined };
// The last gate: the run completes, so waitForSuspend REJECTS with ExecutionTerminatedError (it
// used to stay pending, which was the reported "hang").
const FINISHED = { status: "completed", suspended: "terminated:completed", completed: "completed" };
const WANT = [PARKED, PARKED, PARKED, FINISHED];

async function scenario(
  compactAt: number | null,
  opts: { snapshotEvery?: number; cold?: boolean } = {}
) {
  let app = boot(undefined, opts);
  await toFirstGate(app, "e");
  const seen = [];
  for (let g = 1; g <= GATES; g++) {
    if (g === compactAt) await new LogLifecycle(app.eventStore, app.snapshotStore).compact("e");
    if (opts.cold === true) app = boot(app, opts); // a fresh runtime per resume (a cold instance)
    seen.push(await resumeGate(app, "e", g));
  }
  return seen;
}

describe("issue #710 — handle settlement across resumes of a compacted execution", () => {
  it("control: no compaction", { timeout: 30_000 }, async () => {
    expect(await scenario(null)).toEqual(WANT);
  });

  it(
    "compact at gate 1: every later resume settles as the control",
    { timeout: 30_000 },
    async () => {
      expect(await scenario(1)).toEqual(WANT);
    }
  );

  it("compact at gate 2", { timeout: 30_000 }, async () => {
    expect(await scenario(2)).toEqual(WANT);
  });

  it(
    "compact at gate 3 (the #709 shape: the second resume is the last gate)",
    { timeout: 30_000 },
    async () => {
      expect(await scenario(3)).toEqual(WANT);
    }
  );

  it("compact at gate 1 with snapshotEvery: 1", { timeout: 30_000 }, async () => {
    expect(await scenario(1, { snapshotEvery: 1 })).toEqual(WANT);
  });

  it("compact at gate 1, a fresh runtime per resume", { timeout: 30_000 }, async () => {
    expect(await scenario(1, { cold: true })).toEqual(WANT);
  });
});
