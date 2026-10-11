import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, HumanEffect, ToolEffect } from "@loom/effect-runtime";
import type { Effect, EffectContext } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { recoverAbandoned } from "./recoverAbandoned";
import { forParallel } from "./testSurface";
import { ApprovalRejectedError, ResumeRefusedError } from "./types";
import type { FlowRunner, ResumeAuthenticator, ResumeEvent } from "./types";

// A test authenticator that signs the WHOLE resume event: the signature is a digest of the
// payload fields other than `sig` plus `discardLegacyAnswers`, so tampering with either fails.
const digestOf = (e: ResumeEvent): string => {
  const { sig: _s, ...rest } = (e.payload ?? {}) as Record<string, unknown>;
  return JSON.stringify([e.eventType, rest, e.discardLegacyAnswers ?? null]);
};
const signing: ResumeAuthenticator = {
  verify: (e) => {
    const sig = (e.payload as { sig?: string } | null)?.sig;
    if (sig === undefined) return { status: "not-applicable" };
    return sig === digestOf(e)
      ? { status: "verified", actor: "ops-lead", verifiedBy: "test-hmac" }
      : { status: "rejected", reason: "signature does not cover this event" };
  },
};
const signed = (e: ResumeEvent): ResumeEvent => ({
  ...e,
  payload: { ...(e.payload as object), sig: digestOf(e) },
});

// ── ADR 0104 fix round 3 ───────────────────────────────────────────────────────

const io = z.object({}).passthrough() as z.ZodSchema<Record<string, unknown>>;
const A = step$({ id: "a", name: "a", toolId: "tool-a", inputSchema: io, outputSchema: io });
const tick = () => new Promise((r) => setTimeout(r, 25));

function setup(
  runner: FlowRunner<Record<string, unknown>, Record<string, unknown>>,
  opts: {
    steps?: FlowDefinition["steps"];
    effects?: (e: EffectRuntime) => void;
    resumeSchemas?: FlowDefinition["resumeSchemas"];
    authenticator?: ResumeAuthenticator;
  } = {}
) {
  const eventStore = new InMemoryAsyncEventStore();
  const effects = new EffectRuntime();
  opts.effects?.(effects);
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    onWarn: () => {},
    ...(opts.authenticator !== undefined && { resumeAuthenticator: opts.authenticator }),
  });
  const definition: FlowDefinition<Record<string, unknown>, Record<string, unknown>> = {
    _tag: "FlowDefinition",
    id: "f",
    name: "f",
    version: "1.0.0",
    inputSchema: io,
    outputSchema: io,
    steps: opts.steps ?? [],
    ...(opts.resumeSchemas !== undefined && { resumeSchemas: opts.resumeSchemas }),
  };
  runtime.registerFlow(definition, runner);
  const types = async (id: string) => (await eventStore.read(id)).map((e) => e.eventType);
  return { runtime, eventStore, definition, flow: { definition, runner }, types };
}

