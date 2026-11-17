import { isTainted, taintOf, tainted } from "@loomwork/classify";
import type { FlowDefinition } from "@loomwork/core";
import { agent$ } from "@loomwork/core";
import { EffectRuntime, ToolEffect } from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore } from "@loomwork/event-runtime";
import type { LlmProvider, LlmRequest } from "@loomwork/llm";
import { InMemoryMemoryStore, TieredMemory } from "@loomwork/memory";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import { WorkflowRuntime } from "@loomwork/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type AgentLoopConfig, agentLoop$, memoryWriteBackEffect } from "./agentLoop$";
import { createAgentModelEffect } from "./createAgentModelEffect";
import type { AgentLoopDistill } from "./distillWriteBack";

// ADR 0149 - `writeBack.distill`: facts, consolidated against what the scope already holds.

type Out = { add?: unknown; supersede?: unknown };
type DistillIn = {
  prompt: unknown;
  answer: unknown;
  existing: { id: string; content: unknown }[];
};

const flowDef: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "ask",
  name: "ask",
  version: "1.0.0",
  inputSchema: z.object({}),
  outputSchema: z.object({}).passthrough(),
  steps: [],
};
const agent = agent$({ id: "a", name: "A", tools: [] });
const memory = () =>
  new TieredMemory({
    store: new InMemoryMemoryStore(),
    tiers: { working: { maxEntries: 10_000 } },
  });
const SCOPE = "chat";

interface Opts {
  mem: TieredMemory;
  distiller?: (input: DistillIn, call: number) => Out | Promise<Out>;
  distill?: Partial<AgentLoopDistill>;
  store?: InMemoryAsyncEventStore;
  prompt?: string;
  promptOrigin?: string;
  /** false: the raw R10 write-back (no distill). */
  raw?: boolean;
}

function boot(o: Opts) {
  const requests: LlmRequest[] = [];
  const distillCalls: DistillIn[] = [];
  const provider: LlmProvider = {
    async complete(request) {
      requests.push(request);
      return { content: "final", stopReason: "end_turn" };
    },
  };
  const effects = new EffectRuntime([], {});
  effects.register("model", createAgentModelEffect(provider));
  effects.register("memwrite", memoryWriteBackEffect(o.mem));
  effects.register(
    "distill",
    new ToolEffect(async (input) => {
      distillCalls.push(input as DistillIn);
      return (o.distiller ?? (() => ({ add: [] })))(input as DistillIn, distillCalls.length);
    })
  );
  const warnings: string[] = [];
  const store = o.store ?? new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore: store,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    divergence: "fail",
    scopes: true,
  });
  const config: AgentLoopConfig = {
    definition: agent,
    modelToolId: "model",
    maxIterations: 4,
    memory: o.mem,
    memoryScope: SCOPE,
    onWarn: (m) => warnings.push(m),
    writeBack:
      o.raw === true
        ? { toolId: "memwrite" }
        : { toolId: "memwrite", distill: { toolId: "distill", ...o.distill } },
  };
  runtime.registerFlow(flowDef, async (ctx) =>
    agentLoop$(ctx, config, {
      prompt: o.prompt ?? "go",
      ...(o.promptOrigin !== undefined && { promptOrigin: o.promptOrigin }),
    })
  );
  return { runtime, store, requests, distillCalls, warnings };
}
type Booted = ReturnType<typeof boot>;

async function run(b: Booted, id: string) {
  const handle = await b.runtime.start(flowDef, {}, { executionId: id });
  return handle.waitForCompletion();
}
const recall = (mem: TieredMemory) => mem.recall("working", SCOPE);
const texts = async (mem: TieredMemory) =>
  (await recall(mem)).map((e) => {
    const c = e.content;
    return typeof c === "string" ? c : String(taintOf(c) !== undefined ? "[tainted]" : c);
  });

