import { step$ } from "@loom/core";
import { GrantTable, ToolEffect } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import { InMemoryKillSwitch } from "@loom/middleware";
import type { ExecutionAuthorizer, FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConfig, normalizeConfig } from "./defineConfig";
import { STRICT_DEFAULTS } from "./strict";

// ── R9 — strict mode + the autonomy envelope, through defineConfig ────────────

const io = { inputSchema: z.object({}), outputSchema: z.object({}) };
const t0 = step$({ id: "s0", name: "S0", toolId: "t", ...io });
const t1 = step$({ id: "s1", name: "S1", toolId: "t", ...io });

function flowOf(
  id: string,
  runner: FlowRunner<unknown, unknown>,
  steps = [t0, t1],
  deadlineMs?: number
): RegisteredFlow {
  return {
    definition: {
      _tag: "FlowDefinition",
      id,
      name: id,
      version: "1.0.0",
      ...io,
      steps,
      ...(deadlineMs !== undefined && { deadlineMs }),
    },
    runner,
  } as RegisteredFlow;
}

/** Two sequential calls of tool `t`. */
const twice: FlowRunner<unknown, unknown> = async (ctx) => {
  await ctx.run(t0, {});
  await ctx.run(t1, {});
  return {};
};

const allowAll: ExecutionAuthorizer = { authorize: () => ({ allowed: true }) };
const grants = (flowId: string) => new GrantTable({ [flowId]: ["t"] });

function hang(): ToolEffect {
  return new ToolEffect(
    (_i: unknown, ctx: EffectContext) =>
      new Promise((_res, rej) => {
        ctx.signal?.addEventListener("abort", () => rej(ctx.signal?.reason ?? new Error("abort")), {
          once: true,
        });
      })
  );
}

describe("security.strict — config", () => {
  it("refuses to compose without an authorizer, listing every problem at once", () => {
    let message = "";
    try {
      defineConfig({ storage: { kind: "memory" }, security: { strict: true } });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/security\.strict/);
    expect(message).toMatch(/`security\.authorizer` is required/);
    expect(message).toMatch(/`security\.executionAuthorizer` is required/);
  });

  it("a lone authorizer is not enough; policies alone are not an authorizer", () => {
    expect(() =>
      defineConfig({
        storage: { kind: "memory" },
        security: { strict: true, authorizer: grants("f") },
      })
    ).toThrow(/executionAuthorizer/);
    expect(() =>
      defineConfig({
        storage: { kind: "memory" },
        security: { strict: true, executionAuthorizer: allowAll, policies: [] },
      })
    ).toThrow(/authorizer/);
  });

  it("composes when both authorizers are supplied; no advisory, a kill switch, and defaults in force", async () => {
    const warnings: string[] = [];
    const app = defineConfig({
      storage: { kind: "memory" },
      security: { strict: true, authorizer: grants("f"), executionAuthorizer: allowAll },
      observability: { onWarn: (m) => warnings.push(m) },
    });
    expect(app.strict).toBe(true);
    expect(app.killSwitch).toBeInstanceOf(InMemoryKillSwitch);
    expect(app.envelope?.spawn).toEqual({
      maxDepth: STRICT_DEFAULTS.spawnMaxDepth,
      maxFanOut: STRICT_DEFAULTS.spawnMaxFanOut,
    });
    expect(warnings).toEqual([]);
    await app.close();
  });

  it("strict does not let verification be switched off", () => {
    expect(() =>
      defineConfig({
        storage: { kind: "memory" },
        security: { strict: true, authorizer: grants("f"), executionAuthorizer: allowAll },
        checks: { verify: "off" },
      })
    ).toThrow(/checks\.verify/);
  });

  it("the envelope's defaults are individually switchable off", async () => {
    const app = defineConfig({
      storage: { kind: "memory" },
      security: { strict: true, authorizer: grants("f"), executionAuthorizer: allowAll },
      execution: { envelope: { spawn: { maxDepth: false, maxFanOut: 8 } } },
    });
    expect(app.envelope?.spawn).toEqual({ maxFanOut: 8 });
    await app.close();
  });

  it("refuses a strict config whose only spend bound was removed", () => {
    expect(() =>
      defineConfig({
        storage: { kind: "memory" },
        security: { strict: true, authorizer: grants("f"), executionAuthorizer: allowAll },
        execution: { envelope: { budget: false } },
      })
    ).toThrow(/budget: false/);
  });

  it("the flat spelling throws like every other grouped option", () => {
    expect(() => normalizeConfig({ storage: { kind: "memory" }, strict: true } as never)).toThrow(
      /security\.strict/
    );
  });
});

