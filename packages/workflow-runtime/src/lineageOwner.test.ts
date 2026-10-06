import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, type PrincipalChain, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { executionAccessPolicy } from "./executionAccessPolicy";
import type { FlowRunner, RegisteredFlow } from "./types";

// R3k round 2 (ADR 0111 D6) — a principal-less supervised child's LIFECYCLE belongs to its
// parent's owner, read from the child's trusted recorded `parent`.

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
const mallory: PrincipalChain = { actor: "mallory", tenant: "t2" };

type Mode = "no-authorizer" | "authorizer" | "strict";
function build(mode: Mode, rules?: Parameters<typeof executionAccessPolicy>[0]) {
  const effects = new EffectRuntime();
  effects.register("echo", new ToolEffect(async () => ({ ok: true })));
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    ...(mode !== "no-authorizer" && {
      executionAuthorizer: executionAccessPolicy({ rules: { cancel: "owner" }, ...rules }),
    }),
    ...(mode === "strict" && { executionAuthz: { requirePrincipal: true } }),
  });
  runtime.registerFlow(definition, runner);
  return { runtime, eventStore };
}
const parentOf = async (es: InMemoryAsyncEventStore, id: string) =>
  ((await es.read(id))[0]?.payload as { parent?: string }).parent;

async function startChild(
  rt: WorkflowRuntime,
  id: string,
  parent: string,
  opts: Record<string, unknown> = { ...rt.systemOptions(), ...rt.lineageOptions() }
) {
  const h = await rt.start(gate, { n: 1 }, { executionId: id, parentExecutionId: parent, ...opts });
  await h.waitForSuspend();
}

describe("D6 — the supervisor's lineage is recorded in every mode; a caller's is never", () => {
  for (const mode of ["no-authorizer", "authorizer", "strict"] as const) {
    it(`${mode}: lineageOptions() records \`parent\`; a bare parentExecutionId does not`, async () => {
      const { runtime, eventStore } = build(mode);
      const p = await runtime.start(
        gate,
        { n: 1 },
        { executionId: "p", ...(mode !== "no-authorizer" && { principal: alice }) }
      );
      await p.waitForSuspend();
      await startChild(runtime, "kid", "p");
      expect(await parentOf(eventStore, "kid")).toBe("p");
      await startChild(
        runtime,
        "forged",
        "p",
        mode === "no-authorizer" ? {} : { principal: alice }
      );
      expect(await parentOf(eventStore, "forged")).toBeUndefined();
    });
  }

  it("a forged token is ignored (identity-compared), and the grant is not the system grant", async () => {
    const { runtime, eventStore } = build("strict");
    const h = await runtime.start(gate, { n: 1 }, { executionId: "p", principal: alice });
    await h.waitForSuspend();
    await startChild(runtime, "k1", "p", {
      principal: alice,
      lineage: { __loomLineageGrant: true },
    });
    expect(await parentOf(eventStore, "k1")).toBeUndefined();
    // the lineage token bypasses no authorizer: an anonymous start with it is still refused
    await expect(
      runtime.start(gate, { n: 1 }, { executionId: "k2", ...runtime.lineageOptions() })
    ).rejects.toThrow(/denied/);
    expect(runtime.lineageOptions()).not.toHaveProperty("system");
  });
});

