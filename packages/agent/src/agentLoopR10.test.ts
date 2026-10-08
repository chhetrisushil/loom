import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { TypedFailure, agent$, tool$ } from "@loom/core";
import { EffectRuntime, GrantTable, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmRequest, LlmResponse, LlmToolCall } from "@loom/llm";
import { InMemoryMemoryStore, TieredMemory } from "@loom/memory";
import { ReasoningRuntime } from "@loom/reasoning";
import { ReplayVM } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime, answerApproval } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type AgentLoopConfig, agentLoop$, registerReasoningRoutes } from "./agentLoop$";
import { agentLoopR9 } from "./agentLoopR9.fixture";
import { createAgentModelEffect } from "./createAgentModelEffect";
import { AGENT_INTERRUPTED, type InterruptedAgentRun } from "./interrupted";

// ── R10 — one canonical agent loop ────────────────────────────────────────────
//
// What these pin, each with its negative case:
//  - a failing tool is feedback (isError), never a failed run — and the things that are NOT tool
//    failures (an authority denial, `toolErrors: "fail"`) still stop the run;
//  - parallel tool calls: one turn's calls overlap (proved by a barrier no serial loop can pass),
//    stay in the model's order, are bounded by a limit, and a branch failure is that call's result;
//  - abort: a fired signal issues no further model or tool call and carries out the work done; an
//    execution cancel stops at the next frame;
//  - deadlines, memory write-back (idempotent), and the `reasoning` response being journaled;
//  - in-flight compatibility: logs recorded by the PRE-R10 body (a frozen copy) resume under this one
//    with the divergence detector in "fail" mode.

const names = ["t0", "t1", "t2", "t3"] as const;
const toolDefs = names.map((id) =>
  tool$({
    id,
    name: id,
    description: id,
    kind: "tool",
    inputSchema: z.object({}).passthrough(),
    outputSchema: z.object({}).passthrough(),
  })
);
const agent = agent$({ id: "dba", name: "DBA", tools: toolDefs });

type ToolImpl = (input: unknown) => Promise<unknown>;

const flowDef: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "ask",
  name: "ask",
  version: "1.0.0",
  inputSchema: z.object({}),
  outputSchema: z.object({}).passthrough(),
  steps: [],
};

/** Calls of a turn, then an answer once the transcript holds `tool_result`s for them. */
function script(callsPerTurn: LlmToolCall[][]): (request: LlmRequest) => LlmResponse {
  return (request) => {
    const turn = request.messages.filter((m) => m.role === "assistant").length;
    const calls = callsPerTurn[turn];
    return calls === undefined
      ? { content: "final", stopReason: "end_turn" }
      : { content: `turn ${turn}`, toolCalls: calls, stopReason: "tool_use" };
  };
}
const call = (turn: number, name: string, k = 0): LlmToolCall => ({
  id: `c${turn}-${name}-${k}`,
  name,
  input: { turn, k },
});

/** The `tool_result` parts of the last user message of a request, summarised. */
function resultsOf(request: LlmRequest): { id: string; isError: boolean; text: string }[] {
  const last = request.messages[request.messages.length - 1];
  if (last === undefined || !Array.isArray(last.content)) return [];
  return last.content.flatMap((p) =>
    p.type === "tool_result"
      ? [{ id: p.toolUseId, isError: p.isError === true, text: JSON.stringify(p.content) }]
      : []
  );
}

interface Opts {
  tools?: Partial<Record<(typeof names)[number], ToolImpl>>;
  provider?: (request: LlmRequest) => LlmResponse | Promise<LlmResponse>;
  config?: Partial<AgentLoopConfig>;
  body?: "new" | "legacy";
  store?: InMemoryAsyncEventStore;
  scopes?: boolean;
  grants?: string[];
  reasoning?: "direct" | "ring";
  routeCalls?: { n: number };
  input?: { prompt: string };
}