describe("flow and effect code cannot write kernel state (ADR 0104)", () => {
  it("ctx.emit of a state-changing kernel event is refused (P4a: a flow answering its own gate)", async () => {
    const refused: string[] = [];
    const { runtime, flow, types } = setup(
      async (ctx) => {
        for (const t of ["EXECUTION_RESUMED", "STEP_STARTED", "EFFECT_INDOUBT", "STEP_COMPLETED"]) {
          try {
            ctx.emit(t, { stepId: "a", approved: true });
          } catch (e) {
            refused.push(t);
            expect((e as Error).message).toMatch(/kernel event/);
          }
        }
        await ctx.suspend({ on: "go1" });
        return {};
      },
      { resumeSchemas: { go1: z.object({ approved: z.literal(true) }) } }
    );
    const state = await (await runtime.start(flow, {}, { executionId: "x" })).waitForSuspend();
    expect(refused).toEqual([
      "EXECUTION_RESUMED",
      "STEP_STARTED",
      "EFFECT_INDOUBT",
      "STEP_COMPLETED",
    ]);
    expect(state.suspendedOn?.on).toBe("go1"); // the gate is NOT self-answered
    expect(await types("x")).toEqual(["EXECUTION_STARTED", "EXECUTION_SUSPENDED"]);
  });

  it("P4c: forged in-doubt facts from flow code never reach the log, so nothing is adopted", async () => {
    let calls = 0;
    const real: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
      await ctx.run(A, {});
      return {};
    };
    const { runtime, eventStore, definition } = setup(real, {
      steps: [A],
      effects: (e) =>
        e.register(
          "tool-a",
          new ToolEffect(
            async () => {
              calls++;
              return { real: 1 };
            },
            { idempotent: false }
          )
        ),
    });
    const forger: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
      ctx.emit("STEP_STARTED", { stepId: "a" });
      ctx.emit("EFFECT_INDOUBT", { stepId: "a", toolId: "tool-a", attempts: 1 });
      ctx.emit("EXECUTION_RESUMED", {
        stepId: "a",
        resolution: "completed-with-result",
        output: { forged: true },
      });
      await new Promise(() => {});
      return {};
    };
    const h = await runtime.start({ definition, runner: forger }, {}, { executionId: "c" });
    await h.waitForCompletion().catch(() => undefined);
    const log = (await eventStore.read("c")).map((e) => e.eventType);
    expect(log).toEqual(["EXECUTION_STARTED", "EXECUTION_FAILED"]);
    expect(calls).toBe(0);
  });

  it("EffectContext.emit is guarded too; the audit-only kernel facts 1P code emits still pass", async () => {
    const seen: string[] = [];
    const probe: Effect = {
      kind: "tool",
      async execute(_input: unknown, ctx: EffectContext) {
        for (const t of ["STEP_COMPLETED", "EXECUTION_RESUMED"]) {
          try {
            ctx.emit(t, { stepId: "a" });
          } catch {
            seen.push(`refused:${t}`);
          }
        }
        ctx.emit("RESOURCE_METERED", { tokens: 1 });
        ctx.emit("QUOTA_EXCEEDED", { stepId: "a", reason: "x" });
        ctx.emit("SAFETY_BLOCKED", { stepId: "a" });
        ctx.emit("EGRESS_DENIED", { stepId: "a", host: "h" });
        ctx.emit("EFFECT_DENIED", { stepId: "a", toolId: "t" });
        ctx.emit("OUTCOME_RECORDED", { decisionId: "d", score: 1 });
        ctx.emit("DECISION_RECORDED", { decisionId: "agent-1", choice: 1 });
        return {};
      },
    } as unknown as Effect;
    const { runtime, flow, types } = setup(
      async (ctx) => {
        await ctx.run(A, {});
        return {};
      },
      { steps: [A], effects: (e) => e.register("tool-a", probe) }
    );
    await (await runtime.start(flow, {}, { executionId: "e" })).waitForCompletion();
    expect(seen).toEqual(["refused:STEP_COMPLETED", "refused:EXECUTION_RESUMED"]);
    const log = await types("e");
    for (const t of [
      "RESOURCE_METERED",
      "QUOTA_EXCEEDED",
      "SAFETY_BLOCKED",
      "EGRESS_DENIED",
      "EFFECT_DENIED",
      "OUTCOME_RECORDED",
      "DECISION_RECORDED",
    ]) {
      expect(log).toContain(t);
    }
  });

  it("P4b: a getter cannot pass the reserved-id check and then fold a reserved id", async () => {
    let n = 0;
    const payload = {
      get decisionId() {
        return n++ === 0 ? "ok" : "__loom_indoubt__:a:1";
      },
      choice: 1,
    };
    const { runtime, flow, eventStore } = setup(async (ctx) => {
      ctx.emit("DECISION_RECORDED", payload);
      return {};
    });
    await (await runtime.start(flow, {}, { executionId: "g" })).waitForCompletion();
    const ids = (await eventStore.read("g"))
      .filter((e) => e.eventType === "DECISION_RECORDED")
      .map((e) => (e.payload as { decisionId: string }).decisionId);
    expect(ids).toEqual(["ok"]);
  });
});