describe("non-strict — unchanged behaviour, one advisory", () => {
  it("logs exactly ONE advisory naming what is permissive, and still runs unauthorized effects", async () => {
    const warnings: string[] = [];
    const flow = flowOf("f", twice);
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [flow],
      execution: { registerEffects: (fx) => fx.register("t", new ToolEffect(async () => ({}))) },
      observability: { onWarn: (m) => warnings.push(m) },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/permissive defaults/);
    expect(warnings[0]).toMatch(/security\.authorizer/);
    expect(warnings[0]).toMatch(/security\.strict: false/);
    expect(app.strict).toBe(false);
    expect(app.envelope).toBeUndefined();
    expect(app.killSwitch).toBeUndefined();
    // No authorizer ⇒ every effect still runs, exactly as before.
    const handle = await app.runtime.start(flow, {});
    expect((await handle.waitForCompletion()).status).toBe("completed");
    expect(warnings).toHaveLength(1); // running adds nothing
    await app.close();
  });

  it("strict: false is the explicit opt-out — same behaviour, no advisory", async () => {
    const warnings: string[] = [];
    const app = defineConfig({
      storage: { kind: "memory" },
      security: { strict: false },
      observability: { onWarn: (m) => warnings.push(m) },
    });
    expect(warnings).toEqual([]);
    await app.close();
  });

  it("applies no default deadline", async () => {
    const flow = flowOf("f", twice);
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [flow],
      security: { strict: false },
      execution: { registerEffects: (fx) => fx.register("t", hang()) },
    });
    const handle = await app.runtime.start(flow, {}, { executionId: "e" });
    await new Promise((r) => setTimeout(r, 120));
    expect((await app.runtime.loadState("e"))?.status).toBe("running");
    await app.runtime.cancel("e");
    void handle.waitForCompletion().catch(() => {});
    await app.close();
  });
});

describe("strict — default deadline", () => {
  const strictWith = (flow: RegisteredFlow, defaultDeadlineMs: number) =>
    defineConfig({
      storage: { kind: "memory" },
      flows: [flow],
      security: {
        strict: { defaultDeadlineMs },
        authorizer: grants(flow.definition.id),
        executionAuthorizer: allowAll,
      },
      execution: { registerEffects: (fx) => fx.register("t", hang()) },
    });

  it("cancels a flow that declares no deadline once the default elapses", async () => {
    const flow = flowOf("f", twice);
    const app = strictWith(flow, 60);
    const handle = await app.runtime.start(flow, {}, { executionId: "e" });
    await expect(handle.waitForCompletion()).rejects.toThrow(/deadline exceeded/);
    await app.close();
  });

  it("an explicit flow deadline wins over the default (longer and shorter)", async () => {
    // Declares 5s; the 60ms default must NOT cancel it.
    const longer = flowOf("long", twice, [t0, t1], 5_000);
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [longer],
      security: {
        strict: { defaultDeadlineMs: 60 },
        authorizer: grants("long"),
        executionAuthorizer: allowAll,
      },
      execution: { registerEffects: (fx) => fx.register("t", hang()) },
    });
    await app.runtime.start(longer, {}, { executionId: "e" });
    await new Promise((r) => setTimeout(r, 200));
    expect((await app.runtime.loadState("e"))?.status).toBe("running");
    await app.runtime.cancel("e");

    // Declares 50ms; a 10-minute default must not loosen it.
    const shorter = flowOf("short", twice, [t0, t1], 50);
    const app2 = defineConfig({
      storage: { kind: "memory" },
      flows: [shorter],
      security: {
        strict: { defaultDeadlineMs: 600_000 },
        authorizer: grants("short"),
        executionAuthorizer: allowAll,
      },
      execution: { registerEffects: (fx) => fx.register("t", hang()) },
    });
    const h = await app2.runtime.start(shorter, {}, { executionId: "e2" });
    await expect(h.waitForCompletion()).rejects.toThrow(/deadline exceeded/);
    await app.close();
    await app2.close();
  });

  it("an explicit start option wins, and the default applies to start-by-id too", async () => {
    const flow = flowOf("f", twice);
    const app = strictWith(flow, 60);
    await app.runtime.start("f", {}, { executionId: "byid" });
    await new Promise((r) => setTimeout(r, 200));
    expect((await app.runtime.loadState("byid"))?.status).toBe("cancelled");
    await app.runtime.start(flow, {}, { executionId: "opt", deadlineMs: 5_000 });
    await new Promise((r) => setTimeout(r, 200));
    expect((await app.runtime.loadState("opt"))?.status).toBe("running");
    await app.runtime.cancel("opt");
    await app.close();
  });

  it("`defaultDeadlineMs: false` disables it, and the flow fingerprint is unchanged by strict", async () => {
    const flow = flowOf("f", twice);
    const mk = (strict: boolean | { defaultDeadlineMs: false }) =>
      defineConfig({
        storage: { kind: "memory" },
        flows: [flow],
        security: {
          strict,
          ...(strict !== false && {
            authorizer: grants("f"),
            executionAuthorizer: allowAll,
          }),
        },
        execution: { registerEffects: (fx) => fx.register("t", hang()) },
      });
    const off = mk({ defaultDeadlineMs: false });
    await off.runtime.start(flow, {}, { executionId: "e" });
    await new Promise((r) => setTimeout(r, 120));
    expect((await off.runtime.loadState("e"))?.status).toBe("running");
    await off.runtime.cancel("e");

    // Strict with a deadline vs non-strict: the recorded flow fingerprint is identical, so
    // turning strict on does not strand in-flight executions.
    const hashOf = async (app: ReturnType<typeof mk>, id: string) => {
      await app.runtime.start(flow, {}, { executionId: id });
      const events = await app.stores.eventStore.read(id);
      await app.runtime.cancel(id);
      return (events[0]?.payload as { flowHash?: string }).flowHash;
    };
    const a = await hashOf(mk(true), "h1");
    const b = await hashOf(mk(false), "h2");
    expect(a).toBeDefined();
    expect(a).toBe(b);
    await off.close();
  });
});