function boot(opts: Opts = {}) {
  const requests: LlmRequest[] = [];
  const modelCalls = { n: 0 };
  const toolRuns: string[] = [];
  const provider: LlmProvider = {
    async complete(request) {
      modelCalls.n++;
      requests.push(request);
      return (opts.provider ?? script([]))(request);
    },
  };
  const effects = new EffectRuntime(
    [],
    opts.grants === undefined
      ? {}
      : { authorizer: new GrantTable({ ask: [...opts.grants, "model"] }) }
  );
  effects.register("model", createAgentModelEffect(provider));
  for (const id of names) {
    effects.register(
      id,
      new ToolEffect(async (input) => {
        toolRuns.push(id);
        return (opts.tools?.[id] ?? (async (i: unknown) => ({ ok: id, i })))(input);
      })
    );
  }
  let reasoning: ReasoningRuntime | undefined;
  let reasoningToolId: AgentLoopConfig["reasoningToolId"];
  if (opts.reasoning !== undefined) {
    reasoning = new ReasoningRuntime({
      routes: [{ id: "only", provider, tier: 0 }],
      router: { select: (_r, routes) => routes[0] as (typeof routes)[number] },
    });
    if (opts.reasoning === "ring") {
      reasoningToolId = registerReasoningRoutes(effects, reasoning);
    }
  }
  const warnings: string[] = [];
  const store = opts.store ?? new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore: store,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    divergence: "fail",
    onWarn: (m) => warnings.push(m),
    ...(opts.scopes !== false && { scopes: true }),
  });
  const config: AgentLoopConfig = {
    definition: agent,
    ...(reasoning === undefined ? { modelToolId: "model" } : { reasoning }),
    ...(reasoningToolId !== undefined && { reasoningToolId }),
    maxIterations: 8,
    ...opts.config,
  };
  const runner: FlowRunner<unknown, unknown> = async (ctx) => {
    const input = opts.input ?? { prompt: "go" };
    try {
      if (opts.body === "legacy") return await agentLoopR9(ctx, config, input);
      return await agentLoop$(ctx, config, input);
    } catch (e) {
      if (e instanceof TypedFailure && e.channel === AGENT_INTERRUPTED) {
        return { interrupted: e.payload as InterruptedAgentRun };
      }
      throw e;
    }
  };
  runtime.registerFlow(flowDef, runner);
  return { runtime, store, requests, modelCalls, toolRuns, warnings, effects };
}

type Booted = ReturnType<typeof boot>;
const outputOf = (state: { variables: Record<string, unknown> }) =>
  state.variables._output as {
    content?: string;
    toolCallLog?: { toolName: string; toolOutput: unknown }[];
    interrupted?: InterruptedAgentRun;
  };

async function runToEnd(b: Booted, executionId = "e1") {
  const handle = await b.runtime.start(flowDef, {}, { executionId });
  return handle.waitForCompletion();
}

/** The execution's state once it has left `running` (a failure is flushed asynchronously: wait on it). */
async function settled(b: Booted, executionId = "e1") {
  let state = await b.runtime.loadState(executionId);
  for (let i = 0; i < 400 && (state === null || state.status === "running"); i++) {
    await new Promise((r) => setTimeout(r, 5));
    state = await b.runtime.loadState(executionId);
  }
  return state;
}

/** A barrier: resolves once `n` callers are waiting. A serial loop can never get past it. */
function barrier(n: number) {
  let waiting = 0;
  let maxWaiting = 0;
  let release: () => void = () => {};
  const open = new Promise<void>((r) => {
    release = r;
  });
  return {
    async hit(): Promise<void> {
      waiting++;
      maxWaiting = Math.max(maxWaiting, waiting);
      if (waiting >= n) release();
      await open;
    },
    get peak() {
      return maxWaiting;
    },
  };
}

// ── tool errors are feedback ─────────────────────────────────────────────────────────────

describe("R10 — a failing tool is feedback, not a failed run", () => {
  const failing: ToolImpl = async () => {
    throw new Error("upstream timeout");
  };

  it("returns an isError tool_result and the run continues to the model's answer", async () => {
    const b = boot({
      tools: { t0: failing },
      provider: script([[call(0, "t0")]]),
    });
    const state = await runToEnd(b);
    expect(state.status).toBe("completed");
    expect(outputOf(state).content).toBe("final");
    // The model was asked again, and the second request carries the failure as an error result.
    expect(b.modelCalls.n).toBe(2);
    const [r] = resultsOf(b.requests[1] as LlmRequest);
    expect(r?.isError).toBe(true);
    expect(r?.text).toContain("upstream timeout");
    expect(outputOf(state).toolCallLog?.[0]?.toolOutput).toEqual({
      error: "Error: upstream timeout",
    });
  });

  it("NEGATIVE: toolErrors 'fail' keeps the pre-R10 behaviour — the failure fails the run", async () => {
    const b = boot({
      tools: { t0: failing },
      provider: script([[call(0, "t0")]]),
      config: { toolErrors: "fail" },
    });
    const state = await runToEnd(b).catch(() => settled(b));
    expect(state?.status).toBe("failed");
    expect(b.modelCalls.n).toBe(1);
  });

  it("NEGATIVE: an authority denial is NOT feedback — it fails the run and the model gets no second turn", async () => {
    // `t1` is on the menu but not granted: the K2 floor denies it.
    const b = boot({
      provider: script([[call(0, "t1")], [call(1, "t0")]]),
      grants: ["t0"],
    });
    const state = await runToEnd(b).catch(() => settled(b));
    expect(state?.status).toBe("failed");
    expect(b.modelCalls.n).toBe(1);
  });

  it("a failing tool's STEP_FAILED is journaled and a typed run still completes on resume", async () => {
    const store = new InMemoryAsyncEventStore();
    const b = boot({ store, tools: { t0: failing }, provider: script([[call(0, "t0")]]) });
    await runToEnd(b);
    const kinds = (await store.read("e1")).map((e) => e.eventType);
    expect(kinds).toContain("STEP_FAILED");
    expect(kinds).toContain("EXECUTION_COMPLETED");
  });
});

