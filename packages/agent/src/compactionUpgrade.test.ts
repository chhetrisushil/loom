import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { agent$, tool$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmContent, LlmMessageInput, LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";
import { ReplayVM } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { ExecutionContext, FlowRunner } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentLoop$ } from "./agentLoop$";
import { createAgentModelEffect } from "./createAgentModelEffect";
import { toolResultContent } from "./toolResultContent";

// ── R5 upgrade claim: a run recorded by the PRE-R5 loop resumes under the new one ──────────────
//
// The replay-divergence detector (ADR 0113) compares step IDS. The compaction frame's id
// (`#turn:<t>:compact`) is a function of WHEN the trigger fires, and the trigger is a function of the
// transcript's measure. R5 changed the transcript's shape (1+N messages per tool turn became 2), so a
// measure over the new shape would move the compact frames. `agentLoop$` therefore measures a virtual
// transcript with the OLD shape and sizes. This test proves it against the real old body: the
// `legacyAgentLoop` below is the origin/main loop's transcript / compaction logic, verbatim, reduced to
// what the scenario exercises (model call, tool calls, compaction).

const UTF8 = new TextEncoder();
const rawOf = (c: LlmContent): string => (typeof c === "string" ? c : c.value);
const legacyBytes = (m: LlmMessageInput): number =>
  UTF8.encode(rawOf(m.content as LlmContent)).length;

function legacyKept(messages: readonly LlmMessageInput[], afterBytes: number, keepRecent: number) {
  const half = afterBytes / 2;
  let count = 1;
  let bytes = legacyBytes(messages[messages.length - 1] as LlmMessageInput);
  for (let i = messages.length - 2; i >= 0 && count < keepRecent; i--) {
    const b = legacyBytes(messages[i] as LlmMessageInput);
    if (bytes + b > half) break;
    bytes += b;
    count++;
  }
  return count;
}

async function legacyAgentLoop(
  ctx: ExecutionContext,
  config: {
    id: string;
    modelToolId: string;
    maxIterations: number;
    compaction: {
      toolId: string;
      afterMessages?: number;
      afterBytes?: number;
      keepRecent?: number;
    };
  },
  prompt: string
): Promise<string> {
  const idPrefix = config.id;
  const messages: LlmMessageInput[] = [];
  let transcriptBytes = 0;
  const pushMessage = (msg: LlmMessageInput): void => {
    messages.push(msg);
    transcriptBytes += legacyBytes(msg);
  };
  pushMessage({ role: "user", content: prompt });
  let iterations = 0;
  let lastContent = "";
  while (iterations < config.maxIterations) {
    const turn = iterations;
    iterations++;
    const compaction = config.compaction;
    const overMessages =
      compaction.afterMessages !== undefined && messages.length > compaction.afterMessages;
    const overBytes =
      compaction.afterBytes !== undefined && transcriptBytes > compaction.afterBytes;
    if (overMessages || overBytes) {
      const keepRecent = compaction.keepRecent ?? 4;
      const keep = overBytes
        ? legacyKept(messages, compaction.afterBytes as number, keepRecent)
        : keepRecent;
      const foldLength = messages.length - keep;
      if (foldLength > 0) {
        const fold = messages.slice(0, foldLength);
        const recent = messages.slice(foldLength);
        const { summary } = (await ctx.execute(
          {
            _tag: "TaskDefinition",
            kind: "memory",
            id: `${idPrefix}#turn:${turn}:compact`,
            toolId: compaction.toolId,
          },
          { messages: fold }
        )) as { summary: string };
        messages.length = 0;
        transcriptBytes = 0;
        for (const m of [
          { role: "user", content: `Summary of earlier turns: ${summary}` },
          ...recent,
        ]) {
          pushMessage(m as LlmMessageInput);
        }
      }
    }
    const response = (await ctx.execute(
      {
        _tag: "TaskDefinition",
        kind: "llm",
        id: `${idPrefix}#turn:${turn}`,
        toolId: config.modelToolId,
      },
      { messages }
    )) as LlmResponse;
    lastContent = response.content;
    if (response.stopReason === "end_turn" || !response.toolCalls?.length) break;
    pushMessage({ role: "assistant", content: response.content || "(tool calls)" });
    for (const [j, toolCall] of response.toolCalls.entries()) {
      const output = await ctx.execute(
        {
          _tag: "TaskDefinition",
          kind: "tool",
          id: `${idPrefix}#turn:${turn}:tool:${j}`,
          toolId: toolCall.name,
        },
        toolCall.input
      );
      pushMessage({ role: "user", content: toolResultContent(toolCall.name, output) });
    }
  }
  return lastContent;
}

