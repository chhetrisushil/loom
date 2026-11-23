import { schedule$, step$ } from "@loomwork/core";
import type { FlowDefinition } from "@loomwork/core";
import { EffectRuntime, ToolEffect } from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loomwork/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TimerService } from "./TimerService";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { ExecutionAuthzRequest, FlowRunner } from "./types";

// ADR 0150 D12 / ADR 0152 D2 (slice-2 S10a): committed() carries the recorded principal of a SCHEDULED start.

const io = { inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }) };
const echo = step$({ id: "echo", name: "Echo", toolId: "echo", ...io });
const runner: FlowRunner<Record<string, never>, { ok: boolean }> = async (ctx) => ctx.run(echo, {});
const definition: FlowDefinition<Record<string, never>, { ok: boolean }> = {
  _tag: "FlowDefinition",
  id: "tick-flow",
  name: "tick-flow",
  version: "1.0.0",
  ...io,
  steps: [echo],
};
const every = schedule$<Record<string, never>>({
  id: "s",
  cron: "* * * * *",
  flowId: "tick-flow",
  input: {},
});
const MINUTE = 60_000;
const NOW = 28_333_334 * MINUTE + MINUTE / 2;
const first = (Math.floor(NOW / MINUTE) + 1) * MINUTE;

function boot() {
  const committed: ExecutionAuthzRequest[] = [];
  const effects = new EffectRuntime();
  effects.register("echo", new ToolEffect(async () => ({ ok: true })));
  const timerStore = new InMemoryTimerStore();
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    timerStore,
    executionAuthorizer: {
      authorize: () => ({ allowed: true }),
      committed: (r) => void committed.push(r),
    },
    executionAuthz: { requirePrincipal: true },
  });
  runtime.registerFlow(definition, runner as FlowRunner<unknown, unknown>);
  return { runtime, timerStore, committed };
}
const alice = { actor: "alice", tenant: "acme" };

describe("committed() for a scheduled start (ADR 0150 D12, S10a)", () => {
  it("receives the principal the hook named, under requirePrincipal", async () => {
    // Kills: notifyStarted still withholding the principal of every system-granted start (owner stays unknown).
    const app = boot();
    await new TimerService(app.runtime, app.timerStore, {
      schedules: [every],
      now: () => NOW,
      principalFor: () => alice,
    }).tick(first);
    expect(app.committed).toHaveLength(1);
    expect(app.committed[0]).toMatchObject({ executionId: `s@${first}`, principal: alice });
    expect(app.committed[0]?.parentExecutionId).toBeUndefined();
  });

  it("a scheduled start with no hook still presents no principal", async () => {
    // Kills: inventing a principal (system or default) for an anonymous occurrence.
    const app = boot();
    await new TimerService(app.runtime, app.timerStore, {
      schedules: [every],
      now: () => NOW,
    }).tick(first);
    expect(app.committed).toHaveLength(1);
    expect(app.committed[0]?.principal).toBeUndefined();
  });

  it("a PARENTED system start (a supervised child) still withholds its principal", async () => {
    // Kills: carrying the principal for ALL system starts, which would make a child's delegation identity the owner.
    const app = boot();
    await app.runtime.start(
      definition as never,
      {} as never,
      {
        executionId: "child-1",
        principal: alice,
        parentExecutionId: "parent-1",
        ...app.runtime.systemOptions(),
      } as never
    );
    const c = app.committed.find((r) => r.executionId === "child-1");
    expect(c?.principal).toBeUndefined();
    expect(c?.parentExecutionId).toBe("parent-1");
  });
});