// ── parallel tool calls ────────────────────────────────────────────────────────────────

describe("R10 — parallel tool calls in one turn", () => {
  const three = [call(0, "t0"), call(0, "t1"), call(0, "t2")];

  it("overlaps the calls (a barrier a serial loop cannot pass) and keeps the model's order", async () => {
    const gate = barrier(3);
    const slowFirst: ToolImpl = async (i) => {
      await gate.hit();
      return { i };
    };
    const b = boot({
      tools: { t0: slowFirst, t1: slowFirst, t2: slowFirst },
      provider: script([three]),
      config: { parallelTools: true },
    });
    const state = await runToEnd(b);
    expect(state.status).toBe("completed");
    expect(gate.peak).toBe(3);
    // Results come back in the model's order whichever finished first, ids are unchanged.
    expect(resultsOf(b.requests[1] as LlmRequest).map((r) => r.id)).toEqual(three.map((c) => c.id));
    const ids = (await b.store.read("e1"))
      .filter((e) => e.eventType === "STEP_COMPLETED")
      .map((e) => (e.payload as { stepId: string }).stepId);
    for (const j of [0, 1, 2]) expect(ids).toContain(`dba#turn:0:tool:${j}`);
  });

  it("overlaps without kernel.features.scopes too (ctx.parallel is then the bounded Promise.all)", async () => {
    const gate = barrier(3);
    const hold: ToolImpl = async () => {
      await gate.hit();
      return {};
    };
    const b = boot({
      scopes: false,
      tools: { t0: hold, t1: hold, t2: hold },
      provider: script([three]),
      config: { parallelTools: true },
    });
    expect((await runToEnd(b)).status).toBe("completed");
    expect(gate.peak).toBe(3);
  });

  it("NEGATIVE: serial mode (the default) never overlaps — the same barrier would deadlock, so use peak", async () => {
    let inFlight = 0;
    let peak = 0;
    const tracked: ToolImpl = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight--;
      return {};
    };
    const b = boot({
      tools: { t0: tracked, t1: tracked, t2: tracked },
      provider: script([three]),
    });
    await runToEnd(b);
    expect(peak).toBe(1);
  });

  it("a number bounds the concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const pair = barrier(2);
    const tracked =
      (hold: boolean): ToolImpl =>
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        if (hold) await pair.hit();
        inFlight--;
        return {};
      };
    const b = boot({
      tools: { t0: tracked(true), t1: tracked(true), t2: tracked(false) },
      provider: script([three]),
      config: { parallelTools: 2 },
    });
    const state = await runToEnd(b);
    expect(state.status).toBe("completed");
    expect(peak).toBe(2);
  });

  it("isolates a failing branch: that call is an isError result, its siblings complete", async () => {
    const gate = barrier(3);
    const b = boot({
      tools: {
        t0: async () => {
          await gate.hit();
          return { fine: 0 };
        },
        t1: async () => {
          await gate.hit();
          throw new Error("boom");
        },
        t2: async () => {
          await gate.hit();
          return { fine: 2 };
        },
      },
      provider: script([three]),
      config: { parallelTools: true },
    });
    const state = await runToEnd(b);
    expect(state.status).toBe("completed");
    const res = resultsOf(b.requests[1] as LlmRequest);
    expect(res.map((r) => r.isError)).toEqual([false, true, false]);
    expect(res[1]?.text).toContain("boom");
    // Both siblings really ran to completion (journaled), not aborted by the scope.
    const completed = (await b.store.read("e1"))
      .filter((e) => e.eventType === "STEP_COMPLETED")
      .map((e) => (e.payload as { stepId: string }).stepId);
    expect(completed).toContain("dba#turn:0:tool:0");
    expect(completed).toContain("dba#turn:0:tool:2");
  });

  it("toolErrors 'fail' makes the first failure fail the scope and the run (siblings aborted)", async () => {
    const gate = barrier(3);
    const b = boot({
      tools: {
        t0: async () => {
          await gate.hit();
          return {};
        },
        t1: async () => {
          await gate.hit();
          throw new Error("boom");
        },
        t2: async () => {
          await gate.hit();
          return {};
        },
      },
      provider: script([three, [call(1, "t0")]]),
      config: { parallelTools: true, toolErrors: "fail" },
    });
    const state = await runToEnd(b).catch(() => settled(b));
    expect(state?.status).toBe("failed");
    expect(b.modelCalls.n).toBe(1); // no second turn
  });

  it("NEGATIVE: a denial inside a parallel turn is terminal, not feedback", async () => {
    const b = boot({
      provider: script([[call(0, "t0"), call(0, "t1")], [call(1, "t0")]]),
      grants: ["t0"], // t1 is denied
      config: { parallelTools: true },
    });
    const state = await runToEnd(b).catch(() => settled(b));
    expect(state?.status).toBe("failed");
    expect(b.modelCalls.n).toBe(1);
  });

  it("collects approvals sequentially BEFORE any call of the turn runs", async () => {
    const b = boot({
      provider: script([three]),
      config: {
        parallelTools: true,
        requireApproval: (c) => c.name !== "t1", // only t1 stops for a human
      },
    });
    const handle = await b.runtime.start(flowDef, {}, { executionId: "e1" });
    await handle.waitForSuspend();
    // Parked on t1's gate: not even t0, which needs no approval, has run.
    expect(b.toolRuns).toEqual([]);
    const parked = (await b.runtime.loadState("e1"))!;
    const resumed = await b.runtime.resume("e1", answerApproval(parked, { approved: true }));
    const state = await resumed.waitForCompletion();
    expect(state.status).toBe("completed");
    expect([...b.toolRuns].sort()).toEqual(["t0", "t1", "t2"]);
  });

  it("rejects a bad concurrency up front", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const b = boot({ config: { parallelTools: bad } });
      const state = await runToEnd(b).catch(() => settled(b));
      expect(state?.status).toBe("failed");
      expect(b.modelCalls.n).toBe(0);
    }
  });
});

