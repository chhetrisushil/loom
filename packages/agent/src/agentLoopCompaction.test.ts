import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { agent$, tool$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";
import { ReplayVM } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentLoop$ } from "./agentLoop$";
import { chunkDeltas } from "./chunkDeltas";
import { createAgentModelEffect } from "./createAgentModelEffect";

// ── Bounding what the log carries ────────────────────────────────────────────
//
// Per-turn durability journals each turn's message array, so the log grows with
// conversation length (ADR 0087 D5). Two mitigations, and this covers the second:
// claim-check bounds the BYTES per turn; compaction bounds the TURNS.
//
// The design is shaped by why it was deferred from R1. A summary is lossy and
// NONDETERMINISTIC, so computing it in the loop body would make the reconstructed
// transcript depend on when you replayed. Running it through `ctx.execute` makes
// it a recorded task — journaled once, served from the log — so replay rebuilds
// the same compacted transcript.

const lookup = tool$({
  id: "lookup",
  name: "Lookup",
  description: "Looks up",
  kind: "tool",
  inputSchema: z.object({}),
  outputSchema: z.object({}),
});

/** Four tool-calling turns, then an answer — enough to cross a compaction threshold. */
function chattyProvider(seen: LlmRequest[]): LlmProvider {
  return {
    async complete(request) {
      seen.push(request);
      const turn = request.messages.filter((m) => m.role === "assistant").length;
      return turn < 4
        ? {
            content: `t${turn}`,
            toolCalls: [{ id: `c${turn}`, name: "lookup", input: { i: turn } }],
            stopReason: "tool_use",
          }
        : ({ content: "final", stopReason: "end_turn" } as LlmResponse);
    },
  };
}

function boot(compact: boolean, summaries: string[] = []) {
  const seen: LlmRequest[] = [];
  const effects = new EffectRuntime();
  effects.register("model", createAgentModelEffect(chattyProvider(seen)));
  effects.register("lookup", new ToolEffect(async () => ({ ok: true })));
  effects.register(
    "summarize",
    new ToolEffect(async (input) => {
      const { messages } = input as { messages: { content: string }[] };
      const summary = `folded ${messages.length}`;
      summaries.push(summary);
      return { summary };
    })
  );

  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });
  const flowDef: FlowDefinition = {
    _tag: "FlowDefinition",
    id: "ask",
    name: "ask",
    version: "1.0.0",
    inputSchema: z.object({}),
    outputSchema: z.object({ content: z.string() }),
    steps: [],
  };
  const runner: FlowRunner<unknown, { content: string }> = async (ctx) => {
    const out = await agentLoop$(
      ctx,
      {
        definition: agent$({ id: "dba", name: "DBA", tools: [lookup] }),
        modelToolId: "model",
        maxIterations: 8,
        ...(compact && {
          compaction: { toolId: "summarize", afterMessages: 4, keepRecent: 2 },
        }),
      },
      { prompt: "go" }
    );
    return { content: out.content };
  };
  runtime.registerFlow(flowDef, runner as FlowRunner<unknown, unknown>);
  return { runtime, flowDef, seen, summaries };
}

describe("the loop can bound its own transcript", () => {
  it("folds older turns into a summary once the threshold is crossed", async () => {
    const { runtime, flowDef, seen, summaries } = boot(true);
    const handle = await runtime.start(flowDef, {});
    await handle.waitForCompletion();

    expect(summaries.length).toBeGreaterThan(0);
    const compacted = seen.find((r) =>
      r.messages.some((m) => m.content.startsWith("Summary of earlier turns:"))
    );
    expect(compacted).toBeDefined();
    // Bounded, not merely rewritten: the compacted prompt is the summary plus
    // the kept tail, so length stops tracking conversation length.
    expect(compacted?.messages.length).toBeLessThanOrEqual(4);
  });

  it("grows without bound when compaction is not configured (G2)", async () => {
    const { runtime, flowDef, seen } = boot(false);
    const handle = await runtime.start(flowDef, {});
    await handle.waitForCompletion();

    const last = seen[seen.length - 1];
    expect(last?.messages.some((m) => m.content.startsWith("Summary"))).toBe(false);
    // The behaviour this exists to bound: every turn is still in the prompt.
    expect(last?.messages.length ?? 0).toBeGreaterThan(4);
  });

  it("journals the summary as its own task, so replay serves it", async () => {
    const { runtime, flowDef } = boot(true);
    const handle = await runtime.start(flowDef, {}, { executionId: "c1" });
    await handle.waitForCompletion();
    const state = await runtime.loadState("c1");

    // A lossy, nondeterministic value has to be a recorded FACT, or a replay
    // reconstructs a different transcript than the one that ran.
    const compactFrames = Object.keys(state?.frames ?? {}).filter((id) => id.endsWith(":compact"));
    expect(compactFrames.length).toBeGreaterThan(0);
  });
});

