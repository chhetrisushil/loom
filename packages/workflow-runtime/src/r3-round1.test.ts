import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, type PrincipalChain, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { executionAccessPolicy } from "./executionAccessPolicy";
import { ExecutionAlreadyExistsError, ExecutionDeniedError, InputValidationError } from "./types";
import type { ExecutionAuthzRequest, FlowRunner, RegisteredFlow } from "./types";

// R3 round 1 (Opus review) — owner adoption after commit, op coverage, eviction, owner scope.

const io = {
  inputSchema: z.object({ n: z.number() }),
  outputSchema: z.object({ ok: z.boolean() }),
};
const echo = step$({ id: "echo", name: "Echo", toolId: "echo", ...io });
type R = FlowRunner<{ n: number }, { ok: boolean }>;
function makeFlow(id: string, runner: R): RegisteredFlow<{ n: number }, { ok: boolean }> {
  const definition: FlowDefinition<{ n: number }, { ok: boolean }> = {
    _tag: "FlowDefinition",
    id,
    name: id,
    version: "1.0.0",
    ...io,
    steps: [echo],
  };
  return { definition, runner };
}
const gate = makeFlow("gated", async (ctx) => {
  await ctx.suspend({ on: "GO" });
  return ctx.run(echo, { n: 1 });
});

const alice: PrincipalChain = { actor: "alice", tenant: "t1" };
const mallory: PrincipalChain = { actor: "mallory", tenant: "t1" };

function build(
  base = executionAccessPolicy(),
  extra: { validateInput?: boolean; resumeAuth?: boolean } = {}
) {
  // R3k — ownership is no longer a table in the policy: the kernel hands it over on every request.
  // The spy remembers the last owner the kernel supplied for an id, so a test can ask who owns it.
  const owners = new Map<string, unknown>();
  const policy = {
    authorize: (r: ExecutionAuthzRequest) => {
      owners.set(r.executionId, r.owner);
      return base.authorize(r);
    },
  };
  const effects = new EffectRuntime();
  effects.register("echo", new ToolEffect(async () => ({ ok: true })));
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    executionAuthorizer: policy,
    executionAuthz: { requirePrincipal: true },
    ...(extra.validateInput && { validateInput: true }),
    ...(extra.resumeAuth && {
      resumeAuthenticator: { verify: () => ({ status: "rejected", reason: "nope" }) } as never,
    }),
  });
  runtime.registerFlow(gate.definition, gate.runner);
  /** Who the kernel says owns `id`: asks as the system-less alice and reads what the policy saw. */
  const ownerOf = async (id: string): Promise<unknown> => {
    await runtime.loadState(id, { principal: alice }).catch(() => undefined);
    return owners.get(id);
  };
  return { runtime, eventStore, policy, ownerOf };
}

describe("P1-2 — owner is recorded only after the start commits", () => {
  it("C: a duplicate start of a system-started id cannot take ownership", async () => {
    const h = build();
    const first = await h.runtime.start(
      gate,
      { n: 1 },
      { executionId: "v1", ...h.runtime.systemOptions() }
    );
    await first.waitForSuspend();
    await expect(
      h.runtime.start(gate, { n: 1 }, { executionId: "v1", principal: mallory })
    ).rejects.toBeInstanceOf(ExecutionAlreadyExistsError);
    expect(await h.ownerOf("v1")).toBeUndefined();
    await expect(h.runtime.loadState("v1", { principal: mallory })).rejects.toBeInstanceOf(
      ExecutionDeniedError
    );
    await expect(h.runtime.cancel("v1", undefined, { principal: mallory })).rejects.toBeInstanceOf(
      ExecutionDeniedError
    );
  });

  it("C2: a start that fails input validation records no owner, and the honest starter keeps her execution", async () => {
    const h = build(executionAccessPolicy(), { validateInput: true });
    await expect(
      h.runtime.start(gate, { n: "bad" } as never, { executionId: "order-42", principal: mallory })
    ).rejects.toBeInstanceOf(InputValidationError);
    expect(await h.ownerOf("order-42")).toBeUndefined();
    const ok = await h.runtime.start(gate, { n: 1 }, { executionId: "order-42", principal: alice });
    await ok.waitForSuspend();
    expect(await h.ownerOf("order-42")).toEqual({ actor: "alice", tenant: "t1" });
    const owner = executionAccessPolicy({ rules: { query: "owner" } });
    void owner;
    expect((await h.runtime.loadState("order-42", { principal: alice }))?.status).toBe("suspended");
  });

  it("a committed start records the owner, for a caller-chosen and a minted id", async () => {
    const h = build();
    const a = await h.runtime.start(gate, { n: 1 }, { executionId: "named", principal: alice });
    const b = await h.runtime.start(gate, { n: 1 }, { principal: alice });
    await Promise.all([a.waitForSuspend(), b.waitForSuspend()]);
    expect(await h.ownerOf("named")).toEqual({ actor: "alice", tenant: "t1" });
    expect(await h.ownerOf(b.getState().executionId)).toEqual({ actor: "alice", tenant: "t1" });
  });
});

