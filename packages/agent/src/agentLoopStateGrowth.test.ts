import type { EventEnvelope, FlowDefinition, ToolDefinition } from "@loom/core";
import { agent$, tool$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";
import { ReplayVM } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type AgentLoopConfig, DEFAULT_STATE_GROWTH_WARN_BYTES, agentLoop$ } from "./agentLoop$";
import { createAgentModelEffect } from "./createAgentModelEffect";
import { createSummarizerEffect } from "./createSummarizerEffect";

// Issue #721 / ADR 0137. Item 1: an uncompacted loop reports (never changes) its state growth.
// Item 2: the built-in summarizer is an ordinary recorded, ring-routed effect.

const tool: ToolDefinition = tool$({
  id: "big",
  name: "big",
  description: "returns a lot",
  inputSchema: z.object({}).passthrough(),
  outputSchema: z.object({}).passthrough(),
});
const flowDef: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "grow",
  name: "grow",
  version: "1.0.0",
  inputSchema: z.object({}),
  outputSchema: z.object({}).passthrough(),
  steps: [],
};
const PAYLOAD = "x".repeat(1000);
const TURNS = 8;

function boot(o: { config?: Partial<AgentLoopConfig>; store?: InMemoryAsyncEventStore }) {
  const modelRequests: LlmRequest[] = [];
  const summaryRequests: LlmRequest[] = [];
  const warnings: string[] = [];
  const provider: LlmProvider = {
    async complete(r): Promise<LlmResponse> {
      // The summarizer asks with a `system` instruction and no tools; the agent turns carry tools.
      if (r.tools === undefined) {
        summaryRequests.push(r);
        return { content: "SUMMARY", stopReason: "end_turn" };
      }
      modelRequests.push(r);
      const n = r.messages.filter((m) => m.role === "assistant").length;
      return n < TURNS
        ? {
            content: `t${n}`,
            toolCalls: [{ id: `c${n}`, name: "big", input: {} }],
            stopReason: "tool_use",
          }
        : { content: "done", stopReason: "end_turn" };
    },
  };
  const effects = new EffectRuntime([], {});
  effects.register("model", createAgentModelEffect(provider));
  effects.register("summarize", createSummarizerEffect(provider));
  effects.register("big", new ToolEffect(async () => ({ data: PAYLOAD })));
  const store = o.store ?? new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore: store,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    divergence: "fail",
    scopes: true,
  });
  const config: AgentLoopConfig = {
    definition: agent$({ id: "a", name: "A", tools: [tool] }),
    modelToolId: "model",
    maxIterations: 20,
    onWarn: (m) => warnings.push(m),
    ...o.config,
  };
  const runner: FlowRunner<unknown, unknown> = async (ctx) =>
    agentLoop$(ctx, config, { prompt: "go" });
  runtime.registerFlow(flowDef, runner);
  return { runtime, store, modelRequests, summaryRequests, warnings };
}
type Booted = ReturnType<typeof boot>;
const run = async (b: Booted, id = "e1") =>
  (await b.runtime.start(flowDef, {}, { executionId: id })).waitForCompletion();
const stepOf = (e: EventEnvelope): string =>
  String((e.payload as { stepId?: string }).stepId ?? "");
/** The log's content (type + payload), without per-run ids or timestamps. */
const logShape = (events: EventEnvelope[]) =>
  JSON.stringify(events.map((e) => ({ t: e.eventType, p: e.payload })));

/** Crash after the log prefix before `fromTurn`, then resume on a fresh runtime over the prefix. */
async function resumeFrom(first: Booted, fromTurn: number, config: Partial<AgentLoopConfig>) {
  const full = await first.store.read("e1");
  const cutoff = full.findIndex((e) => stepOf(e).startsWith(`a#turn:${fromTurn}`));
  expect(cutoff).toBeGreaterThan(0);
  const prefix = full.slice(0, cutoff);
  const crashed = new InMemoryAsyncEventStore();
  for (const e of prefix) await crashed.append(e);
  const folded = new ReplayVM(prefix, {
    executionId: "e1",
    workflowId: "grow",
    workflowVersion: "1.0.0",
  }).getState();
  const b = boot({ store: crashed, config });
  const st = await (await b.runtime.restoreFromState(folded)).waitForCompletion();
  return { b, st, crashed, full };
}