// ── Bounding the transcript on BYTES, not just turn count ────────────────────
//
// `afterMessages` bounds turn COUNT: one oversized message (a large uncompacted
// tool result, since claim-check offloads a RESULT's bytes, not the transcript
// an agent re-sends every turn) still rides along in every turn's journaled
// `STEP_STARTED` input until it ages past `keepRecent` on count alone.
// `afterBytes` bounds the running UTF-8 byte total instead, with its own
// suffix rule: keep the longest run of the newest messages whose bytes total
// at most `afterBytes / 2`, floored at 1, capped at `keepRecent`.

/** `turns` tool-calling turns, then an answer. */
function turnScriptedProvider(seen: LlmRequest[], turns: number): LlmProvider {
  return {
    async complete(request) {
      seen.push(request);
      const turn = request.messages.filter((m) => m.role === "assistant").length;
      return turn < turns
        ? {
            content: `t${turn}`,
            toolCalls: [{ id: `c${turn}`, name: "lookup", input: { i: turn } }],
            stopReason: "tool_use",
          }
        : ({ content: "final", stopReason: "end_turn" } as LlmResponse);
    },
  };
}

interface BootBytesOptions {
  afterBytes?: number;
  afterMessages?: number;
  keepRecent?: number;
  turns?: number;
  /** 1-indexed `lookup` invocation that returns an oversized blob; others return `{ ok: true }`. */
  bigOnCall?: number;
  bigBytes?: number;
  /** Oversize the INITIAL user prompt instead of a tool result. */
  bigPrompt?: boolean;
  eventStore?: InMemoryAsyncEventStore;
}

function bootBytes(opts: BootBytesOptions) {
  const {
    afterBytes,
    afterMessages,
    keepRecent,
    turns = 4,
    bigOnCall,
    bigBytes = 5000,
    bigPrompt = false,
  } = opts;
  const seen: LlmRequest[] = [];
  const summaries: string[] = [];
  const effects = new EffectRuntime();
  effects.register("model", createAgentModelEffect(turnScriptedProvider(seen, turns)));
  let call = 0;
  effects.register(
    "lookup",
    new ToolEffect(async () => {
      call++;
      return call === bigOnCall ? { blob: "x".repeat(bigBytes) } : { ok: true };
    })
  );
  effects.register(
    "summarize",
    new ToolEffect(async (input) => {
      const { messages } = input as { messages: unknown[] };
      const summary = `folded ${messages.length}`;
      summaries.push(summary);
      return { summary };
    })
  );

  const eventStore = opts.eventStore ?? new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });
  const flowDef: FlowDefinition = {
    _tag: "FlowDefinition",
    id: "ask-bytes",
    name: "ask-bytes",
    version: "1.0.0",
    inputSchema: z.object({}),
    outputSchema: z.object({ content: z.string() }),
    steps: [],
  };
  const runner: FlowRunner<unknown, { content: string }> = async (ctx) => {
    const out = await agentLoop$(
      ctx,
      {
        definition: agent$({ id: "dba", name: "DBA", tools: [lookup] }),
        modelToolId: "model",
        maxIterations: turns + 3,
        compaction: {
          toolId: "summarize",
          ...(afterBytes !== undefined && { afterBytes }),
          ...(afterMessages !== undefined && { afterMessages }),
          ...(keepRecent !== undefined && { keepRecent }),
        },
      },
      { prompt: bigPrompt ? "x".repeat(bigBytes) : "go" }
    );
    return { content: out.content };
  };
  runtime.registerFlow(flowDef, runner as FlowRunner<unknown, unknown>);
  return { runtime, flowDef, seen, summaries, eventStore };
}

function compactFrames(events: readonly EventEnvelope[]): EventEnvelope[] {
  return events.filter(
    (e) =>
      e.eventType === "STEP_STARTED" &&
      (e.payload as { stepId: string }).stepId.endsWith(":compact")
  );
}