// ── abort ────────────────────────────────────────────────────────────────────────────────

describe("R10 — abort", () => {
  it("a signal fired during a tool stops the loop: no further tool or model call, partial work carried out", async () => {
    const ctl = new AbortController();
    const b = boot({
      tools: {
        t0: async () => {
          ctl.abort();
          return { done: true };
        },
      },
      provider: script([[call(0, "t0"), call(0, "t1")], [call(1, "t2")]]),
      config: { signal: ctl.signal },
    });
    const state = await runToEnd(b);
    expect(state.status).toBe("completed");
    const out = outputOf(state).interrupted;
    expect(out).toBeDefined();
    // t1 (same turn) never ran and the model was not asked again.
    expect(b.toolRuns).toEqual(["t0"]);
    expect(b.modelCalls.n).toBe(1);
    expect(out?.iterations).toBe(1);
    expect(out?.toolCallLog.map((s) => s.toolName)).toEqual(["t0"]);
  });

  it("a signal already fired issues NO model call at all", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const b = boot({ provider: script([]), config: { signal: ctl.signal } });
    const state = await runToEnd(b);
    expect(outputOf(state).interrupted).toEqual({ content: "", iterations: 0, toolCallLog: [] });
    expect(b.modelCalls.n).toBe(0);
  });

  it("stops a PARALLEL turn before it starts, and between turns", async () => {
    const ctl = new AbortController();
    const b = boot({
      provider: (req) => {
        ctl.abort(); // the model's answer lands, then the stop
        return script([[call(0, "t0"), call(0, "t1")]])(req);
      },
      config: { signal: ctl.signal, parallelTools: true },
    });
    const state = await runToEnd(b);
    expect(outputOf(state).interrupted?.toolCallLog).toEqual([]);
    expect(b.toolRuns).toEqual([]);
  });

  it("NEGATIVE: without a signal nothing is interrupted", async () => {
    const b = boot({ provider: script([[call(0, "t0")]]) });
    const state = await runToEnd(b);
    expect(outputOf(state).interrupted).toBeUndefined();
    expect(outputOf(state).content).toBe("final");
  });

  it("an execution cancel stops the loop at the next frame: no further model call", async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => {
      release = r;
    });
    let started: () => void = () => {};
    const inTool = new Promise<void>((r) => {
      started = r;
    });
    const b = boot({
      tools: {
        t0: async () => {
          started();
          await hold;
          return {};
        },
      },
      provider: script([[call(0, "t0")], [call(1, "t1")]]),
    });
    const handle = await b.runtime.start(flowDef, {}, { executionId: "e1" });
    await inTool;
    handle.cancel();
    release();
    await handle.waitForCompletion().catch(() => undefined);
    // Wait on the durable condition (the cancel is flushed asynchronously), never a fixed sleep.
    let state = await b.runtime.loadState("e1");
    for (let i = 0; i < 400 && state?.status !== "cancelled"; i++) {
      await new Promise((r) => setTimeout(r, 5));
      state = await b.runtime.loadState("e1");
    }
    expect(state?.status).toBe("cancelled");
    expect(b.modelCalls.n).toBe(1);
    expect(b.toolRuns).toEqual(["t0"]);
  });
});