// ── the scenario: two tool calls per turn, afterMessages 3, keepRecent 2 ─────────────────────

const lookup = tool$({
  id: "lookup",
  name: "Lookup",
  description: "Looks up",
  kind: "tool",
  inputSchema: z.object({}).passthrough(),
  outputSchema: z.object({}).passthrough(),
});
const dba = agent$({ id: "dba", name: "DBA", tools: [lookup] });

function provider(calls: { n: number }, perTurn = 2): LlmProvider {
  return {
    async complete(request: LlmRequest): Promise<LlmResponse> {
      calls.n++;
      const turn = request.messages.filter((m) => m.role === "assistant").length;
      return turn < 5
        ? {
            content: `t${turn}`,
            toolCalls: Array.from({ length: perTurn }, (_, k) => ({
              id: `c${turn}-${k}`,
              name: "lookup",
              input: { i: turn, k },
            })),
            stopReason: "tool_use",
          }
        : { content: "final", stopReason: "end_turn" };
    },
  };
}

const flowDef: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "ask",
  name: "ask",
  version: "1.0.0",
  inputSchema: z.object({}),
  outputSchema: z.object({ content: z.string() }),
  steps: [],
};

const COMPACTION = { toolId: "summarize", afterMessages: 3, keepRecent: 2 };

function boot(
  body: "legacy" | "new",
  opts: {
    store?: InMemoryAsyncEventStore;
    compaction?: Omit<typeof COMPACTION, "afterMessages"> & {
      afterMessages?: number;
      afterBytes?: number;
    };
    perTurn?: number;
  } = {}
) {
  const calls = { n: 0 };
  const warnings: string[] = [];
  const effects = new EffectRuntime();
  effects.register("model", createAgentModelEffect(provider(calls, opts.perTurn)));
  effects.register("lookup", new ToolEffect(async (input) => ({ ok: true, input })));
  effects.register("summarize", new ToolEffect(async () => ({ summary: "folded" })));
  const eventStore = opts.store ?? new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    divergence: "fail",
    onWarn: (m) => warnings.push(m),
  });
  const compaction = opts.compaction ?? COMPACTION;
  const runner: FlowRunner<unknown, { content: string }> = async (ctx) =>
    body === "legacy"
      ? {
          content: await legacyAgentLoop(
            ctx,
            { id: "dba", modelToolId: "model", maxIterations: 9, compaction },
            "go"
          ),
        }
      : {
          content: (
            await agentLoop$(
              ctx,
              { definition: dba, modelToolId: "model", maxIterations: 9, compaction },
              { prompt: "go" }
            )
          ).content,
        };
  runtime.registerFlow(flowDef, runner as FlowRunner<unknown, unknown>);
  return { runtime, eventStore, calls, warnings };
}

const compactIds = (events: EventEnvelope[]): string[] =>
  [
    ...new Set(
      events
        .map((e) => (e.payload as { stepId?: string }).stepId)
        .filter((id): id is string => typeof id === "string" && id.endsWith(":compact"))
    ),
  ].sort();