describe("the loop can bound its own transcript on BYTES", () => {
  it("triggers on bytes alone when afterMessages is unmet", async () => {
    const { runtime, flowDef, eventStore, summaries } = bootBytes({
      afterBytes: 1000,
      afterMessages: 100, // never crossed across this short run
      keepRecent: 2,
      turns: 3,
      bigOnCall: 1,
      bigBytes: 5000,
    });
    const handle = await runtime.start(flowDef, {}, { executionId: "b1" });
    const state = await handle.waitForCompletion();

    expect(state.status).toBe("completed");
    expect(summaries.length).toBeGreaterThan(0);
    expect(compactFrames(await eventStore.read("b1")).length).toBeGreaterThan(0);
  });

  it("does not compact when neither threshold is crossed (negative)", async () => {
    const { runtime, flowDef, eventStore, summaries } = bootBytes({
      afterBytes: 1_000_000,
      afterMessages: 1000,
      turns: 3,
    });
    const handle = await runtime.start(flowDef, {}, { executionId: "b2" });
    await handle.waitForCompletion();

    expect(summaries).toHaveLength(0);
    expect(compactFrames(await eventStore.read("b2"))).toHaveLength(0);
  });

  it("skips compaction when a single message alone exceeds afterBytes — no per-turn loop", async () => {
    const { runtime, flowDef, eventStore } = bootBytes({
      afterBytes: 1000,
      keepRecent: 4,
      turns: 5,
      bigPrompt: true,
      bigBytes: 5000,
    });
    const handle = await runtime.start(flowDef, {}, { executionId: "b3" });
    const state = await handle.waitForCompletion();

    expect(state.status).toBe("completed");
    // Bounded: not zero forever (the prompt eventually folds once the
    // transcript has more than one message), but never a summary call per turn.
    expect(compactFrames(await eventStore.read("b3")).length).toBeLessThanOrEqual(1);
  });

  it("recomputes the same compaction decision on replay (deterministic trigger)", async () => {
    const opts: BootBytesOptions = {
      afterBytes: 1000,
      keepRecent: 2,
      turns: 4,
      bigOnCall: 1,
      bigBytes: 5000,
    };
    const first = bootBytes(opts);
    const handle = await first.runtime.start(first.flowDef, {}, { executionId: "b4" });
    await handle.waitForCompletion();
    const full = await first.eventStore.read("b4");

    const compactStarted = full.find(
      (e) =>
        e.eventType === "STEP_STARTED" &&
        (e.payload as { stepId: string }).stepId.endsWith(":compact")
    );
    expect(compactStarted).toBeDefined();

    // Cut BEFORE the compact step itself is journaled, so recovery has to
    // recompute the trigger live from the replayed prefix, not read it off the log.
    const cutoff = full.indexOf(compactStarted as EventEnvelope);
    const prefix = full.slice(0, cutoff);

    const crashedStore = new InMemoryAsyncEventStore();
    for (const e of prefix) await crashedStore.append(e);

    const folded = new ReplayVM(prefix, {
      executionId: "b4",
      workflowId: "ask-bytes",
      workflowVersion: "1.0.0",
    }).getState();
    expect(folded.status).toBe("running");

    const second = bootBytes({ ...opts, eventStore: crashedStore });
    const recovered = await second.runtime.restoreFromState(folded);
    await recovered.waitForCompletion();

    const recoveredCompact = (await crashedStore.read("b4")).find(
      (e) =>
        e.eventType === "STEP_STARTED" &&
        (e.payload as { stepId: string }).stepId.endsWith(":compact")
    );
    // Same stepId, same folded `input.messages` — byte-identical, recomputed
    // purely from replayed values rather than served off a prior decision.
    expect(recoveredCompact?.payload).toEqual((compactStarted as EventEnvelope).payload);
  });
});

describe("compaction requires at least one threshold (constructor guard)", () => {
  it("fails the execution when neither afterMessages nor afterBytes is set", async () => {
    const effects = new EffectRuntime();
    effects.register("model", createAgentModelEffect(chattyProvider([])));
    effects.register("lookup", new ToolEffect(async () => ({ ok: true })));
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: effects,
    });
    const flowDef: FlowDefinition = {
      _tag: "FlowDefinition",
      id: "bad-compaction",
      name: "bad-compaction",
      version: "1.0.0",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      steps: [],
    };
    const runner: FlowRunner<unknown, unknown> = async (ctx) =>
      agentLoop$(
        ctx,
        {
          definition: agent$({ id: "dba", name: "DBA", tools: [lookup] }),
          modelToolId: "model",
          compaction: { toolId: "summarize" } as never,
        },
        { prompt: "go" }
      );
    runtime.registerFlow(flowDef, runner);
    const handle = await runtime.start(
      { definition: flowDef, runner } as RegisteredFlow,
      {},
      { executionId: "bad-compaction-1" }
    );
    const state = await handle
      .waitForCompletion()
      .catch(() => runtime.loadState("bad-compaction-1"));
    expect(state?.status).toBe("failed");
  });

  it("does not reject afterBytes alone (no afterMessages) — G2", async () => {
    const { runtime, flowDef } = bootBytes({ afterBytes: 1_000_000, turns: 1 });
    const handle = await runtime.start(flowDef, {}, { executionId: "guard-2" });
    const state = await handle.waitForCompletion();
    expect(state.status).toBe("completed");
  });
});

describe("chunkDeltas", () => {
  it("emits at sentence boundaries, not per token", () => {
    const out: string[] = [];
    const sink = chunkDeltas((t) => out.push(t));
    for (const d of ["Hel", "lo the", "re. ", "And ", "more!", " "]) sink.push(d);
    sink.flush();
    expect(out).toEqual(["Hello there. ", "And more! "]);
  });

  it("respects minChars so a terse sentence does not become its own event", () => {
    const out: string[] = [];
    const sink = chunkDeltas((t) => out.push(t), { minChars: 20 });
    for (const d of ["Yes. ", "No. ", "Maybe, it depends. "]) sink.push(d);
    sink.flush();
    expect(out).toEqual(["Yes. No. Maybe, it depends. "]);
  });

  it("flush emits the tail, and emits nothing when empty", () => {
    const out: string[] = [];
    const sink = chunkDeltas((t) => out.push(t));
    sink.push("no terminator");
    sink.flush();
    sink.flush(); // a durable sink must not get a meaningless empty append
    expect(out).toEqual(["no terminator"]);
  });
});