// ── deadlines ────────────────────────────────────────────────────────────────────────────

describe("R10 — deadlines", () => {
  it("toolTimeoutMs: a tool that exceeds it is an isError result and the run continues", async () => {
    const b = boot({
      tools: { t0: () => new Promise(() => {}) }, // never settles
      provider: script([[call(0, "t0")]]),
      config: { toolTimeoutMs: 25 },
    });
    const state = await runToEnd(b);
    expect(state.status).toBe("completed");
    const [r] = resultsOf(b.requests[1] as LlmRequest);
    expect(r?.isError).toBe(true);
    expect(r?.text).toContain("deadline");
  });

  it("turnTimeoutMs: a model call that exceeds it fails the run (nothing to continue with)", async () => {
    const b = boot({
      provider: () => new Promise<LlmResponse>(() => {}),
      config: { turnTimeoutMs: 25 },
    });
    const state = await runToEnd(b).catch(() => settled(b));
    expect(state?.status).toBe("failed");
  });

  it("rejects non-positive deadlines up front", async () => {
    for (const config of [{ turnTimeoutMs: 0 }, { toolTimeoutMs: -5 }]) {
      const b = boot({ config });
      const state = await runToEnd(b).catch(() => settled(b));
      expect(state?.status).toBe("failed");
      expect(b.modelCalls.n).toBe(0);
    }
  });
});

// ── memory write-back ───────────────────────────────────────────────────────────────────

describe("R10 — memory write-back", () => {
  const memory = () =>
    new TieredMemory({ store: new InMemoryMemoryStore(), tiers: { working: { maxEntries: 100 } } });

  it("persists the prompt and the final answer, and the next run recalls them", async () => {
    const mem = memory();
    const b = boot({
      provider: script([]),
      config: { memory: mem, writeBack: { scope: "chat-1" }, memoryScope: "chat-1" },
    });
    await runToEnd(b);
    const entries = await mem.recall("working", "chat-1");
    expect(entries.map((e) => [e.role, e.content])).toEqual([
      ["user", "go"],
      ["assistant", "final"],
    ]);

    // A second execution in the same scope sees the conversation in its prompt.
    const b2 = boot({
      provider: script([]),
      config: { memory: mem, writeBack: true, memoryScope: "chat-1" },
      input: { prompt: "and again" },
    });
    await runToEnd(b2, "e2");
    const first = (b2.requests[0] as LlmRequest).messages.map((m) => JSON.stringify(m.content));
    expect(first.join()).toContain("go");
    expect(first.join()).toContain("final");
    expect((await mem.recall("working", "chat-1")).length).toBe(4);
  });

  it("is idempotent: a re-run after the write (crash before completion) does not duplicate it", async () => {
    const mem = memory();
    const store = new InMemoryAsyncEventStore();
    const b = boot({
      store,
      provider: script([[call(0, "t0")]]),
      config: { memory: mem, writeBack: true },
    });
    await runToEnd(b);
    expect((await mem.recall("working", "e1")).length).toBe(2);

    // Drop the terminal events: the body ran (and wrote) but the process died before completion.
    const events = await store.read("e1");
    const cut = events.findIndex((e) => e.eventType === "EXECUTION_COMPLETED");
    const crashed = new InMemoryAsyncEventStore();
    for (const e of events.slice(0, cut)) await crashed.append(e);
    const b2 = boot({
      store: crashed,
      provider: script([[call(0, "t0")]]),
      config: { memory: mem, writeBack: true },
    });
    const folded = await b2.runtime.loadState("e1");
    const resumed = await b2.runtime.restoreFromState(folded!);
    expect((await resumed.waitForCompletion()).status).toBe("completed");
    expect((await mem.recall("working", "e1")).length).toBe(2);
    expect(b2.modelCalls.n).toBe(0); // everything served from the log
  });

  it("NEGATIVE: an interrupted run writes nothing", async () => {
    const mem = memory();
    const ctl = new AbortController();
    ctl.abort();
    const b = boot({ config: { memory: mem, writeBack: true, signal: ctl.signal } });
    await runToEnd(b);
    expect(await mem.recall("working", "e1")).toEqual([]);
  });

  it("NEGATIVE: writeBack without memory is refused up front", async () => {
    const b = boot({ config: { writeBack: true } });
    const state = await runToEnd(b).catch(() => settled(b));
    expect(state?.status).toBe("failed");
    expect(b.modelCalls.n).toBe(0);
  });

  it("NEGATIVE: without writeBack, memory is read-only (as before)", async () => {
    const mem = memory();
    const b = boot({ config: { memory: mem } });
    await runToEnd(b);
    expect(await mem.recall("working", "e1")).toEqual([]);
  });
});