async function crashAndResume(
  compaction: Omit<typeof COMPACTION, "afterMessages"> & {
    afterMessages?: number;
    afterBytes?: number;
  },
  crashAt: string,
  perTurn = 2
) {
  const legacy = boot("legacy", { compaction, perTurn });
  const handle = await legacy.runtime.start(flowDef, {}, { executionId: "up-1" });
  expect((await handle.waitForCompletion()).status).toBe("completed");
  const full = await legacy.eventStore.read("up-1");

  const cutoff = full.findIndex((e: EventEnvelope) =>
    String((e.payload as { stepId?: string }).stepId ?? "").startsWith(crashAt)
  );
  expect(cutoff).toBeGreaterThan(0);
  const prefix = full.slice(0, cutoff);
  const crashed = new InMemoryAsyncEventStore();
  for (const e of prefix) await crashed.append(e);
  const folded = new ReplayVM(prefix, {
    executionId: "up-1",
    workflowId: "ask",
    workflowVersion: "1.0.0",
  }).getState();
  expect(folded.status).toBe("running");

  const upgraded = boot("new", { store: crashed, compaction, perTurn });
  const recovered = await upgraded.runtime.restoreFromState(folded);
  const state = await recovered.waitForCompletion();
  return { full, prefix, upgraded, state, final: await crashed.read("up-1") };
}

describe("a run recorded by the pre-R5 agent loop resumes under the new one (compaction)", () => {
  it("message trigger: crash before turn 3, resume with divergence 'fail' — completes, same compact frames", async () => {
    const { full, prefix, upgraded, state, final } = await crashAndResume(COMPACTION, "dba#turn:3");
    // The old run really did compact before the crash point (else the test proves nothing)...
    expect(compactIds(prefix).length).toBeGreaterThan(0);
    expect(state.status).toBe("completed");
    expect(upgraded.warnings.filter((w) => /diverge/i.test(w))).toEqual([]);
    // ...and the new body compacted on exactly the turns the old one did, through to the end.
    expect(compactIds(final)).toEqual(compactIds(full));
  });

  it("byte trigger: the same, with afterBytes deciding", async () => {
    const compaction = { toolId: "summarize", afterBytes: 150, keepRecent: 3 };
    const { full, prefix, state, final, upgraded } = await crashAndResume(compaction, "dba#turn:3");
    expect(compactIds(prefix).length).toBeGreaterThan(0);
    expect(state.status).toBe("completed");
    expect(upgraded.warnings.filter((w) => /diverge/i.test(w))).toEqual([]);
    expect(compactIds(final)).toEqual(compactIds(full));
  });

  it("three calls per turn, keepRecent 3: the kept suffix is not the physical tail, and the frames still match", async () => {
    // Here `messages.length - keepOld` differs from the virtual length (one physical results
    // message stands for three old ones), the case a trigger computed on the wrong list gets wrong.
    const compaction = { toolId: "summarize", afterMessages: 3, keepRecent: 3 };
    const { full, prefix, state, final, upgraded } = await crashAndResume(
      compaction,
      "dba#turn:3",
      3
    );
    expect(compactIds(prefix).length).toBeGreaterThan(0);
    expect(state.status).toBe("completed");
    expect(upgraded.warnings.filter((w) => /diverge/i.test(w))).toEqual([]);
    expect(compactIds(final)).toEqual(compactIds(full));
  });

  it("keepRecent 0 does not crash and still folds the whole transcript", async () => {
    const compaction = { toolId: "summarize", afterMessages: 3, keepRecent: 0 };
    const legacy = boot("legacy", { compaction });
    const h1 = await legacy.runtime.start(flowDef, {}, { executionId: "k0-legacy" });
    await h1.waitForCompletion();
    const fresh = boot("new", { compaction });
    const h2 = await fresh.runtime.start(flowDef, {}, { executionId: "k0-new" });
    expect((await h2.waitForCompletion()).status).toBe("completed");
    expect(compactIds(await fresh.eventStore.read("k0-new"))).toEqual(
      compactIds(await legacy.eventStore.read("k0-legacy"))
    );
  });
});
