import { agent$, tool$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmResponse } from "@loom/llm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentRunner, IdempotentToolRefusedError } from "./AgentRunner";
import { agentStep$ } from "./agentStep$";

// ── K9.3 vs the single-frame runner (ADR 0121 note 2026-10-15) ──────────────────────────────────
// AgentRunner runs nested tool calls inside ONE outer step with no STEP_* frames of their own, so an
// `idempotent:false` tool gets no in-doubt protection. It is refused (terminal, before the effect)
// unless `acceptAtLeastOnce`. Each nested call also gets its own idempotency key.

const pay = tool$({
  id: "pay",
  name: "Pay",
  description: "Moves money",
  inputSchema: z.object({ n: z.number() }),
  outputSchema: z.object({ ok: z.boolean() }),
});
const agent = agent$({ id: "payer", name: "Payer", tools: [pay] });

const ctxOf = (idempotencyKey?: string): EffectContext => ({
  executionId: "exec-1",
  stepId: "agent-step",
  workflowId: "wf-1",
  attempt: 1,
  emit: vi.fn(),
  ...(idempotencyKey !== undefined && { idempotencyKey }),
});

/** Turn 0: the given tool calls; turn 1: an answer. Counts requests. */
function scripted(calls: { name: string; input: unknown }[]) {
  const seen = { requests: [] as unknown[] };
  const provider: LlmProvider = {
    async complete(request) {
      seen.requests.push(request);
      const turn = request.messages.filter((m) => m.role === "assistant").length;
      const r: LlmResponse =
        turn === 0
          ? {
              content: "go",
              toolCalls: calls.map((c, i) => ({ id: `id-${i}`, name: c.name, input: c.input })),
              stopReason: "tool_use",
            }
          : { content: "done", stopReason: "end_turn" };
      return r;
    },
  };
  return { provider, seen };
}

function payRuntime(idempotent: boolean | undefined) {
  const counter = { n: 0, keys: [] as (string | undefined)[] };
  const effects = new EffectRuntime();
  effects.register(
    "pay",
    new ToolEffect(
      async (_input: unknown, c: EffectContext) => {
        counter.n++;
        counter.keys.push(c.idempotencyKey);
        return { ok: true };
      },
      idempotent === undefined ? {} : { idempotent }
    )
  );
  return { effects, counter };
}

