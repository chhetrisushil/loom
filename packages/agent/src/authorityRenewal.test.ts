import { createHash } from "node:crypto";
import type { FlowDefinition } from "@loomwork/core";
import { agent$, tool$ } from "@loomwork/core";
import { EffectRuntime, ToolEffect } from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore } from "@loomwork/event-runtime";
import type { LlmProvider, LlmRequest, LlmToolCall } from "@loomwork/llm";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import { LeaseExhaustedError, answerRenewal } from "@loomwork/task-authority";
import { WorkflowRuntime } from "@loomwork/workflow-runtime";
import type { FlowRunner } from "@loomwork/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentLoopConfigError, agentLoop$ } from "./agentLoop$";
import type { AgentLoopConfig } from "./agentLoop$";
import * as local from "./authorityRenewal";
import { createAgentModelEffect } from "./createAgentModelEffect";

// ADR 0150 D5 (agent half) - `authority.onExhausted: "park"`.

const mk = (id: string) =>
  tool$({
    id,
    name: id,
    description: id,
    kind: "tool",
    inputSchema: z.object({}).passthrough(),
    outputSchema: z.object({}).passthrough(),
  });
const agent = agent$({ id: "ren", name: "Ren", tools: [mk("x"), mk("y")] });
const flowDef: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "ren-flow",
  name: "ren-flow",
  version: "1.0.0",
  inputSchema: z.object({}),
  outputSchema: z.object({ content: z.string() }),
  steps: [],
};

const broker = (granted = true) => ({
  renew: async (r: { epoch: number }) =>
    granted
      ? { granted: true as const, epoch: r.epoch + 1, digest: "d" }
      : { granted: false as const, reason: "no budget" },
});

interface World {
  calls: Record<string, number>; // attempts per tool (incl. the failed ones)
  effects: Record<string, number>; // real side effects (successful runs)
  results: { id: string; isError: boolean }[][]; // tool_result parts seen by each model call
}

/** `failFirst[tool]`: how many leading attempts of that tool throw a renewable error. */
function boot(
  policy: Partial<AgentLoopConfig>,
  failFirst: Record<string, number>,
  calls: LlmToolCall[],
  eventStore = new InMemoryAsyncEventStore(),
  snapshotStore = new InMemoryAsyncSnapshotStore()
) {
  const w: World = { calls: { x: 0, y: 0 }, effects: { x: 0, y: 0 }, results: [] };
  const provider: LlmProvider = {
    async complete(request: LlmRequest) {
      const last = request.messages[request.messages.length - 1];
      const parts = Array.isArray(last?.content) ? last.content : [];
      const res = parts.flatMap((p) =>
        p.type === "tool_result" ? [{ id: p.toolUseId, isError: p.isError === true }] : []
      );
      w.results.push(res);
      return request.messages.some((m) => m.role === "assistant")
        ? { content: "done", stopReason: "end_turn" }
        : { content: "go", toolCalls: calls, stopReason: "tool_use" };
    },
  };
  const effects = new EffectRuntime();
  effects.register("model", createAgentModelEffect(provider));
  for (const id of ["x", "y"]) {
    effects.register(
      id,
      new ToolEffect(async () => {
        w.calls[id] = (w.calls[id] as number) + 1;
        if ((w.calls[id] as number) <= (failFirst[id] ?? 0))
          throw new LeaseExhaustedError("tokens", 5, 5, w.calls[id] as number, `task-${id}`);
        w.effects[id] = (w.effects[id] as number) + 1;
        return { ok: true };
      })
    );
  }
  const runtime = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime: effects });
  const runner: FlowRunner<unknown, { content: string }> = async (ctx) => {
    const out = await agentLoop$(
      ctx,
      { definition: agent, modelToolId: "model", ...policy },
      { prompt: "p" }
    );
    return { content: out.content };
  };
  runtime.registerFlow(flowDef, runner as FlowRunner<unknown, unknown>);
  return { runtime, eventStore, snapshotStore, w };
}