describe("the envelope — budget, rate limit, kill switch", () => {
  const llmish = (calls: { n: number }) =>
    new ToolEffect(async () => {
      calls.n++;
      return { usage: { inputTokens: 8, outputTokens: 2 } };
    });

  it("a spent per-execution budget refuses the NEXT effect before it runs", async () => {
    const calls = { n: 0 };
    const flow = flowOf("f", twice);
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [flow],
      security: { strict: true, authorizer: grants("f"), executionAuthorizer: allowAll },
      execution: {
        envelope: { budget: { perExecution: { maxTokens: 10 } } },
        registerEffects: (fx) => fx.register("t", llmish(calls)),
      },
    });
    const handle = await app.runtime.start(flow, {}, { executionId: "e" });
    await expect(handle.waitForCompletion()).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(calls.n).toBe(1); // the second effect never ran
    await app.close();
  });

  it("under budget the flow completes (the default 1M-token budget is invisible to a small run)", async () => {
    const calls = { n: 0 };
    const flow = flowOf("f", twice);
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [flow],
      security: { strict: true, authorizer: grants("f"), executionAuthorizer: allowAll },
      execution: { registerEffects: (fx) => fx.register("t", llmish(calls)) },
    });
    const handle = await app.runtime.start(flow, {}, { executionId: "e" });
    expect((await handle.waitForCompletion()).status).toBe("completed");
    expect(calls.n).toBe(2);
    await app.close();
  });

  it("a rate limit refuses the effect over the bucket, typed and non-retryable", async () => {
    const calls = { n: 0 };
    const flow = flowOf("f", twice);
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [flow],
      security: { strict: false },
      execution: {
        envelope: { rateLimit: { capacity: 1, refillPerSecond: 0.001, clock: () => 0 } },
        registerEffects: (fx) => fx.register("t", llmish(calls)),
      },
    });
    const handle = await app.runtime.start(flow, {}, { executionId: "e" });
    await expect(handle.waitForCompletion()).rejects.toMatchObject({
      name: "RateLimitExceededError",
      retryable: false,
    });
    expect(calls.n).toBe(1);
    await app.close();
  });

  it("a tenant kill switch stops that tenant's next effect, not another tenant's; a system stop stops all", async () => {
    const calls = { n: 0 };
    const flow = flowOf("f", twice);
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [flow],
      security: { strict: true, authorizer: grants("f"), executionAuthorizer: allowAll },
      execution: { registerEffects: (fx) => fx.register("t", llmish(calls)) },
    });
    const ks = app.killSwitch as InMemoryKillSwitch;
    ks.stopTenant("acme", "incident");

    const acme = await app.runtime.start(
      flow,
      {},
      { executionId: "a", principal: { tenant: "acme", actor: "u" } }
    );
    await expect(acme.waitForCompletion()).rejects.toMatchObject({
      name: "KillSwitchEngagedError",
      scope: "tenant",
    });
    expect(calls.n).toBe(0);

    const globex = await app.runtime.start(
      flow,
      {},
      { executionId: "g", principal: { tenant: "globex", actor: "u" } }
    );
    expect((await globex.waitForCompletion()).status).toBe("completed");
    expect(calls.n).toBe(2);

    ks.stopAll("maintenance");
    const after = await app.runtime.start(
      flow,
      {},
      { executionId: "g2", principal: { tenant: "globex", actor: "u" } }
    );
    await expect(after.waitForCompletion()).rejects.toMatchObject({ scope: "system" });
    expect(calls.n).toBe(2);
    await app.close();
  });

  it("a caller-supplied kill switch registry is used verbatim (e.g. one over a shared store)", async () => {
    const flow = flowOf("f", twice);
    const registry = { check: () => ({ scope: "system" as const, reason: "remote stop" }) };
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [flow],
      security: { strict: false, killSwitch: registry },
      execution: { registerEffects: (fx) => fx.register("t", new ToolEffect(async () => ({}))) },
    });
    expect(app.killSwitch).toBe(registry);
    const h = await app.runtime.start(flow, {}, { executionId: "e" });
    await expect(h.waitForCompletion()).rejects.toThrow(/remote stop/);
    await app.close();
  });
});