describe("AgentRunner refuses idempotent:false tools (K9.3)", () => {
  it("constructor pre-flight refuses a configured idempotent:false tool, naming agentLoop$", () => {
    const { effects } = payRuntime(false);
    const { provider } = scripted([]);
    const build = () => new AgentRunner({ definition: agent, provider, effectRuntime: effects });
    expect(build).toThrow(IdempotentToolRefusedError);
    expect(build).toThrow(/agentLoop\$/);
  });

  it("agentStep$ refuses at construction too", () => {
    const { effects } = payRuntime(false);
    const { provider } = scripted([]);
    expect(() => agentStep$({ id: "s", agent, provider, effectRuntime: effects })).toThrow(
      IdempotentToolRefusedError
    );
  });

  it("a tool that BECOMES idempotent:false after construction is refused at the call site: terminal, counter 0, no tool result fed back", async () => {
    const { effects, counter } = payRuntime(undefined);
    const { provider, seen } = scripted([{ name: "pay", input: { n: 1 } }]);
    const runner = new AgentRunner({ definition: agent, provider, effectRuntime: effects });
    effects.register("pay", new ToolEffect(async () => ({ ok: true }), { idempotent: false }));

    await expect(runner.run({ prompt: "pay" }, ctxOf())).rejects.toBeInstanceOf(
      IdempotentToolRefusedError
    );
    expect(counter.n).toBe(0);
    expect(seen.requests).toHaveLength(1); // the model was never handed a tool result
  });

  it("via asEffect(): the refusal fails the effect, nothing ran", async () => {
    const { effects, counter } = payRuntime(undefined);
    const { provider, seen } = scripted([{ name: "pay", input: { n: 1 } }]);
    const runner = new AgentRunner({ definition: agent, provider, effectRuntime: effects });
    effects.register("pay", new ToolEffect(async () => ({ ok: true }), { idempotent: false }));
    const outer = new EffectRuntime();
    outer.register("agent", runner.asEffect());

    await expect(outer.execute("agent", { prompt: "pay" }, ctxOf())).rejects.toBeInstanceOf(
      IdempotentToolRefusedError
    );
    expect(counter.n).toBe(0);
    expect(seen.requests).toHaveLength(1);
  });

  it("via agentStep$ in a flow: the run FAILS (terminal), nothing ran", async () => {
    const { effects, counter } = payRuntime(undefined);
    const { provider, seen } = scripted([{ name: "pay", input: { n: 1 } }]);
    const step = agentStep$({ id: "s", agent, provider, effectRuntime: effects });
    effects.register("pay", new ToolEffect(async () => ({ ok: true }), { idempotent: false }));
    const definition: FlowDefinition<{ prompt: string }, unknown> = {
      _tag: "FlowDefinition",
      id: "f",
      name: "f",
      version: "1.0.0",
      inputSchema: z.object({ prompt: z.string() }),
      outputSchema: z.unknown(),
      steps: [step],
    };
    const runner: FlowRunner<{ prompt: string }, unknown> = (ctx, input) => ctx.run(step, input);
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: new EffectRuntime(),
      onWarn: () => {},
    });
    runtime.registerFlow(definition, runner as FlowRunner<unknown, unknown>);
    const handle = await runtime.start(definition, { prompt: "pay" }, { executionId: "f-1" });
    const err = await handle.waitForCompletion().then(
      () => undefined,
      (e: unknown) => e
    );
    expect(String(err)).toContain("idempotent:false");
    expect(counter.n).toBe(0);
    expect(seen.requests).toHaveLength(1);
  });

  it("acceptAtLeastOnce opts out: the same tool runs (runner, agentStep$ config, asEffect)", async () => {
    const { effects, counter } = payRuntime(false);
    const { provider } = scripted([{ name: "pay", input: { n: 1 } }]);
    const runner = new AgentRunner({
      definition: agent,
      provider,
      effectRuntime: effects,
      acceptAtLeastOnce: true,
    });
    const out = await runner.run({ prompt: "pay" }, ctxOf());
    expect(out.toolCallLog[0]?.toolOutput).toEqual({ ok: true });
    expect(counter.n).toBe(1);

    expect(() =>
      agentStep$({ id: "s", agent, provider, effectRuntime: effects, acceptAtLeastOnce: true })
    ).not.toThrow();

    const outer = new EffectRuntime();
    outer.register("agent", runner.asEffect());
    const viaEffect = (await outer.execute("agent", { prompt: "pay" }, ctxOf())) as {
      content: string;
    };
    expect(viaEffect.content).toBe("done");
    expect(counter.n).toBe(2);
  });

  it.each([
    ["undeclared", undefined],
    ["idempotent:true", true],
  ] as const)("a %s tool is unchanged: runs and returns its output", async (_n, idem) => {
    const { effects, counter } = payRuntime(idem);
    const { provider } = scripted([{ name: "pay", input: { n: 1 } }]);
    const runner = new AgentRunner({ definition: agent, provider, effectRuntime: effects });
    const out = await runner.run({ prompt: "pay" }, ctxOf());
    expect(out.content).toBe("done");
    expect(out.toolCallLog).toEqual([
      { iteration: 1, toolName: "pay", toolInput: { n: 1 }, toolOutput: { ok: true } },
    ]);
    expect(counter.n).toBe(1);
  });
});

