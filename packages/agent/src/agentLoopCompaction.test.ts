import type { FlowDefinition } from "@loom/core";
import { agent$, tool$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";
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