describe("human parks record which step parked (ADR 0104)", () => {
  const H1 = step$({ id: "h1", name: "h1", toolId: "hum1", inputSchema: io, outputSchema: io });
  const H2 = step$({ id: "h2", name: "h2", toolId: "hum2", inputSchema: io, outputSchema: io });

  it("p5: two parallel human steps on the 0104 kernel are answered one by one, never refused", async () => {
    const { runtime, flow, eventStore } = setup(
      async (ctx) => {
        const r = await ctx.parallel([
          [forParallel(H1), {}],
          [forParallel(H2), {}],
        ]);
        ctx.emit("out", { r });
        return {};
      },
      {
        steps: [H1, H2],
        effects: (e) => {
          e.register("hum1", new HumanEffect({ on: "ok1" }));
          e.register("hum2", new HumanEffect({ on: "ok2" }));
        },
      }
    );
    let s = await (await runtime.start(flow, {}, { executionId: "x" })).waitForSuspend();
    expect(s.suspendedOn).toMatchObject({ on: "ok1", stepId: "h1" });
    s = await (await runtime.resume("x", { eventType: "ok1", payload: { a: 1 } })).waitForSuspend();
    expect(s.suspendedOn).toMatchObject({ on: "ok2", stepId: "h2" });
    const done = await (
      await runtime.resume("x", { eventType: "ok2", payload: { a: 2 } })
    ).waitForCompletion();
    expect(done.status).toBe("completed");
    const out = (await eventStore.read("x")).find((e) => e.eventType === "out");
    expect(out?.payload).toEqual({ r: [{ a: 1 }, { a: 2 }] });
  });

  it("a legacy human step with a DYNAMIC tool id (not in definition.steps) is still recognised", async () => {
    const { runtime, eventStore } = setup(
      async (ctx) => {
        await ctx.run(
          step$({ id: "dyn", name: "dyn", toolId: "human-dyn", inputSchema: io, outputSchema: io }),
          {}
        );
        await ctx.suspend({ on: "go1" });
        return {};
      },
      { effects: (e) => e.register("human-dyn", new HumanEffect({ on: "Approve" })) }
    );
    let sequence = -1;
    const put = (eventType: string, payload: unknown) =>
      eventStore.append({
        id: `e-${++sequence}`,
        workflowId: "f",
        executionId: "e",
        eventType,
        sequence,
        timestamp: Date.now(),
        payload,
      });
    await put("EXECUTION_STARTED", { input: {} });
    await put("STEP_STARTED", { stepId: "dyn" });
    await put("EXECUTION_SUSPENDED", { condition: { on: "Approve" } });
    await put("Approve", { n: 1 });
    await put("EXECUTION_RESUMED", { n: 1 });
    await put("STEP_STARTED", { stepId: "dyn" });
    await put("EXECUTION_SUSPENDED", { condition: { on: "Approve" } });
    const err = await runtime
      .resume("e", { eventType: "Approve", payload: { n: 2 } })
      .catch((e: unknown) => e);
    expect((err as ResumeRefusedError).reason).toBe("ambiguous-legacy-answers");
  });
});