// ── reasoning: the model call is journaled ──────────────────────────────────────────────

/** Truncate the log just before the first event of the step whose id starts with `at`, fold it, return the crashed store. */
async function crashedBefore(store: InMemoryAsyncEventStore, executionId: string, at: string) {
  const full = await store.read(executionId);
  const cutoff = full.findIndex((e: EventEnvelope) => {
    const p = e.payload as { stepId?: string; decisionId?: string };
    return String(p.stepId ?? p.decisionId ?? "").startsWith(at);
  });
  expect(cutoff).toBeGreaterThan(0);
  const prefix = full.slice(0, cutoff);
  const crashed = new InMemoryAsyncEventStore();
  for (const e of prefix) await crashed.append(e);
  const folded = new ReplayVM(prefix, {
    executionId,
    workflowId: "ask",
    workflowVersion: "1.0.0",
  }).getState();
  expect(folded.status).toBe("running");
  return { crashed, folded, prefix, full };
}

const stepIds = (events: EventEnvelope[]): string[] =>
  [
    ...new Set(
      events.map((e) => (e.payload as { stepId?: string }).stepId).filter((s) => s !== undefined)
    ),
  ] as string[];

describe("R10 — a resumed `reasoning` run makes no model call for a completed turn (H4)", () => {
  for (const mode of ["direct", "ring"] as const) {
    it(`${mode}: crash after turn 0, resume — zero provider calls for turn 0, identical step ids`, async () => {
      const calls = [[call(0, "t0")], [call(1, "t1")]];
      const store = new InMemoryAsyncEventStore();
      const first = boot({ store, reasoning: mode, provider: script(calls) });
      expect((await runToEnd(first)).status).toBe("completed");
      expect(first.modelCalls.n).toBe(3);

      // Die after turn 0's tool call, before turn 1's model call is made.
      const { crashed, folded, full } = await crashedBefore(
        store,
        "e1",
        mode === "ring" ? "dba#turn:1:call:0" : "reason:dba#turn:1:route"
      );
      // A provider that would now answer DIFFERENTLY if asked again.
      const second = boot({
        store: crashed,
        reasoning: mode,
        provider: (req) => script([[call(0, "t3", 9)], [call(1, "t2", 9)]])(req),
      });
      const resumed = await second.runtime.restoreFromState(folded);
      const state = await resumed.waitForCompletion();
      expect(state.status).toBe("completed");
      expect(second.warnings.filter((w) => /diverge/i.test(w))).toEqual([]);
      // Turn 0 was served from the log; only the two unfinished model calls (turn 1 + the answer) happened.
      expect(second.modelCalls.n).toBe(2);
      expect(second.toolRuns).toEqual(["t2"]); // turn 1's tool, as the NEW answer said — turn 0's tool not re-run
      expect(stepIds(await crashed.read("e1")).filter((s) => s.includes("turn:0"))).toEqual(
        stepIds(full).filter((s) => s.includes("turn:0"))
      );
    });

    it(`${mode}: crash after the LAST model call — the whole run is served, zero provider calls`, async () => {
      const store = new InMemoryAsyncEventStore();
      const first = boot({ store, reasoning: mode, provider: script([[call(0, "t0")]]) });
      await runToEnd(first);
      const events = await store.read("e1");
      const cut = events.findIndex((e) => e.eventType === "EXECUTION_COMPLETED");
      const crashed = new InMemoryAsyncEventStore();
      for (const e of events.slice(0, cut)) await crashed.append(e);
      const second = boot({
        store: crashed,
        reasoning: mode,
        provider: () => {
          throw new Error("the provider must not be called");
        },
      });
      const resumed = await second.runtime.restoreFromState(
        (await second.runtime.loadState("e1"))!
      );
      expect((await resumed.waitForCompletion()).status).toBe("completed");
      expect(second.modelCalls.n).toBe(0);
      expect(second.toolRuns).toEqual([]);
    });
  }

  it("the response is a recorded decision on the direct path", async () => {
    const store = new InMemoryAsyncEventStore();
    const b = boot({ store, reasoning: "direct", provider: script([[call(0, "t0")]]) });
    await runToEnd(b);
    const ids = (await store.read("e1"))
      .filter((e) => e.eventType === "DECISION_RECORDED")
      .map((e) => (e.payload as { decisionId: string }).decisionId);
    expect(ids).toContain("dba#turn:0:response:0");
    expect(ids).toContain("dba#turn:1:response:0");
  });
});

