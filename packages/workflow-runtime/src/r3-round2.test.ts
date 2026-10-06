import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, type PrincipalChain, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { executionAccessPolicy } from "./executionAccessPolicy";
import type { ExecutionAuthorizer, FlowRunner, RegisteredFlow } from "./types";

// R3 round 2 — fence op classification, parentExecutionId trust, committed-hook failure.

const io = {
  inputSchema: z.object({ n: z.number() }),
  outputSchema: z.object({ ok: z.boolean() }),
};
const echo = step$({ id: "echo", name: "Echo", toolId: "echo", ...io });
const definition: FlowDefinition<{ n: number }, { ok: boolean }> = {
  _tag: "FlowDefinition",
  id: "gated",
  name: "gated",
  version: "1.0.0",
  ...io,
  steps: [echo],
};
const runner: FlowRunner<{ n: number }, { ok: boolean }> = async (ctx) => {
  await ctx.suspend({ on: "GO" });
  return ctx.run(echo, { n: 1 });
};
const gate: RegisteredFlow<{ n: number }, { ok: boolean }> = { definition, runner };
const alice: PrincipalChain = { actor: "alice", tenant: "t1" };
const mallory: PrincipalChain = { actor: "mallory", tenant: "t1" };

function build(policy: ExecutionAuthorizer, onWarn?: (m: string) => void) {
  const effects = new EffectRuntime();
  effects.register("echo", new ToolEffect(async () => ({ ok: true })));
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    executionAuthorizer: policy,
    executionAuthz: { requirePrincipal: true },
    ...(onWarn !== undefined && { onWarn }),
  });
  runtime.registerFlow(definition, runner);
  return runtime;
}

describe("P2-A — acquireFence gateAs", () => {
  const rules = { resume: "owner", query: "owner", cancel: "deny" } as const;
  it("gateAs:resume lets the owner fence under cancel:deny; a stranger is refused AS resume; the public default is still cancel", async () => {
    const rt = build(executionAccessPolicy({ rules }));
    const h = await rt.start(gate, { n: 1 }, { executionId: "a1", principal: alice });
    await h.waitForSuspend();
    await expect(rt.acquireFence("a1", { principal: alice, gateAs: "resume" })).resolves.toBeTypeOf(
      "number"
    );
    await expect(rt.acquireFence("a1", { principal: mallory, gateAs: "resume" })).rejects.toThrow(
      /operation "resume" on "a1" denied/
    );
    await expect(rt.acquireFence("a1", { principal: alice })).rejects.toThrow(
      /operation "cancel" on "a1" denied/
    );
  });
});

describe("P3-1 — RunOptions.parentExecutionId is not a caller-controlled owner source", () => {
  /** What owner the kernel reports to the policy for `id` (asks as alice, reads the request). */
  async function ownerSeen(rt: WorkflowRuntime, seen: Map<string, unknown>, id: string) {
    await rt.loadState(id, { principal: alice }).catch(() => undefined);
    return seen.get(id);
  }
  function spyBuild(policy: ExecutionAuthorizer) {
    const seen = new Map<string, unknown>();
    const rt = build({
      authorize: (r) => {
        seen.set(r.executionId, r.owner);
        return policy.authorize(r);
      },
    });
    return { rt, seen };
  }
  it("an anonymous start naming a parent does not inherit the parent's owner", async () => {
    const { rt, seen } = spyBuild(executionAccessPolicy({ allowAnonymous: true }));
    const h = await rt.start(gate, { n: 1 }, { executionId: "a1", principal: alice });
    await h.waitForSuspend();
    const x = await rt.start(gate, { n: 1 }, { executionId: "x1", parentExecutionId: "a1" });
    await x.waitForSuspend();
    expect(await ownerSeen(rt, seen, "x1")).toBeUndefined();
  });
  it("a system-granted start (supervisor) with no principal has NO owner either (ADR 0111 D5)", async () => {
    const { rt, seen } = spyBuild(executionAccessPolicy());
    const h = await rt.start(gate, { n: 1 }, { executionId: "a1", principal: alice });
    await h.waitForSuspend();
    const x = await rt.start(
      gate,
      { n: 1 },
      { executionId: "x2", parentExecutionId: "a1", ...rt.systemOptions() }
    );
    await x.waitForSuspend();
    expect(await ownerSeen(rt, seen, "x2")).toBeUndefined();
    await expect(rt.loadState("x2", { principal: alice })).rejects.toThrow(/owner is unknown/);
  });
});

describe("P3-3 — a throwing committed hook is surfaced", () => {
  it("warns via onWarn and the start still succeeds", async () => {
    const base = executionAccessPolicy();
    const warns: string[] = [];
    const rt = build(
      {
        authorize: (r) => base.authorize(r),
        committed: () => {
          throw new Error("boom");
        },
      },
      (m) => warns.push(m)
    );
    const h = await rt.start(gate, { n: 1 }, { executionId: "c1", principal: alice });
    await h.waitForSuspend();
    expect(warns.some((w) => w.includes("c1") && w.includes("boom"))).toBe(true);
  });
});