const one = [{ id: "c1", name: "x", input: {} }];
const settle = async (h: {
  waitForSuspend(): Promise<{ status: string }>;
  waitForCompletion(): Promise<{ status: string }>;
}) => (await Promise.race([h.waitForSuspend(), h.waitForCompletion()])).status;

describe("agentLoop$ authority.onExhausted", () => {
  it("park: a renewable tool error parks on the gate, a grant re-runs the SAME call, the model sees one success", async () => {
    const { runtime, eventStore, w } = boot({ authority: { onExhausted: "park" } }, { x: 1 }, one);
    const h = await runtime.start(flowDef, {});
    expect(await settle(h)).toBe("suspended");
    const state = (await runtime.loadState(h.executionId))!;
    const key = `${h.executionId}#ren#turn:0:tool:0#0`;
    expect(state.suspendedOn).toMatchObject({ on: "task-authority:renew", correlationKey: key });
    const rec = (state.variables._decisions as Record<string, { choice: { request: never } }>)[
      "task-authority:attempt:ren#turn:0:tool:0:0"
    ];
    expect(rec?.choice.request).toEqual({
      taskId: "task-x",
      epoch: 1,
      spent: { tokens: 5 },
      renewals: 0,
    });
    // task-authority's `answerRenewal` finds the decision, recomputes this digest as a tamper check and
    // refuses on a mismatch, so the grant below is the proof the two formats agree
    expect(state.suspendedOn?.viewDigest).toBe(
      createHash("sha256")
        .update(JSON.stringify({ gate: key, req: rec!.choice.request }))
        .digest("hex")
    );
    expect(w.effects.x).toBe(0);

    const resumed = await answerRenewal(runtime, broker(), h.executionId);
    expect((await resumed.waitForCompletion()).status).toBe("completed");
    expect(w.effects.x).toBe(1); // the tool's real effect ran after the grant
    expect(w.calls.x).toBe(2);
    // no error result was ever shown: the one tool_result the model saw is a success
    expect(w.results.flat()).toEqual([{ id: "c1", isError: false }]);
    // the retry is a FRESH task id: the original id holds only the failure, the success is under :r1
    const steps = (await eventStore.read(h.executionId)).flatMap((e) => {
      const p = e.payload as { stepId?: string };
      return e.eventType.startsWith("STEP_") && p.stepId?.startsWith("ren#turn:0:tool:0")
        ? [`${e.eventType} ${p.stepId}`]
        : [];
    });
    expect(steps).toEqual([
      "STEP_STARTED ren#turn:0:tool:0",
      "STEP_FAILED ren#turn:0:tool:0",
      "STEP_STARTED ren#turn:0:tool:0:r1",
      "STEP_COMPLETED ren#turn:0:tool:0:r1",
    ]);
  });

  it("park under parallelTools: each exhausted call parks in call order after the scope settles", async () => {
    const calls = [
      { id: "c1", name: "x", input: {} },
      { id: "c2", name: "y", input: {} },
    ];
    const { runtime, w } = boot(
      { authority: { onExhausted: "park" }, parallelTools: true },
      { x: 1, y: 1 },
      calls
    );
    const h = await runtime.start(flowDef, {});
    const keys: string[] = [];
    let status = await settle(h);
    let cur = h;
    while (status === "suspended") {
      const st = (await runtime.loadState(h.executionId))!;
      keys.push(String(st.suspendedOn?.correlationKey).split("#").slice(-2).join("#"));
      cur = await answerRenewal(runtime, broker(), h.executionId);
      status = await settle(cur);
    }
    expect(status).toBe("completed");
    expect(keys).toEqual(["turn:0:tool:0#0", "turn:0:tool:1#0"]);
    expect(w.effects).toEqual({ x: 1, y: 1 });
    expect(w.results.flat()).toEqual([
      { id: "c1", isError: false },
      { id: "c2", isError: false },
    ]);
  });

  it("a crash while parked: a fresh runtime on the same log resumes, no failed attempt re-runs", async () => {
    const first = boot({ authority: { onExhausted: "park" } }, { x: 1 }, one);
    const h = await first.runtime.start(flowDef, {}, { executionId: "ren-crash" });
    expect(await settle(h)).toBe("suspended");
    // process dies; a new one (new effect instances, counters at zero) opens the same stores
    const second = boot(
      { authority: { onExhausted: "park" } },
      { x: 0 },
      one,
      first.eventStore,
      first.snapshotStore
    );
    const resumed = await answerRenewal(second.runtime, broker(), "ren-crash");
    expect((await resumed.waitForCompletion()).status).toBe("completed");
    expect(second.w.calls.x).toBe(1); // the failed attempt was served from the log, not re-run
    expect(second.w.effects.x).toBe(1);
  });

  it("a denied renewal fails the run with AuthorityRenewalDeniedError", async () => {
    const { runtime, w } = boot({ authority: { onExhausted: "park" } }, { x: 1 }, one);
    const h = await runtime.start(flowDef, {});
    expect(await settle(h)).toBe("suspended");
    const resumed = await answerRenewal(runtime, broker(false), h.executionId);
    await expect(resumed.waitForCompletion()).rejects.toMatchObject({
      name: "AuthorityRenewalDeniedError",
      message: expect.stringContaining("no budget"),
    });
    expect(w.effects.x).toBe(0);
  });

  it("more than maxRenewals fails the run", async () => {
    const { runtime } = boot({ authority: { onExhausted: "park", maxRenewals: 1 } }, { x: 9 }, one);
    const h = await runtime.start(flowDef, {});
    expect(await settle(h)).toBe("suspended");
    const resumed = await answerRenewal(runtime, broker(), h.executionId);
    await expect(resumed.waitForCompletion()).rejects.toBeInstanceOf(
      local.AuthorityRenewalDeniedError
    );
  });

  it('default "fail": a renewable error is terminal exactly as before (no park, no decision)', async () => {
    const { runtime, eventStore, w } = boot({}, { x: 1 }, one);
    const h = await runtime.start(flowDef, {});
    await expect(h.waitForCompletion()).rejects.toBeInstanceOf(LeaseExhaustedError);
    expect(w.calls.x).toBe(1);
    expect(JSON.stringify(await eventStore.read(h.executionId))).not.toContain(
      "task-authority:attempt"
    );
  });

  it("explicit onExhausted: fail is the same as the default", async () => {
    const { runtime } = boot({ authority: { onExhausted: "fail" } }, { x: 1 }, one);
    const h = await runtime.start(flowDef, {});
    await expect(h.waitForCompletion()).rejects.toBeInstanceOf(LeaseExhaustedError);
  });

  it('park with toolErrors: "fail" is a config error', async () => {
    const { runtime } = boot({ authority: { onExhausted: "park" }, toolErrors: "fail" }, {}, one);
    const h = await runtime.start(flowDef, {});
    await expect(h.waitForCompletion()).rejects.toBeInstanceOf(AgentLoopConfigError);
  });

  it("detects renewable structurally: cause chain, and the expired-grant denial reason", () => {
    const err = new LeaseExhaustedError("tokens", 5, 6, 3, "t#1");
    const wrapped = new Error("tool failed", { cause: err });
    expect(local.isRenewable(wrapped)).toBe(true);
    expect(local.renewalRequestOf(wrapped, 2)).toEqual({
      taskId: "t#1",
      epoch: 3,
      spent: { tokens: 6 },
      renewals: 2,
    });
    const expired = Object.assign(new Error("denied"), {
      name: "CapabilityDeniedError",
      reason: 'task-grant:expired: grant for task "a"b" epoch 4 expired at 9',
    });
    expect(local.isRenewable(expired)).toBe(true);
    expect(local.renewalRequestOf(expired, 0)).toEqual({
      taskId: 'a"b',
      epoch: 4,
      spent: {},
      renewals: 0,
    });
    expect(local.isRenewable(new Error("x"))).toBe(false);
  });
});
