import { schedule$, step$ } from "@loomwork/core";
import type { FlowDefinition } from "@loomwork/core";
import { EffectRuntime, ToolEffect } from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loomwork/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { SchedulePrincipalError, TimerService } from "./TimerService";
import { WorkflowRuntime } from "./WorkflowRuntime";
import {
  ExecutionAlreadyExistsError,
  type FlowRunner,
  type RegisteredFlow,
  StartLeaseHeldError,
} from "./types";

// ── T1.2 — schedule$: cron occurrences with deterministic, idempotent starts ──

const inputSchema = z.object({ label: z.string() });
const outputSchema = z.object({ done: z.boolean() });
type In = { label: string };
type Out = { done: boolean };

const auditStep = step$({
  id: "audit",
  name: "Audit",
  toolId: "audit-tool",
  inputSchema,
  outputSchema,
});

const FLOW = "nightly-audit";

function makeFlow(): RegisteredFlow<In, Out> {
  const runner: FlowRunner<In, Out> = async (ctx, input) => ctx.run(auditStep, input);
  const definition: FlowDefinition<In, Out> = {
    _tag: "FlowDefinition",
    id: FLOW,
    name: FLOW,
    version: "1.0.0",
    inputSchema,
    outputSchema,
    steps: [auditStep],
  };
  return { definition, runner };
}

function boot(
  shared?: {
    eventStore: InMemoryAsyncEventStore;
    snapshotStore: InMemoryAsyncSnapshotStore;
    timerStore: InMemoryTimerStore;
  },
  audit: () => Promise<Out> = async () => ({ done: true })
) {
  const auditFn = vi.fn(audit);
  const effects = new EffectRuntime();
  effects.register("audit-tool", new ToolEffect(auditFn));
  // Share ONLY the stores — each boot gets its own runtime/effects/spies.
  const stores = shared
    ? {
        eventStore: shared.eventStore,
        snapshotStore: shared.snapshotStore,
        timerStore: shared.timerStore,
      }
    : {
        eventStore: new InMemoryAsyncEventStore(),
        snapshotStore: new InMemoryAsyncSnapshotStore(),
        timerStore: new InMemoryTimerStore(),
      };
  const runtime = new WorkflowRuntime({
    eventStore: stores.eventStore,
    snapshotStore: stores.snapshotStore,
    effectRuntime: effects,
    timerStore: stores.timerStore,
  });
  const flow = makeFlow();
  runtime.registerFlow(flow.definition, flow.runner);
  return { runtime, auditFn, ...stores };
}

const everyMinute = schedule$<In>({
  id: "audit-schedule",
  cron: "* * * * *",
  flowId: FLOW,
  input: { label: "cron" },
});
const MINUTE = 60_000;
const NOW = 28_333_334 * MINUTE + MINUTE / 2;
const clock = () => NOW;
const first = (Math.floor(NOW / MINUTE) + 1) * MINUTE;
const alice = { actor: "alice", tenant: "acme" };

async function started(app: ReturnType<typeof boot>, occurrence: number) {
  const events = await app.eventStore.read(`audit-schedule@${occurrence}`);
  return events.filter((e) => e.eventType === "EXECUTION_STARTED");
}