describe("D6 — a principal-less child's lifecycle follows its parent's owner", () => {
  for (const mode of ["authorizer", "strict"] as const) {
    it(`${mode}: the parent's owner may query/cancel; a stranger may not`, async () => {
      const { runtime } = build(mode);
      const p = await runtime.start(gate, { n: 1 }, { executionId: "p", principal: alice });
      await p.waitForSuspend();
      await startChild(runtime, "kid", "p");
      await expect(runtime.loadState("kid", { principal: mallory })).rejects.toThrow(/denied/);
      await expect(runtime.cancel("kid", "x", { principal: mallory })).rejects.toThrow(/denied/);
      expect((await runtime.loadState("kid", { principal: alice }))?.status).toBe("suspended");
      await expect(runtime.cancel("kid", "x", { principal: alice })).resolves.toBe(true);
    });
  }

  it("a caller-supplied (untrusted) parent confers nothing", async () => {
    const { runtime } = build("authorizer");
    const p = await runtime.start(gate, { n: 1 }, { executionId: "p", principal: alice });
    await p.waitForSuspend();
    await startChild(runtime, "kid", "p", {}); // anonymous, names alice's execution, no token
    await expect(runtime.loadState("kid", { principal: alice })).rejects.toThrow(
      /owner is unknown/
    );
  });

  it("actAsOwner never inherits (the child's effects stay anonymous)", async () => {
    const { runtime } = build("authorizer", { rules: { actAsOwner: "owner" } });
    const p = await runtime.start(gate, { n: 1 }, { executionId: "p", principal: alice });
    await p.waitForSuspend();
    await startChild(runtime, "kid", "p");
    await expect(runtime.fork("kid", 0, { principal: alice, actAs: "owner" })).rejects.toThrow(
      /denied/
    );
  });

  it("a grandchild chain resolves to the nearest recorded owner, bounded at 8 hops", async () => {
    const { runtime } = build("authorizer");
    const p = await runtime.start(gate, { n: 1 }, { executionId: "p", principal: alice });
    await p.waitForSuspend();
    let prev = "p";
    for (let i = 1; i <= 9; i++) {
      await startChild(runtime, `c${i}`, prev);
      prev = `c${i}`;
    }
    expect((await runtime.loadState("c8", { principal: alice }))?.status).toBe("suspended");
    await expect(runtime.loadState("c9", { principal: alice })).rejects.toThrow(/owner is unknown/);
    // a nearer recorded owner wins over a farther one
    const h = await runtime.start(
      gate,
      { n: 1 },
      { executionId: "m", principal: mallory, ...runtime.lineageOptions(), parentExecutionId: "c3" }
    );
    await h.waitForSuspend();
    await startChild(runtime, "under-m", "m");
    expect((await runtime.loadState("under-m", { principal: mallory }))?.status).toBe("suspended");
    await expect(runtime.loadState("under-m", { principal: alice })).rejects.toThrow(/denied/);
  });

  it("a parent cycle resolves to an unknown owner (deny), not a hang", async () => {
    const { runtime } = build("authorizer");
    await startChild(runtime, "a", "b");
    await startChild(runtime, "b", "a");
    await expect(runtime.loadState("a", { principal: alice })).rejects.toThrow(/owner is unknown/);
  });
});

describe("round 3 (user decision B) — an identified child is reachable through its trusted parent", () => {
  const kid: PrincipalChain = { actor: "kid-actor", tenant: "t1" };
  it("the parent's owner may query/cancel/resume a child that owns itself; a stranger may not", async () => {
    const { runtime } = build("authorizer", { rules: { cancel: "owner", resume: "owner" } });
    const p = await runtime.start(gate, { n: 1 }, { executionId: "p", principal: alice });
    await p.waitForSuspend();
    await startChild(runtime, "kid", "p", {
      principal: kid,
      ...runtime.systemOptions(),
      ...runtime.lineageOptions(),
    });
    await expect(runtime.loadState("kid", { principal: mallory })).rejects.toThrow(/denied/);
    expect((await runtime.loadState("kid", { principal: alice }))?.status).toBe("suspended");
    expect((await runtime.loadState("kid", { principal: kid }))?.status).toBe("suspended");
    // cancel is "owner"-scoped: a same-tenant bystander is refused, the parent's owner is not
    await expect(
      runtime.cancel("kid", "x", { principal: { actor: "bob", tenant: "t1" } })
    ).rejects.toThrow(/denied/);
    await expect(
      runtime.resume("kid", { eventType: "GO", payload: {} }, { principal: mallory })
    ).rejects.toThrow(/denied/);
    const h = await runtime.resume("kid", { eventType: "GO", payload: {} }, { principal: alice });
    await expect(h.waitForCompletion()).resolves.toBeDefined();
  });

  it("an UNTRUSTED parent confers nothing on an identified child", async () => {
    const { runtime } = build("authorizer");
    const p = await runtime.start(gate, { n: 1 }, { executionId: "p", principal: alice });
    await p.waitForSuspend();
    // another tenant, so only the parent could confer access; no lineage token
    await startChild(runtime, "kid", "p", { principal: { actor: "kid-actor", tenant: "t3" } });
    await expect(runtime.loadState("kid", { principal: alice })).rejects.toThrow(/denied/);
  });

  it("actAsOwner never inherits for an identified child either", async () => {
    const { runtime } = build("authorizer", { rules: { actAsOwner: "owner" } });
    const p = await runtime.start(gate, { n: 1 }, { executionId: "p", principal: alice });
    await p.waitForSuspend();
    await startChild(runtime, "kid", "p", {
      principal: kid,
      ...runtime.systemOptions(),
      ...runtime.lineageOptions(),
    });
    await expect(runtime.fork("kid", 0, { principal: alice, actAs: "owner" })).rejects.toThrow(
      /denied/
    );
  });
});