describe("ADR 0149 distilled write-back", () => {
  it("writes facts only: no raw prompt or answer entry", async () => {
    const mem = memory();
    const b = boot({ mem, distiller: () => ({ add: ["the tenant is on Pro"] }) });
    expect((await run(b, "e1")).status).toBe("completed");
    const entries = await recall(mem);
    expect(entries.map((e) => [e.role, e.content])).toEqual([["fact", "the tenant is on Pro"]]);
    expect(entries.some((e) => e.role === "user" || e.role === "assistant")).toBe(false);
    expect(b.distillCalls[0]).toMatchObject({ prompt: "go", answer: "final", existing: [] });
  });

  it("supersede: a shown id is forgotten; an id never shown is ignored, and warned about once", async () => {
    const mem = memory();
    await mem.remember("working", SCOPE, { id: "fact:old", role: "fact", content: "on Free" });
    await mem.remember("working", SCOPE, { id: "u1", role: "user", content: "raw, not a fact" });
    const b = boot({
      mem,
      distiller: () => ({ add: ["on Pro"], supersede: ["fact:old", "u1", "fact:never-shown"] }),
    });
    await run(b, "e1");
    expect(b.distillCalls[0]?.existing).toEqual([{ id: "fact:old", content: "on Free" }]);
    const left = await recall(mem);
    expect(left.map((e) => e.content).sort()).toEqual(["on Pro", "raw, not a fact"]);
    expect(b.warnings.filter((w) => /ADR 0149 D3/.test(w))).toHaveLength(1);
  });

  it("validates the output: non-strings dropped, overlong cut, more than maxFacts capped; one warning", async () => {
    const mem = memory();
    const b = boot({
      mem,
      distill: { maxFacts: 2, maxFactChars: 5 },
      distiller: () => ({ add: [42, "", "abcdefgh", "ok", "third"], supersede: "nope" }),
    });
    await run(b, "e1");
    expect((await recall(mem)).map((e) => e.content)).toEqual(["abcde", "ok"]);
    expect(b.warnings).toHaveLength(1);
  });

  it("existing: facts are filtered BEFORE maxExisting, so raw entries in the tier never crowd them out", async () => {
    const mem = memory();
    await mem.remember("working", SCOPE, {
      id: "fact:old",
      role: "fact",
      content: "the tenant is on Free",
    });
    for (let i = 0; i < 5; i++) {
      await mem.remember("working", SCOPE, { id: `raw:${i}`, role: "user", content: `raw ${i}` });
    }
    const b = boot({ mem, distill: { maxExisting: 2 }, distiller: () => ({ add: [] }) });
    expect((await run(b, "e1")).status).toBe("completed");
    expect(b.distillCalls[0]?.existing.map((e) => e.id)).toEqual(["fact:old"]);
  });

  it("dedupe: the same fact distilled by two runs is one entry", async () => {
    const mem = memory();
    const b = boot({ mem, distiller: () => ({ add: ["same fact"] }) });
    await run(b, "e1");
    await run(b, "e2");
    expect((await recall(mem)).map((e) => e.content)).toEqual(["same fact"]);
  });

  it("taint: a tainted prompt gives tainted facts, a plain run plain facts; recall renders each", async () => {
    const plainMem = memory();
    await run(boot({ mem: plainMem, distiller: () => ({ add: ["plain one"] }) }), "e1");
    expect((await recall(plainMem))[0]?.content).toBe("plain one");

    const taintMem = memory();
    const tb = boot({
      mem: taintMem,
      promptOrigin: "end-user",
      distiller: () => ({ add: ["from the user"] }),
    });
    await run(tb, "e1");
    const stored = (await recall(taintMem))[0];
    expect(isTainted(stored?.content)).toBe(true);
    expect(taintOf(stored?.content)?.origin).toBe("end-user");
    // the distiller was shown the prompt tainted
    expect(isTainted(tb.distillCalls[0]?.prompt)).toBe(true);

    // an existing tainted fact taints the new (plain-prompt) one
    const mixMem = memory();
    await mixMem.remember("working", SCOPE, {
      id: "fact:t",
      role: "fact",
      content: tainted("seen on the web", "web"),
    });
    await run(boot({ mem: mixMem, distiller: () => ({ add: ["derived"] }) }), "e1");
    const derived = (await recall(mixMem)).find((e) => e.id !== "fact:t");
    expect(taintOf(derived?.content)?.origin).toBe("web");

    // recall: plain fact -> `Remembered fact: ...` user message; tainted -> fenced, never that prefix
    const rb = boot({ mem: plainMem, prompt: "next", distiller: () => ({ add: [] }) });
    await run(rb, "e2");
    const msgs = rb.requests[0]?.messages ?? [];
    expect(msgs.some((m) => m.role === "user" && m.content === "Remembered fact: plain one")).toBe(
      true
    );
    const tr = boot({ mem: taintMem, prompt: "next", distiller: () => ({ add: [] }) });
    await run(tr, "e2");
    const tmsgs = JSON.stringify(tr.requests[0]?.messages);
    expect(tmsgs).toContain("from the user");
    expect(tmsgs).not.toContain("Remembered fact: from the user");
  });

  it("config errors: empty toolId and non-positive limits are refused before any call", async () => {
    for (const distill of [
      { toolId: "" },
      { toolId: "d", maxFacts: 0 },
      { toolId: "d", maxFactChars: 1.5 },
    ]) {
      const mem = memory();
      const b = boot({ mem });
      const rt = b.runtime;
      rt.registerFlow({ ...flowDef, id: "bad" }, async (ctx) =>
        agentLoop$(
          ctx,
          {
            definition: agent,
            modelToolId: "model",
            memory: mem,
            writeBack: { toolId: "memwrite", distill },
          },
          { prompt: "x" }
        )
      );
      const state = await (
        await rt.start(
          { ...flowDef, id: "bad" },
          {},
          { executionId: `bad${JSON.stringify(distill)}` }
        )
      )
        .waitForCompletion()
        .catch((e: unknown) => e);
      const msg = state instanceof Error ? state.message : JSON.stringify(state);
      expect(msg).toMatch(/distill/);
      expect(b.requests).toHaveLength(0);
    }
  });

  it("a failing distiller degrades: the answer is returned, nothing written, one warning; a resume makes no distiller call", async () => {
    const mem = memory();
    const store = new InMemoryAsyncEventStore();
    const b = boot({
      mem,
      store,
      distiller: () => {
        throw new Error("model down");
      },
    });
    const state = await run(b, "e1");
    expect(state.status).toBe("completed");
    expect((state.variables._output as { content: string }).content).toBe("final");
    expect(await recall(mem)).toEqual([]);
    expect(b.warnings.filter((w) => /ADR 0149 D5/.test(w))).toHaveLength(1);

    // Resume in a fresh runtime whose distiller would now SUCCEED: the recorded verdict stands.
    const events = await store.read("e1");
    const cut = events.findIndex((e) => e.eventType === "EXECUTION_COMPLETED");
    const crashed = new InMemoryAsyncEventStore();
    for (const e of events.slice(0, cut)) await crashed.append(e);
    const b2 = boot({ mem, store: crashed, distiller: () => ({ add: ["now works"] }) });
    const resumed = await b2.runtime.restoreFromState((await b2.runtime.loadState("e1"))!);
    expect((await resumed.waitForCompletion()).status).toBe("completed");
    expect(b2.distillCalls).toHaveLength(0);
    expect(await recall(mem)).toEqual([]);
  });

  it("replay: a resumed run serves the distill from the log (one distiller call in total)", async () => {
    const mem = memory();
    const store = new InMemoryAsyncEventStore();
    const b = boot({ mem, store, distiller: () => ({ add: ["learned once"] }) });
    await run(b, "e1");
    expect(b.distillCalls).toHaveLength(1);
    const events = await store.read("e1");
    const cut = events.findIndex((e) => e.eventType === "EXECUTION_COMPLETED");
    const crashed = new InMemoryAsyncEventStore();
    for (const e of events.slice(0, cut)) await crashed.append(e);
    const b2 = boot({ mem, store: crashed, distiller: () => ({ add: ["DIFFERENT"] }) });
    const resumed = await b2.runtime.restoreFromState((await b2.runtime.loadState("e1"))!);
    expect((await resumed.waitForCompletion()).status).toBe("completed");
    expect(b2.distillCalls).toHaveLength(0);
    expect(await texts(mem)).toEqual(["learned once"]);
  });

  it("growth: 30 runs, a distiller that restates and supersedes keeps recall small; raw write-back is 60", async () => {
    const RUNS = 30;
    const distilled = memory();
    // Each run learns "plan is N" and supersedes the previous plan fact; it also restates a stable fact.
    let n = 0;
    const distiller = (input: DistillIn): Out => ({
      add: [`the plan is v${++n}`, "the tenant is acme"],
      supersede: input.existing
        .filter((e) => String(e.content).startsWith("the plan is"))
        .map((e) => e.id),
    });
    const bytes = async (mem: TieredMemory) =>
      (await recall(mem)).reduce((n, e) => n + JSON.stringify(e.content).length, 0);
    for (let i = 0; i < RUNS; i++) {
      await run(boot({ mem: distilled, distiller }), `d${i}`);
    }
    const raw = memory();
    for (let i = 0; i < RUNS; i++) {
      await run(boot({ mem: raw, raw: true, prompt: `go ${i}` }), `r${i}`);
    }
    const distilledEntries = (await recall(distilled)).length;
    const rawEntries = (await recall(raw)).length;
    expect(rawEntries).toBe(2 * RUNS);
    expect(distilledEntries).toBeLessThanOrEqual(3);
    expect(await bytes(distilled)).toBeLessThan(await bytes(raw));
  });
});