describe("ADR 0152 D2 - TimerService principalFor", () => {
  it("records the hook's principal on the occurrence's EXECUTION_STARTED and hands the hook (schedule, occurrence, signal)", async () => {
    // Kills: a hook that is never called / whose result is dropped (run starts anonymous), or is called with the wrong occurrence.
    const app = boot();
    const calls: Array<[string, number, boolean]> = [];
    const service = new TimerService(app.runtime, app.timerStore, {
      schedules: [everyMinute],
      now: clock,
      principalFor: (def, occ, ctx) => {
        calls.push([def.id, occ, ctx.signal instanceof AbortSignal]);
        return alice;
      },
    });
    await service.tick(first);
    expect(calls).toEqual([["audit-schedule", first, true]]);
    const [ev] = await started(app, first);
    expect(JSON.stringify(ev)).toContain('"alice"');
    expect(JSON.stringify(ev)).toContain('"acme"');
    expect((await app.runtime.loadState(`audit-schedule@${first}`))?.status).toBe("completed");
  });

  it("redelivery and a restarted node neither call the hook again nor change the recorded principal", async () => {
    // Kills: running the hook before the loadState fast path (a retry poll or a second node would re-mint / re-decide),
    // or an overwrite of the recorded principal by a later, different hook result.
    const a = boot();
    const hookA = vi.fn(() => alice);
    const sa = new TimerService(a.runtime, a.timerStore, {
      schedules: [everyMinute],
      now: clock,
      principalFor: hookA,
    });
    await sa.tick(first);
    await sa.tick(first + 5_000);
    expect(hookA).toHaveBeenCalledTimes(1);
    const before = JSON.stringify(await started(a, first));
    const b = boot(a);
    const hookB = vi.fn(() => ({ actor: "mallory" }));
    const sb = new TimerService(b.runtime, b.timerStore, {
      schedules: [everyMinute],
      now: clock,
      principalFor: hookB,
    });
    await sb.tick(first + 1_000);
    expect(hookB).not.toHaveBeenCalled();
    expect(JSON.stringify(await started(b, first))).toBe(before);
    expect(before).not.toContain("mallory");
  });

  it("a throwing hook skips THAT occurrence (reported, nothing started) and the next occurrence still runs", async () => {
    // Kills: starting anonymously on a hook error (fails open), rethrowing out of tick, or "retry" that holds the cursor and stalls later occurrences.
    const app = boot();
    const onError = vi.fn();
    const boom = new Error("boom");
    const service = new TimerService(app.runtime, app.timerStore, {
      schedules: [everyMinute],
      now: clock,
      onError,
      principalFor: (_d, occ) => {
        if (occ === first) throw boom;
        return alice;
      },
    });
    await service.tick(first);
    expect(await app.runtime.loadState(`audit-schedule@${first}`)).toBeNull();
    expect(app.auditFn).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    const [id, err] = onError.mock.calls[0] as [string, SchedulePrincipalError];
    expect(id).toBe(`audit-schedule@${first}`);
    expect(err).toBeInstanceOf(SchedulePrincipalError);
    expect(err.reason).toBe("threw");
    expect(err.cause).toBe(boom);
    await service.tick(first + MINUTE);
    expect((await app.runtime.loadState(`audit-schedule@${first + MINUTE}`))?.status).toBe(
      "completed"
    );
    expect(app.auditFn).toHaveBeenCalledTimes(1);
    // the skipped occurrence is not retried on later polls by this node (cursor advanced)
    expect(await app.runtime.loadState(`audit-schedule@${first}`)).toBeNull();
  });

  it("a rejecting hook that throws ExecutionAlreadyExistsError / StartLeaseHeldError is still a skip, not a start outcome", async () => {
    // Kills: leaving the hook to the outer catch, which would swallow the first silently ("already started") and turn the second into "retry".
    for (const make of [
      () => new ExecutionAlreadyExistsError(`audit-schedule@${first}`),
      () => new StartLeaseHeldError(`audit-schedule@${first}`),
    ]) {
      const app = boot();
      const onError = vi.fn();
      const service = new TimerService(app.runtime, app.timerStore, {
        schedules: [everyMinute],
        now: clock,
        onError,
        principalFor: async (_d, occ) => {
          if (occ === first) throw make();
          return alice;
        },
      });
      await service.tick(first + MINUTE); // both occurrences due: the first is skipped, the cursor moves on
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]?.[1]).toBeInstanceOf(SchedulePrincipalError);
      expect((await app.runtime.loadState(`audit-schedule@${first + MINUTE}`))?.status).toBe(
        "completed"
      );
    }
  });

  it("a hung hook times out (signal aborted, reported), is skipped, and does not stick the poll", async () => {
    // Kills: no timeout (the tick never returns and `ticking` sticks), or a timeout that does not abort the signal / is not reported.
    const app = boot();
    const onError = vi.fn();
    let aborted = false;
    const service = new TimerService(app.runtime, app.timerStore, {
      schedules: [everyMinute],
      now: clock,
      onError,
      principalForTimeoutMs: 20,
      principalFor: (_d, occ, ctx) => {
        if (occ !== first) return alice;
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise<never>(() => undefined);
      },
    });
    await service.tick(first);
    expect(aborted).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0]?.[1] as SchedulePrincipalError;
    expect(err).toBeInstanceOf(SchedulePrincipalError);
    expect(err.reason).toBe("timeout");
    expect(await app.runtime.loadState(`audit-schedule@${first}`)).toBeNull();
    await service.tick(first + MINUTE);
    expect((await app.runtime.loadState(`audit-schedule@${first + MINUTE}`))?.status).toBe(
      "completed"
    );
  });

  it("no hook, or a hook returning undefined: EXECUTION_STARTED payload is byte-identical to today's anonymous start", async () => {
    // Kills: recording a different/empty `principal` shape, or any behavioural change when the option is absent.
    const plain = boot();
    await new TimerService(plain.runtime, plain.timerStore, {
      schedules: [everyMinute],
      now: clock,
    }).tick(first);
    const hooked = boot();
    await new TimerService(hooked.runtime, hooked.timerStore, {
      schedules: [everyMinute],
      now: clock,
      principalFor: () => undefined,
    }).tick(first);
    const payload = async (app: ReturnType<typeof boot>) =>
      JSON.stringify((await started(app, first))[0]?.payload);
    // an anonymous start records the empty identity marker today; it must stay exactly that
    expect(await payload(plain)).toContain('"principal":{"v":1}');
    expect(await payload(hooked)).toBe(await payload(plain));
    expect(plain.auditFn).toHaveBeenCalledTimes(1);
    expect(hooked.auditFn).toHaveBeenCalledTimes(1);
    const strip = async (app: ReturnType<typeof boot>) =>
      (await app.eventStore.read(`audit-schedule@${first}`)).map((e) => e.eventType);
    expect(await strip(hooked)).toEqual(await strip(plain));
  });

  it("principalForTimeoutMs outside 1..60000 (or fractional) is refused at construction", () => {
    // Kills: an unbounded or zero timeout silently accepted.
    const app = boot();
    for (const bad of [0, -1, 60_001, 1.5, Number.NaN]) {
      expect(
        () => new TimerService(app.runtime, app.timerStore, { principalForTimeoutMs: bad })
      ).toThrow(RangeError);
    }
  });
});