describe("the operator override for an ambiguous legacy human step (ADR 0104)", () => {
  const H = step$({ id: "h", name: "h", toolId: "human", inputSchema: io, outputSchema: io });
  async function legacyReparked() {
    const seen: unknown[] = [];
    const ctxs = setup(
      async (ctx) => {
        seen.length = 0;
        seen.push(await ctx.run(H, {}));
        seen.push(await ctx.suspend({ on: "go1" }));
        return {};
      },
      {
        steps: [H],
        effects: (e) => e.register("human", new HumanEffect({ on: "Approve" })),
        authenticator: signing,
      }
    );
    let sequence = -1;
    const put = (eventType: string, payload: unknown) =>
      ctxs.eventStore.append({
        id: `e-${++sequence}`,
        workflowId: "f",
        executionId: "e",
        eventType,
        sequence,
        timestamp: Date.now(),
        payload,
      });
    await put("EXECUTION_STARTED", { input: {} });
    await put("STEP_STARTED", { stepId: "h" });
    await put("EXECUTION_SUSPENDED", { condition: { on: "Approve" } });
    await put("Approve", { stale: 1 });
    await put("EXECUTION_RESUMED", { stale: 1 });
    await put("STEP_STARTED", { stepId: "h" });
    await put("EXECUTION_SUSPENDED", { condition: { on: "Approve" } });
    return { ...ctxs, seen };
  }

  it("discarding the stale answers lets the human step take the NEW one; go1 still needs its own", async () => {
    const { runtime, eventStore, seen } = await legacyReparked();
    const h = await runtime.resume(
      "e",
      signed({
        eventType: "Approve",
        payload: { fresh: 2 },
        discardLegacyAnswers: { stepId: "h", count: 1 },
      })
    );
    const state = await h.waitForSuspend();
    expect(state.suspendedOn?.on).toBe("go1");
    expect(seen).toMatchObject([{ fresh: 2 }]);
    const audit = (await eventStore.read("e")).find((e) => e.eventType === "DECISION_RECORDED")
      ?.payload as { decisionId: string; choice: unknown; source: string };
    expect(audit).toMatchObject({
      decisionId: "__loom_discard__:h",
      choice: 1,
      source: "operator",
    });

    // Replays stay put: a later resume replays the discard and serves go1 its own answer.
    const done = await runtime.resume("e", { eventType: "go1", payload: { g: 1 } });
    await done.waitForCompletion();
    expect(seen).toMatchObject([{ fresh: 2 }, { g: 1 }]);
  });

  it("the override is refused where nothing is ambiguous, or for the wrong step", async () => {
    const { runtime } = await legacyReparked();
    await expect(
      runtime.resume(
        "e",
        signed({
          eventType: "Approve",
          payload: {},
          discardLegacyAnswers: { stepId: "zzz", count: 1 },
        })
      )
    ).rejects.toThrow(/discardLegacyAnswers/);
    const clean = setup(
      async (ctx) => {
        await ctx.suspend({ on: "go1" });
        return {};
      },
      { authenticator: signing }
    );
    await (await clean.runtime.start(clean.flow, {}, { executionId: "c" })).waitForSuspend();
    await expect(
      clean.runtime.resume(
        "c",
        signed({ eventType: "go1", payload: {}, discardLegacyAnswers: { stepId: "h", count: 1 } })
      )
    ).rejects.toThrow(/discardLegacyAnswers/);
  });

  it("the override must be SIGNED: no authenticator, an unsigned event, a tampered count, recovery — all refused", async () => {
    const { runtime, eventStore } = await legacyReparked();
    const before = (await eventStore.read("e")).length;
    const override = { stepId: "h", count: 1 };
    // Unsigned (the authenticator has no opinion): an override needs a VERIFIED approval.
    await expect(
      runtime.resume("e", { eventType: "Approve", payload: {}, discardLegacyAnswers: override })
    ).rejects.toBeInstanceOf(ApprovalRejectedError);
    // Signed for count 1, delivered with count 0: the signature does not cover it.
    const tampered = signed({ eventType: "Approve", payload: {}, discardLegacyAnswers: override });
    await expect(
      runtime.resume("e", { ...tampered, discardLegacyAnswers: { stepId: "h", count: 0 } })
    ).rejects.toBeInstanceOf(ApprovalRejectedError);
    // Recovery is never an operator's override, signed or not.
    await expect(
      runtime.resume("e", {
        eventType: "EXECUTION_RECOVERED",
        payload: {},
        discardLegacyAnswers: override,
      })
    ).rejects.toThrow(/discardLegacyAnswers/);
    expect((await eventStore.read("e")).length).toBe(before);

    // A runtime with no authenticator at all cannot accept one.
    const bare = setup(async () => ({}), {});
    await bare.eventStore.append({
      id: "b-0",
      workflowId: "f",
      executionId: "b",
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: Date.now(),
      payload: { input: {} },
    });
    await bare.eventStore.append({
      id: "b-1",
      workflowId: "f",
      executionId: "b",
      eventType: "EXECUTION_SUSPENDED",
      sequence: 1,
      timestamp: Date.now(),
      payload: { condition: { on: "Approve" } },
    });
    await expect(
      bare.runtime.resume("b", {
        eventType: "Approve",
        payload: {},
        discardLegacyAnswers: override,
      })
    ).rejects.toBeInstanceOf(ApprovalRejectedError);
  });
});