describe("P2-1 — every execution op is gated", () => {
  async function seeded() {
    const h = build();
    const a = await h.runtime.start(gate, { n: 1 }, { executionId: "a3", principal: alice });
    await a.waitForSuspend();
    return h;
  }

  it("fork: anonymous and cross-tenant are denied and write nothing; the owner may fork and owns the child", async () => {
    const h = await seeded();
    await expect(h.runtime.fork("a3", 0, { executionId: "kid" })).rejects.toBeInstanceOf(
      ExecutionDeniedError
    );
    expect(await h.eventStore.read("kid")).toHaveLength(0);
    await expect(
      h.runtime.fork("a3", 0, { executionId: "kid", principal: { actor: "eve", tenant: "t2" } })
    ).rejects.toBeInstanceOf(ExecutionDeniedError);
    expect(await h.eventStore.read("kid")).toHaveLength(0);
    const r = await h.runtime.fork("a3", 0, { executionId: "kid", principal: alice });
    expect(r.executionId).toBe("kid");
    expect(await h.ownerOf("kid")).toEqual({ actor: "alice", tenant: "t1" });
    // system grant (kernel-internal) still forks
    await h.runtime.fork("a3", 0, { executionId: "kid2", ...h.runtime.systemOptions() });
  });

  it("restoreFromState: anonymous is denied (resume op); a principal of the tenant may", async () => {
    const h = await seeded();
    const state = (await h.runtime.loadState("a3", { principal: alice }))!;
    await expect(h.runtime.restoreFromState(state)).rejects.toBeInstanceOf(ExecutionDeniedError);
    const handle = await h.runtime.restoreFromState(state, undefined, { principal: alice });
    expect(handle).toBeDefined();
  });

  it("restoreFromState runs the resumeAuthenticator like resume does", async () => {
    const h = build(executionAccessPolicy(), { resumeAuth: true });
    const a = await h.runtime.start(gate, { n: 1 }, { executionId: "a4", principal: alice });
    await a.waitForSuspend();
    const state = (await h.runtime.loadState("a4", { principal: alice }))!;
    await expect(
      h.runtime.restoreFromState(
        state,
        { eventType: "APPROVAL_GRANTED", payload: { by: "x" } } as never,
        {
          principal: alice,
        }
      )
    ).rejects.toBeDefined();
  });

  it("acquireFence: anonymous is denied; the system grant and an authorized principal are not", async () => {
    const h = await seeded();
    await expect(h.runtime.acquireFence("a3")).rejects.toBeInstanceOf(ExecutionDeniedError);
    await expect(h.runtime.acquireFence("a3", { principal: mallory })).resolves.toBeTypeOf(
      "number"
    );
    await expect(h.runtime.acquireFence("a3", h.runtime.systemOptions())).resolves.toBeTypeOf(
      "number"
    );
    await expect(
      h.runtime.acquireFence("a3", { principal: { actor: "eve", tenant: "t2" } })
    ).rejects.toBeInstanceOf(ExecutionDeniedError);
  });
});

describe("P3 — owner scope and the existence oracle", () => {
  it("owner scope with a resolved owner that names no actor is DENIED, not widened to the tenant", () => {
    const p = executionAccessPolicy({
      rules: { resume: "owner" },
      resolveOwner: () => ({ tenant: "t1" }),
    });
    expect(
      p.authorize({ op: "resume", executionId: "e", workflowId: "w", principal: mallory }).allowed
    ).toBe(false);
  });

  it("an anonymous cancel/loadState/resume of an unknown id is denied, not 'not found'", async () => {
    const h = build();
    await expect(h.runtime.cancel("nope")).rejects.toBeInstanceOf(ExecutionDeniedError);
    await expect(h.runtime.loadState("nope")).rejects.toBeInstanceOf(ExecutionDeniedError);
    await expect(h.runtime.resume("nope", { eventType: "GO", payload: {} })).rejects.toBeInstanceOf(
      ExecutionDeniedError
    );
  });
});