describe("AgentRunner derives a distinct idempotency key per nested call", () => {
  const run = async (key: string | undefined, parallelTools = false) => {
    const { effects, counter } = payRuntime(true);
    const { provider } = scripted([
      { name: "pay", input: { n: 1 } },
      { name: "pay", input: { n: 2 } },
    ]);
    const runner = new AgentRunner({
      definition: agent,
      provider,
      effectRuntime: effects,
      parallelTools,
    });
    await runner.run({ prompt: "pay" }, ctxOf(key));
    return counter.keys;
  };

  it("two calls in one run get distinct keys, both derived from the outer key", async () => {
    const keys = await run("outer-key");
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    for (const k of keys) expect(k?.startsWith("outer-key:")).toBe(true);
  });

  it("a re-run yields the same key at the same position (sequential and parallel)", async () => {
    const first = await run("outer-key");
    expect(await run("outer-key")).toEqual(first);
    expect(await run("outer-key", true)).toEqual(first);
  });

  it("same position, different tool or different input => different key; identical call on re-run => same key", async () => {
    const other = tool$({
      id: "refund",
      name: "Refund",
      description: "r",
      inputSchema: z.object({ n: z.number() }),
      outputSchema: z.object({ ok: z.boolean() }),
    });
    const ag = agent$({ id: "two", name: "Two", tools: [pay, other] });
    const keyOf = async (name: string, input: unknown) => {
      const keys: (string | undefined)[] = [];
      const effects = new EffectRuntime();
      for (const id of ["pay", "refund"]) {
        effects.register(
          id,
          new ToolEffect(async (_i: unknown, c: EffectContext) => {
            keys.push(c.idempotencyKey);
            return { ok: true };
          })
        );
      }
      const { provider } = scripted([{ name, input }]);
      await new AgentRunner({ definition: ag, provider, effectRuntime: effects }).run(
        { prompt: "x" },
        ctxOf("outer-key")
      );
      return keys[0];
    };
    const base = await keyOf("pay", { n: 1, m: 2 });
    expect(await keyOf("refund", { n: 1, m: 2 })).not.toBe(base); // different tool
    expect(await keyOf("pay", { n: 2, m: 2 })).not.toBe(base); // different input
    expect(await keyOf("pay", { m: 2, n: 1 })).toBe(base); // same call, key order irrelevant
    expect(await keyOf("pay", { n: 1, m: 2 })).toBe(base); // identical re-run
  });

  it("two IDENTICAL calls in one turn get different keys (by position)", async () => {
    const { effects, counter } = payRuntime(true);
    const { provider } = scripted([
      { name: "pay", input: { n: 1 } },
      { name: "pay", input: { n: 1 } },
    ]);
    await new AgentRunner({ definition: agent, provider, effectRuntime: effects }).run(
      { prompt: "pay" },
      ctxOf("outer-key")
    );
    expect(counter.keys).toHaveLength(2);
    expect(counter.keys[0]).not.toBe(counter.keys[1]);
  });

  it("no outer key means no key is invented", async () => {
    expect(await run(undefined)).toEqual([undefined, undefined]);
  });
});

describe("AgentRunner refuses a batch BEFORE dispatching any sibling (K9.3)", () => {
  const ordinary = tool$({
    id: "note",
    name: "Note",
    description: "n",
    inputSchema: z.object({ n: z.number() }),
    outputSchema: z.object({ ok: z.boolean() }),
  });
  const ag = agent$({ id: "mixed", name: "Mixed", tools: [ordinary, pay] });

  it.each([
    ["sequential", false],
    ["parallel", true],
    ["parallel limit 1", 1],
  ] as const)(
    "%s: [ordinary, idempotent:false] is refused with the ordinary side-effect counter 0",
    async (_n, parallelTools) => {
      const effects = new EffectRuntime();
      const note = { n: 0 };
      effects.register(
        "note",
        new ToolEffect(async () => {
          note.n++;
          return { ok: true };
        })
      );
      effects.register("pay", new ToolEffect(async () => ({ ok: true }), {}));
      const { provider, seen } = scripted([
        { name: "note", input: { n: 1 } },
        { name: "pay", input: { n: 1 } },
      ]);
      const runner = new AgentRunner({
        definition: ag,
        provider,
        effectRuntime: effects,
        parallelTools,
      });
      effects.register("pay", new ToolEffect(async () => ({ ok: true }), { idempotent: false }));
      await expect(runner.run({ prompt: "x" }, ctxOf())).rejects.toBeInstanceOf(
        IdempotentToolRefusedError
      );
      expect(note.n).toBe(0);
      expect(seen.requests).toHaveLength(1);
    }
  );
});