// ── in-flight compatibility: logs recorded by the pre-R10 body resume under this one ─────

describe("R10 — a run recorded by the PRE-R10 loop resumes under the new one (divergence 'fail')", () => {
  it("modelToolId, two-call turns: crash mid-run, resume — completes, no divergence, same frames", async () => {
    const calls = [
      [call(0, "t0"), call(0, "t1")],
      [call(1, "t2"), call(1, "t3")],
    ];
    const store = new InMemoryAsyncEventStore();
    const old = boot({ body: "legacy", store, provider: script(calls) });
    expect((await runToEnd(old)).status).toBe("completed");

    const { crashed, folded, full } = await crashedBefore(store, "e1", "dba#turn:1:tool:0");
    const upgraded = boot({ store: crashed, provider: script(calls) });
    const resumed = await upgraded.runtime.restoreFromState(folded);
    expect((await resumed.waitForCompletion()).status).toBe("completed");
    expect(upgraded.warnings.filter((w) => /diverge/i.test(w))).toEqual([]);
    expect(stepIds(await crashed.read("e1"))).toEqual(stepIds(full));
    // Only the unfinished work re-invoked an effect: turn 1's two tools + the answer.
    expect(upgraded.modelCalls.n).toBe(1);
    expect(upgraded.toolRuns).toEqual(["t2", "t3"]);
  });

  it("the same log resumes with parallelTools switched ON: ids are unchanged, so nothing diverges", async () => {
    const calls = [[call(0, "t0"), call(0, "t1"), call(0, "t2")]];
    const store = new InMemoryAsyncEventStore();
    const old = boot({ body: "legacy", store, provider: script(calls) });
    await runToEnd(old);
    // Crash with tool 0 durable and tools 1, 2 not.
    const { crashed, folded, full } = await crashedBefore(store, "e1", "dba#turn:0:tool:1");
    const upgraded = boot({
      store: crashed,
      provider: script(calls),
      config: { parallelTools: true },
    });
    const resumed = await upgraded.runtime.restoreFromState(folded);
    expect((await resumed.waitForCompletion()).status).toBe("completed");
    expect(upgraded.warnings.filter((w) => /diverge/i.test(w))).toEqual([]);
    expect(stepIds(await crashed.read("e1"))).toEqual(stepIds(full));
    expect([...upgraded.toolRuns].sort()).toEqual(["t1", "t2"]);
  });

  it("parked on an approval gate by the old body: the approval answers it under the new body", async () => {
    const calls = [[call(0, "t0")]];
    const store = new InMemoryAsyncEventStore();
    const cfg = { requireApproval: () => false };
    const old = boot({ body: "legacy", store, provider: script(calls), config: cfg });
    const handle = await old.runtime.start(flowDef, {}, { executionId: "e1" });
    await handle.waitForSuspend();

    const upgraded = boot({ store, provider: script(calls), config: cfg });
    const parked = (await upgraded.runtime.loadState("e1"))!;
    const resumed = await upgraded.runtime.resume("e1", answerApproval(parked, { approved: true }));
    const state = await resumed.waitForCompletion();
    expect(state.status).toBe("completed");
    expect(upgraded.warnings.filter((w) => /diverge/i.test(w))).toEqual([]);
    expect(upgraded.toolRuns).toEqual(["t0"]);
  });

  it("reasoning (direct), recorded WITHOUT a response record: resume completes without divergence and re-asks only the unrecorded turn", async () => {
    const calls = [[call(0, "t0")], [call(1, "t1")]];
    const store = new InMemoryAsyncEventStore();
    const old = boot({ body: "legacy", store, reasoning: "direct", provider: script(calls) });
    await runToEnd(old);
    const { crashed, folded, full } = await crashedBefore(store, "e1", "dba#turn:1:tool:0");
    // The old log has no `...:response:` decisions at all.
    expect(
      full.some((e) =>
        String((e.payload as { decisionId?: string }).decisionId).includes(":response:")
      )
    ).toBe(false);

    const upgraded = boot({ store: crashed, reasoning: "direct", provider: script(calls) });
    const resumed = await upgraded.runtime.restoreFromState(folded);
    expect((await resumed.waitForCompletion()).status).toBe("completed");
    expect(upgraded.warnings.filter((w) => /diverge/i.test(w))).toEqual([]);
    expect(stepIds(await crashed.read("e1"))).toEqual(stepIds(full));
    // Neither turn has a recorded response, so each is asked once more (the pre-R10 behaviour for a
    // turn recorded before it); from the answer on, every call is journaled.
    expect(upgraded.modelCalls.n).toBe(3);
    expect(upgraded.toolRuns).toEqual(["t1"]);
  });
});