describe("count: 0 resolves the known false positive (ADR 0104)", () => {
  it("a stray an earlier gate already consumed: acknowledge, and the human step takes the new answer", async () => {
    const H = step$({ id: "h", name: "h", toolId: "human", inputSchema: io, outputSchema: io });
    const seen: unknown[] = [];
    const { runtime, eventStore } = setup(
      async (ctx) => {
        seen.length = 0;
        seen.push(await ctx.suspend({ on: "go0" })); // took the pre-0104 recovery {} (a bypass)
        seen.push(await ctx.run(H, {}));
        return {};
      },
      {
        steps: [H],
        effects: (e) => e.register("human", new HumanEffect({ on: "Approve" })),
        authenticator: signing,
      }
    );
    let sequence = -1;
    const put = (eventType: string, payload: unknown) =>
      eventStore.append({
        id: `e-${++sequence}`,
        workflowId: "f",
        executionId: "e",
        eventType,
        sequence,
        timestamp: Date.now(),
        payload,
      });
    await put("EXECUTION_STARTED", { input: {} });
    await put("EXECUTION_RECOVERED", {});
    await put("EXECUTION_RESUMED", {});
    await put("STEP_STARTED", { stepId: "h" });
    await put("EXECUTION_SUSPENDED", { condition: { on: "Approve" } });

    await expect(
      runtime.resume("e", { eventType: "Approve", payload: { ok: 1 } })
    ).rejects.toBeInstanceOf(ResumeRefusedError);
    const h = await runtime.resume(
      "e",
      signed({
        eventType: "Approve",
        payload: { ok: 1 },
        discardLegacyAnswers: { stepId: "h", count: 0 },
      })
    );
    await h.waitForCompletion();
    expect(seen).toMatchObject([{}, { ok: 1 }]);
  });
});