describe("item 1 - the state-growth warning", () => {
  // The transcript grows ~1 kB per tool round; 3000 bytes is crossed by the 4th turn.
  const THRESHOLD = 3000;

  it("fires ONCE per run once the transcript crosses the threshold, naming the fix", async () => {
    const b = boot({ config: { warnTranscriptBytes: THRESHOLD } });
    expect((await run(b)).status).toBe("completed");
    expect(b.warnings).toHaveLength(1);
    expect(b.warnings[0]).toContain("compaction");
    expect(b.warnings[0]).toContain("afterBytes");
    expect(b.warnings[0]).toContain("docs/scaling.md");
  });

  it("is silent below the threshold", async () => {
    const b = boot({ config: { warnTranscriptBytes: 1_000_000 } });
    await run(b);
    expect(b.warnings).toEqual([]);
  });

  it("is silent with the default threshold on a small run (default is 256 KiB)", async () => {
    expect(DEFAULT_STATE_GROWTH_WARN_BYTES).toBe(256 * 1024);
    const b = boot({});
    await run(b);
    expect(b.warnings).toEqual([]);
  });

  it("is silent when `compaction` is configured, even far over the threshold", async () => {
    const b = boot({
      config: {
        warnTranscriptBytes: 100,
        compaction: { toolId: "summarize", afterBytes: 1_000_000 },
      },
    });
    await run(b);
    expect(b.warnings).toEqual([]);
  });

  it("`warnTranscriptBytes: false` turns it off", async () => {
    const b = boot({ config: { warnTranscriptBytes: false } });
    await run(b);
    expect(b.warnings).toEqual([]);
  });

  it("changes nothing: the recorded log and the model's requests are identical with and without the warning", async () => {
    const warned = boot({ config: { warnTranscriptBytes: THRESHOLD } });
    const quiet = boot({ config: { warnTranscriptBytes: false } });
    await run(warned);
    await run(quiet);
    expect(warned.warnings).toHaveLength(1);
    expect(quiet.warnings).toEqual([]);
    expect(logShape(await warned.store.read("e1"))).toBe(logShape(await quiet.store.read("e1")));
    expect(JSON.stringify(warned.modelRequests)).toBe(JSON.stringify(quiet.modelRequests));
  });

  it("a resume replays the crossing turn from the log: it warns again (once), makes no model call for replayed turns, and appends nothing extra", async () => {
    const first = boot({ config: { warnTranscriptBytes: THRESHOLD } });
    await run(first);
    const { b, st, crashed, full } = await resumeFrom(first, 6, {
      warnTranscriptBytes: THRESHOLD,
    });
    expect(st.status).toBe("completed");
    expect(b.warnings).toHaveLength(1);
    // Only turns 6.. asked the model; turns 0..5 (incl. the crossing) came from the log.
    expect(b.modelRequests).toHaveLength(TURNS + 1 - 6);
    expect(logShape(await crashed.read("e1"))).toBe(logShape(full));
  });
});

describe("item 2 - createSummarizerEffect", () => {
  const compaction = { toolId: "summarize", afterBytes: 3000, keepRecent: 2 };

  it("journals the summary; the transcript reaches the model fenced in a user message, and the agent's next turn sees the summary", async () => {
    const b = boot({ config: { compaction } });
    expect((await run(b)).status).toBe("completed");
    expect(b.summaryRequests.length).toBeGreaterThan(0);
    const req = b.summaryRequests[0] as LlmRequest;
    expect(req.system).toContain("summar");
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]?.role).toBe("user");
    expect(JSON.stringify(req.messages[0])).toContain("agent:summarizer-input");
    expect(JSON.stringify(b.modelRequests)).toContain("Summary of earlier turns: SUMMARY");
    const events = await b.store.read("e1");
    expect(events.some((e) => /#turn:\d+:compact/.test(stepOf(e)))).toBe(true);
  });

  it("a resume serves every recorded compaction from the log: zero summarizer calls for them", async () => {
    const first = boot({ config: { compaction } });
    await run(first);
    const compactTurns = (await first.store.read("e1"))
      .map(stepOf)
      .filter((s) => /#turn:\d+:compact$/.test(s));
    expect(compactTurns.length).toBeGreaterThan(0);
    const { b, st } = await resumeFrom(first, 7, { compaction });
    expect(st.status).toBe("completed");
    // Compactions at turns < 7 are replayed; nothing re-asked the summarizer for them.
    const live = new Set(
      (await b.store.read("e1")).map(stepOf).filter((s) => /#turn:\d+:compact$/.test(s))
    );
    expect(b.summaryRequests.length).toBeLessThanOrEqual(
      [...live].filter((s) => Number(/#turn:(\d+):/.exec(s)?.[1]) >= 7).length
    );
  });
});