// ── the loop end to end (the in-repo demonstration H3 asks for) ───────────────────────────
//
// One run that uses every capability of the canonical loop together, the shape a `loom-examples`
// consumer would take: a routed model through the effect ring, three lookups in parallel with one
// flaky tool (feedback, not failure), a destructive call parked on a human, a process restart
// while parked, and the conversation written back to memory.

describe("R10 — the canonical loop, end to end", () => {
  it("parallel lookups with a flaky tool, an approval across a restart, memory write-back, zero re-asked model calls", async () => {
    const mem = new TieredMemory({
      store: new InMemoryMemoryStore(),
      tiers: { working: { maxEntries: 100 } },
    });
    const store = new InMemoryAsyncEventStore();
    const calls = [
      [call(0, "t0"), call(0, "t1"), call(0, "t2")], // t1 is flaky
      [call(1, "t3")], // destructive: needs a human
    ];
    const config: Partial<AgentLoopConfig> = {
      parallelTools: true,
      memory: mem,
      writeBack: true,
      requireApproval: (c) => c.name !== "t3",
    };
    const flaky: ToolImpl = async () => {
      throw new Error("503 from the billing API");
    };

    // 1. First process: runs the lookups, parks on the approval of t3.
    const first = boot({
      store,
      reasoning: "ring",
      tools: { t1: flaky },
      provider: script(calls),
      config,
    });
    const handle = await first.runtime.start(flowDef, {}, { executionId: "e1" });
    await handle.waitForSuspend();
    expect([...first.toolRuns].sort()).toEqual(["t0", "t1", "t2"]); // t3 has NOT run
    const turn1 = resultsOf(first.requests[1] as LlmRequest);
    expect(turn1.map((r) => r.isError)).toEqual([false, true, false]); // the flaky one is feedback
    expect(await mem.recall("working", "e1")).toEqual([]); // nothing written until the run ends

    // 2. A second process (new runtime on the same log) resumes it: the approval answers the gate,
    //    the completed turns are served from the log, and only the final answer is asked.
    const second = boot({
      store,
      reasoning: "ring",
      tools: { t1: flaky },
      provider: script(calls),
      config,
    });
    const parked = (await second.runtime.loadState("e1"))!;
    const resumed = await second.runtime.resume("e1", answerApproval(parked, { approved: true }));
    const state = await resumed.waitForCompletion();
    expect(state.status).toBe("completed");
    expect(second.warnings.filter((w) => /diverge/i.test(w))).toEqual([]);
    expect(second.toolRuns).toContain("t3");
    // Turn 0's and turn 1's model calls were journaled: only the answer (turn 2) hit the provider.
    expect(second.modelCalls.n).toBe(1);
    expect(outputOf(state).content).toBe("final");
    expect((await mem.recall("working", "e1")).map((e) => e.role)).toEqual(["user", "assistant"]);
  });
});
