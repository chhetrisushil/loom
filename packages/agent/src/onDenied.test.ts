import type { FlowDefinition } from "@loomwork/core";
import { agent$, tool$ } from "@loomwork/core";
import {
  type CapabilityAuthorizer,
  CapabilityDeniedError,
  EffectRuntime,
  ToolEffect,
} from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore } from "@loomwork/event-runtime";
import type { LlmProvider, LlmRequest, LlmToolCall } from "@loomwork/llm";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import {
  CrossLineageParkError,
  InMemoryGrantBroker,
  LeaseExhaustedError,
  TaskGrantAuthorizer,
  answerRenewal,
  installTaskAuthority,
} from "@loomwork/task-authority";
import { WorkflowRuntime } from "@loomwork/workflow-runtime";
import type { FlowRunner } from "@loomwork/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentLoopConfigError, agentLoop$ } from "./agentLoop$";
import type { AgentLoopConfig } from "./agentLoop$";
import { createAgentModelEffect } from "./createAgentModelEffect";
import { OPAQUE_DENIAL, taskGrantDenialText } from "./toolFailure";

// ADR 0150 D11 - `authority.onDenied`, against a real runtime and a real TaskGrantAuthorizer.
const SECRET = "ondenied-secret";
const clock = { t: 1_000_000 };
const TASK = "t-secret-task-id";
const ACTOR = "agent-secret-actor";
const mk = (id: string) =>
  tool$({
    id,
    name: id,
    description: id,
    kind: "tool",
    inputSchema: z.object({}).passthrough(),
    outputSchema: z.object({}).passthrough(),
  });
const agent = agent$({ id: "den", name: "Den", tools: [mk("x"), mk("y"), mk("z")] });
const flowDef: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "den-flow",
  name: "den-flow",
  version: "1.0.0",
  inputSchema: z.object({}),
  outputSchema: z.object({ content: z.string() }),
  steps: [],
};
const call = (name: string, id = `c-${name}`): LlmToolCall => ({ id, name, input: {} });
const BASE_SECRET = "base-detail lineage:FOREIGN-B";

function boot(
  policy: Partial<AgentLoopConfig>,
  turns: LlmToolCall[][],
  o: {
    stores?: { e: InMemoryAsyncEventStore; s: InMemoryAsyncSnapshotStore };
    throwX?: () => Error;
    lapse?: boolean;
    broker?: InMemoryGrantBroker;
  } = {}
) {
  clock.t = 1_000_000;
  const w = {
    authz: { x: 0, y: 0, z: 0 } as Record<string, number>,
    ran: [] as string[],
    seen: [] as string[],
  };
  const provider: LlmProvider = {
    async complete(request: LlmRequest) {
      const last = request.messages[request.messages.length - 1];
      const parts = Array.isArray(last?.content) ? last.content : [];
      for (const p of parts) if (p.type === "tool_result") w.seen.push(JSON.stringify(p));
      const t = turns[request.messages.filter((m) => m.role === "assistant").length];
      return t === undefined
        ? { content: "done", stopReason: "end_turn" }
        : { content: "go", toolCalls: t, stopReason: "tool_use" };
    },
  };
  const base: CapabilityAuthorizer = {
    authorize: (r) =>
      r.toolId === "z" ? { allowed: false, reason: BASE_SECRET } : { allowed: true },
  };
  const real = new TaskGrantAuthorizer({ secret: SECRET, base, now: () => clock.t });
  const authorizer: CapabilityAuthorizer = {
    authorize: (r) => {
      // the grant lapses for the one authorization of tool x only (the model call after it is in date again)
      if (o.lapse) clock.t = r.toolId === "x" ? 1_000_000 + 61_000 : 1_000_000;
      if (r.toolId in w.authz) w.authz[r.toolId] = (w.authz[r.toolId] as number) + 1;
      return real.authorize(r);
    },
  };
  const effects = new EffectRuntime([], { authorizer });
  effects.register("model", createAgentModelEffect(provider));
  let xCalls = 0;
  for (const id of ["x", "y", "z"])
    effects.register(
      id,
      new ToolEffect(async () => {
        if (id === "x" && o.throwX && xCalls++ === 0) throw o.throwX();
        w.ran.push(id);
        return { ok: true };
      })
    );
  const e = o.stores?.e ?? new InMemoryAsyncEventStore();
  const s = o.stores?.s ?? new InMemoryAsyncSnapshotStore();
  const broker =
    o.broker ??
    new InMemoryGrantBroker({
      secret: SECRET,
      now: () => clock.t,
      policy: () => ({}),
    });
  const runtime = new WorkflowRuntime({
    eventStore: e,
    snapshotStore: s,
    effectRuntime: effects,
    resumeAuthenticator: { verify: () => ({ status: "verified", actor: "ops", verifiedBy: "t" }) },
    onWarn: () => {},
  });
  const runner: FlowRunner<unknown, { content: string }> = async (ctx) => {
    const out = await agentLoop$(
      ctx,
      { definition: agent, modelToolId: "model", ...policy },
      { prompt: "p" }
    );
    return { content: out.content };
  };
  runtime.registerFlow(flowDef, runner as FlowRunner<unknown, unknown>);
  installTaskAuthority(runtime, { source: broker, secret: SECRET, now: () => clock.t });
  const start = async (grant = true, executionId?: string) => {
    const g = await broker.mint({
      taskId: TASK,
      issuedTo: ACTOR,
      effects: ["model", "x", "z"],
      leases: {},
      ttlMs: 60_000,
    });
    return runtime.start(
      flowDef,
      {},
      {
        ...(executionId && { executionId }),
        ...(grant && { principal: { actor: ACTOR, taskGrant: g } }),
      }
    );
  };
  return { runtime, w, start, stores: { e, s }, broker };
}
const settle = async (h: {
  waitForSuspend(): Promise<{ status: string }>;
  waitForCompletion(): Promise<{ status: string }>;
}) => (await Promise.race([h.waitForSuspend(), h.waitForCompletion()])).status;
const SCOPE_THEN_OK = [[call("y")], [call("x")]];