describe("the allowed kernel types cannot move state either (ADR 0104, round 4)", () => {
  function effectFlow(effectBody: (ctx: { emit: (t: string, p: unknown) => void }) => void) {
    const seen: unknown[] = [];
    const s = setup(
      async (ctx) => {
        try {
          await ctx.run(A, {});
        } catch (e) {
          seen.push(`step: ${(e as Error).message}`);
        }
        seen.push(await ctx.decide("approve-refund", () => false));
        return {};
      },
      {
        steps: [A],
        effects: (e) =>
          e.register(
            "tool-a",
            new ToolEffect(async (_i: unknown, ctx: { emit: (t: string, p: unknown) => void }) => {
              effectBody(ctx);
              return {};
            })
          ),
      }
    );
    return { ...s, seen };
  }

  it("p6: an effect's DECISION_RECORDED cannot pre-empt the flow's ctx.decide — it is step-scoped", async () => {
    const { runtime, flow, eventStore, seen } = effectFlow((ctx) =>
      ctx.emit("DECISION_RECORDED", { decisionId: "approve-refund", choice: true })
    );
    const state = await (await runtime.start(flow, {}, { executionId: "x" })).waitForCompletion();
    expect(seen).toEqual([false]); // the flow's own decider decided
    const ids = (await eventStore.read("x"))
      .filter((e) => e.eventType === "DECISION_RECORDED")
      .map((e) => (e.payload as { decisionId: string }).decisionId);
    expect(ids).toEqual(["effect:a#1:approve-refund", "approve-refund"]);
    expect(state.status).toBe("completed");
  });

  it("an effect cannot record the same decision twice in one attempt", async () => {
    const { runtime, flow, seen } = effectFlow((ctx) => {
      ctx.emit("DECISION_RECORDED", { decisionId: "d", choice: 1 });
      ctx.emit("DECISION_RECORDED", { decisionId: "d", choice: 2 });
    });
    await (await runtime.start(flow, {}, { executionId: "x" })).waitForCompletion();
    expect(String(seen[0])).toMatch(/already recorded/);
  });

  it("a flow-level DECISION_RECORDED cannot overwrite a decision already made", async () => {
    const errors: string[] = [];
    const { runtime, flow } = setup(async (ctx) => {
      await ctx.decide("approve-refund", () => false);
      try {
        ctx.emit("DECISION_RECORDED", { decisionId: "approve-refund", choice: true });
      } catch (e) {
        errors.push((e as Error).message);
      }
      return {};
    });
    const state = await (await runtime.start(flow, {}, { executionId: "x" })).waitForCompletion();
    expect(errors[0]).toMatch(/already recorded/);
    expect(
      (state.variables._decisions as Record<string, { choice: unknown }>)["approve-refund"]?.choice
    ).toBe(false);
  });

  it("RESOURCE_METERED must be finite, non-negative and plausible; QUOTA_EXCEEDED's reason a bounded string", async () => {
    for (const bad of [
      { tokens: -1e9, costUsd: -1e6 },
      { tokens: Number.NaN },
      { costUsd: Number.POSITIVE_INFINITY },
      { ms: 1e20 },
      { tokens: "5" },
    ]) {
      const { runtime, flow, seen } = effectFlow((ctx) => ctx.emit("RESOURCE_METERED", bad));
      const state = await (await runtime.start(flow, {}, { executionId: "x" })).waitForCompletion();
      expect(String(seen[0])).toMatch(/RESOURCE_METERED/);
      expect(state.variables._resources).toBeUndefined();
    }
    for (const bad of [{ reason: 42 }, { reason: "x".repeat(5000) }]) {
      const { runtime, flow, seen } = effectFlow((ctx) => ctx.emit("QUOTA_EXCEEDED", bad));
      await (await runtime.start(flow, {}, { executionId: "q" })).waitForCompletion();
      expect(String(seen[0])).toMatch(/QUOTA_EXCEEDED/);
    }
    const good = effectFlow((ctx) =>
      ctx.emit("RESOURCE_METERED", { tokens: 12, costUsd: 0.01, ms: 5 })
    );
    const state = await (
      await good.runtime.start(good.flow, {}, { executionId: "ok" })
    ).waitForCompletion();
    expect(state.variables._resources).toMatchObject({ tokens: 12, costUsd: 0.01, ms: 5 });
  });
});

describe("round 5 — decision guard edges (ADR 0104)", () => {
  it("p7: a choice with no JSON form (BigInt) cannot overwrite a recorded one — undigestable counts as a conflict", async () => {
    const errors: string[] = [];
    const { runtime, flow } = setup(async (ctx) => {
      await ctx.decide("d", () => 1n as unknown as number);
      try {
        ctx.emit("DECISION_RECORDED", { decisionId: "d", choice: 2n });
      } catch (e) {
        errors.push((e as Error).message);
      }
      return {};
    });
    const state = await (await runtime.start(flow, {}, { executionId: "x" })).waitForCompletion();
    expect(errors[0]).toMatch(/already recorded/);
    expect((state.variables._decisions as Record<string, { choice: unknown }>).d?.choice).toBe(1n);
  });

  it("flow code cannot use the effect: namespace — no pre-recording an agent step's decision", async () => {
    const errors: string[] = [];
    const { runtime, flow, eventStore } = setup(async (ctx) => {
      try {
        await ctx.decide("effect:a#1:route", () => "opus");
      } catch (e) {
        errors.push(`decide: ${(e as Error).message}`);
      }
      try {
        ctx.emit("DECISION_RECORDED", { decisionId: "effect:a#1:route", choice: "opus" });
      } catch (e) {
        errors.push(`emit: ${(e as Error).message}`);
      }
      return {};
    });
    await (await runtime.start(flow, {}, { executionId: "x" })).waitForCompletion();
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.includes("effect:"))).toBe(true);
    expect((await eventStore.read("x")).some((e) => e.eventType === "DECISION_RECORDED")).toBe(
      false
    );
  });
});

void tick;
void recoverAbandoned;