describe("agentLoop$ authority.onDenied (ADR 0150 D11)", () => {
  // kills: a default that converts, or a "fail" path that changed
  it('default and "fail": the denial is terminal, the model never sees it, the next tool never runs', async () => {
    for (const policy of [{}, { authority: { onDenied: "fail" as const } }]) {
      const { w, start } = boot(policy, SCOPE_THEN_OK);
      const h = await start();
      await expect(h.waitForCompletion()).rejects.toBeInstanceOf(CapabilityDeniedError);
      expect(w.seen).toEqual([]);
      expect(w.ran).toEqual([]);
    }
  });

  // kills: opaque leaking the reason; opaque ending the run; the loop not continuing to an allowed tool
  it('"opaque": a generic isError result, the loop continues, a later allowed tool runs', async () => {
    const { w, start } = boot({ authority: { onDenied: "opaque" } }, SCOPE_THEN_OK);
    const h = await start();
    expect((await h.waitForCompletion()).status).toBe("completed");
    expect(w.ran).toEqual(["x"]);
    const first = w.seen[0] as string;
    expect(first).toContain('"isError":true');
    expect(first).toContain(OPAQUE_DENIAL);
    expect(first).not.toContain("task-grant");
    expect(first).not.toContain('"y"');
  });

  // kills: a sanitizer that copies the reason detail (task id, actor, base text, foreign lineage)
  it('"reason": the label and a fixed sentence; no task id, actor, base text or lineage', async () => {
    const scope = boot({ authority: { onDenied: "reason" } }, SCOPE_THEN_OK);
    await (await scope.start()).waitForCompletion();
    expect(scope.w.seen[0]).toContain(
      `${OPAQUE_DENIAL} (task-grant:scope: the effect is outside the task grant)`
    );
    const base = boot({ authority: { onDenied: "reason" } }, [[call("z")], [call("x")]]);
    await (await base.start()).waitForCompletion();
    expect(base.w.seen[0]).toContain("task-grant:base: the callee lacks the capability");
    for (const seen of [...scope.w.seen, ...base.w.seen])
      for (const leak of [TASK, ACTOR, "base-detail", "FOREIGN-B", "lineage:", "epoch", "sig"])
        expect(seen).not.toContain(leak);
  });

  // kills: a sanitizer trusting the reason text after the label (an injected/unknown one)
  it("sanitizer: unknown label and injected detail collapse; a non-task-grant denial, kill switch or wrapper is not converted", () => {
    const d = (r: string) => new CapabilityDeniedError("t", r);
    expect(taskGrantDenialText(d('task-grant:made-up: lineage:B grant {"x":1}'), "reason")).toBe(
      `${OPAQUE_DENIAL} (task-grant:denied)`
    );
    expect(taskGrantDenialText(d("task-grant:cross-lineage"), "reason")).toContain(
      "another lineage"
    );
    expect(taskGrantDenialText(d("plain base denial"), "opaque")).toBeUndefined();
    expect(taskGrantDenialText(new Error("x", { cause: d("task-grant:scope: a") }), "opaque")).toBe(
      OPAQUE_DENIAL
    );
    const kill = Object.assign(new Error("k", { cause: d("task-grant:scope: a") }), {
      name: "KillSwitchEngagedError",
    });
    expect(taskGrantDenialText(kill, "opaque")).toBeUndefined();
  });

  // kills: converting renewable errors (they must still fail or park)
  it("a renewable lease exhaustion still parks under park, and is terminal otherwise, in every mode", async () => {
    for (const onDenied of ["fail", "opaque", "reason"] as const) {
      const throwX = () => new LeaseExhaustedError("tokens", 5, 5, 1, TASK);
      const parked = boot({ authority: { onExhausted: "park", onDenied } }, [[call("x")]], {
        throwX,
      });
      expect(await settle(await parked.start())).toBe("suspended");
      const plain = boot({ authority: { onDenied } }, [[call("x")]], { throwX });
      await expect((await plain.start()).waitForCompletion()).rejects.toBeInstanceOf(
        LeaseExhaustedError
      );
      expect(plain.w.seen).toEqual([]);
    }
  });

  // kills: converting the cross-lineage park (it would show the foreign set or skip the approval)
  it("a cross-lineage park is not converted and never shows the foreign set", async () => {
    const throwX = () => new CrossLineageParkError(TASK, 1, ["lineage:FOREIGN-B"], "h");
    const run = boot({ authority: { onExhausted: "park", onDenied: "reason" } }, [[call("x")]], {
      throwX,
    });
    expect(await settle(await run.start())).toBe("suspended");
    expect(run.w.seen).toEqual([]);
    const plain = boot({ authority: { onDenied: "reason" } }, [[call("x")]], { throwX });
    await expect((await plain.start()).waitForCompletion()).rejects.toBeInstanceOf(
      CrossLineageParkError
    );
    expect(plain.w.seen).toEqual([]);
  });

  // kills: dropping the renewable guard (an expired grant is a task-grant: denial AND renewable)
  it("an expired-grant denial parks under park and is terminal otherwise, never converted", async () => {
    for (const onDenied of ["opaque", "reason"] as const) {
      const turns = [[call("x")]];
      const parked = boot({ authority: { onExhausted: "park", onDenied } }, turns, { lapse: true });
      const hp = await parked.start();
      expect(await settle(hp)).toBe("suspended");
      const plain = boot({ authority: { onDenied } }, turns, { lapse: true });
      const hf = await plain.start();
      await expect(hf.waitForCompletion()).rejects.toMatchObject({
        reason: expect.stringMatching(/^task-grant:expired/),
      });
      expect(plain.w.seen).toEqual([]);
    }
  });

  // kills: widening to the base authorizer (no task grant present => base decides, reason has no task-grant: prefix)
  it("a non-task-grant denial stays terminal in every mode", async () => {
    for (const onDenied of ["opaque", "reason"] as const) {
      const { w, start } = boot({ authority: { onDenied } }, [[call("z")], [call("x")]]);
      const h = await start(false);
      await expect(h.waitForCompletion()).rejects.toBeInstanceOf(CapabilityDeniedError);
      expect(w.seen).toEqual([]);
    }
  });

  // kills: an unrecorded conversion (a replay would authorize y again or show a different text)
  it("replay: a fresh runtime on the same log feeds the recorded error and authorizes y once in total", async () => {
    const throwX = () => new LeaseExhaustedError("tokens", 5, 5, 1, TASK);
    const policy = { authority: { onExhausted: "park" as const, onDenied: "reason" as const } };
    const turns = [[call("y")], [call("x")]];
    const first = boot(policy, turns, { throwX });
    const h = await first.start(true, "den-replay");
    expect(await settle(h)).toBe("suspended");
    expect(first.w.authz.y).toBe(1);
    const second = boot(policy, turns, { stores: first.stores, broker: first.broker });
    const r = await answerRenewal(
      second.runtime,
      {
        renew: async (q: { epoch: number }) => ({
          granted: true as const,
          epoch: q.epoch + 1,
          digest: "d",
        }),
      },
      "den-replay"
    );
    expect((await r.waitForCompletion()).status).toBe("completed");
    expect(second.w.authz.y).toBe(0);
    const rec = (await second.runtime.loadState("den-replay"))!.variables._decisions as Record<
      string,
      { choice: { failed: { error: string } } }
    >;
    expect(rec["den#turn:0:tool:0:outcome"]?.choice.failed.error).toContain("task-grant:scope");
  });

  // kills: accepting a mode that cannot replay or a typo
  it("config: onDenied needs toolErrors feedback and a known value", async () => {
    for (const policy of [
      { authority: { onDenied: "opaque" as const }, toolErrors: "fail" as const },
      { authority: { onDenied: "nope" as never } },
    ]) {
      const h = await boot(policy, SCOPE_THEN_OK).start();
      await expect(h.waitForCompletion()).rejects.toBeInstanceOf(AgentLoopConfigError);
    }
  });
});
