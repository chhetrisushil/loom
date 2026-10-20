import { createHash } from "node:crypto";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { agent$, tool$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type {
  LlmMessage,
  LlmProvider,
  LlmReasoning,
  LlmRequest,
  LlmResponse,
  ReasoningStore,
} from "@loom/llm";
import { ReasoningRuntime } from "@loom/reasoning";
import { ReplayVM } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentLoop$, registerReasoningRoutes } from "./agentLoop$";
import { createAgentModelEffect } from "./createAgentModelEffect";

// ── ADR 0133 D5 — reasoning continuation through agentLoop$ ─────────────────────
//
// A model on a tool-use loop must get its previous reasoning blocks and tool signatures back. The
// blocks are carried on the transcript as RECORDED parts (signature + reference, never text), the
// text is resolved from the sidecar at request time, and any edit of the history drops them.

const lookup = tool$({
  id: "lookup",
  name: "Lookup",
  description: "Looks up",
  kind: "tool",
  inputSchema: z.object({}).passthrough(),
  outputSchema: z.object({}).passthrough(),
});
const dba = agent$({ id: "dba", name: "DBA", tools: [lookup] });

const flowDef: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "ask",
  name: "ask",
  version: "1.0.0",
  inputSchema: z.object({}),
  outputSchema: z.object({ content: z.string() }),
  steps: [],
};

function memStore(): ReasoningStore {
  const blobs = new Map<string, Uint8Array>();
  return {
    async put(bytes) {
      const address = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      blobs.set(address, bytes);
      return { __loomContent: address };
    },
    async get(ref) {
      return blobs.get(ref.__loomContent) ?? null;
    },
  };
}

const secretOf = (turn: number): string => `SECRET-THOUGHT-${turn}`;

/** A reasoning model: tool_use for `toolTurns` turns, each with reasoning text, a signature on the call. */
function reasoningProvider(
  id: string,
  seen: LlmRequest[],
  toolTurns = 3,
  providerName = "anthropic",
  interleaved = false
): LlmProvider {
  return {
    async complete(request: LlmRequest): Promise<LlmResponse> {
      seen.push(request);
      const turn = request.messages.filter((m) => m.role === "assistant").length;
      const reasoning: LlmReasoning[] = [
        {
          kind: "summary",
          text: secretOf(turn),
          signature: `sig-${id}-${turn}`,
          provider: providerName,
        },
      ];
      if (interleaved && turn < toolTurns) {
        // reasoning, tool_use, reasoning, text: not the canonical order (ADR 0133 D5).
        return {
          content: `t${turn}`,
          toolCalls: [{ id: `c${turn}`, name: "lookup", input: { i: turn } }],
          stopReason: "tool_use",
          reasoning: [
            ...reasoning,
            { ...reasoning[0], signature: `sig-${id}-${turn}b` } as LlmReasoning,
          ],
          layout: ["reasoning", { call: `c${turn}` }, "reasoning", { text: `t${turn}`.length }],
        };
      }
      return turn < toolTurns
        ? {
            content: `t${turn}`,
            toolCalls: [
              { id: `c${turn}`, name: "lookup", input: { i: turn }, signature: `ts${turn}` },
            ],
            stopReason: "tool_use",
            reasoning,
          }
        : { content: "final", stopReason: "end_turn", reasoning };
    },
  };
}

const partsOf = (m: LlmMessage, type: string): Record<string, unknown>[] =>
  typeof m.content === "string"
    ? []
    : (m.content.filter((p) => p.type === type) as unknown as Record<string, unknown>[]);

const reasoningIn = (req: LlmRequest): Record<string, unknown>[] =>
  req.messages.flatMap((m) => partsOf(m, "reasoning"));
const signaturesIn = (req: LlmRequest): unknown[] =>
  req.messages.flatMap((m) => partsOf(m, "tool_use")).map((p) => p.signature);

function boot(opts: {
  seen: LlmRequest[];
  store?: InMemoryAsyncEventStore;
  reasoningStore?: ReasoningStore;
  compaction?: { afterMessages: number; keepRecent: number };
  summarizerInputs?: unknown[];
  toolTurns?: number;
  interleaved?: boolean;
}) {
  const effects = new EffectRuntime();
  effects.register(
    "model",
    createAgentModelEffect(
      reasoningProvider("m", opts.seen, opts.toolTurns, "anthropic", opts.interleaved === true),
      {
        ...(opts.reasoningStore !== undefined && { reasoning: { store: opts.reasoningStore } }),
      }
    )
  );
  effects.register("lookup", new ToolEffect(async (input) => ({ ok: true, input })));
  effects.register(
    "summarize",
    new ToolEffect(async (input) => {
      opts.summarizerInputs?.push(input);
      return { summary: "folded" };
    })
  );
  const eventStore = opts.store ?? new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    divergence: "fail",
  });
  const runner: FlowRunner<unknown, { content: string }> = async (ctx) => ({
    content: (
      await agentLoop$(
        ctx,
        {
          definition: dba,
          modelToolId: "model",
          maxIterations: 9,
          ...(opts.compaction !== undefined && {
            compaction: { toolId: "summarize", ...opts.compaction },
          }),
        },
        { prompt: "go" }
      )
    ).content,
  });
  runtime.registerFlow(flowDef, runner as FlowRunner<unknown, unknown>);
  return { runtime, eventStore };
}

const compactIds = (events: EventEnvelope[]): string[] =>
  [
    ...new Set(
      events
        .map((e) => (e.payload as { stepId?: string }).stepId)
        .filter((id): id is string => typeof id === "string" && id.endsWith(":compact"))
    ),
  ].sort();

describe("agentLoop$ carries reasoning through the transcript (ADR 0133 D5)", () => {
  it("sends the previous turns' reasoning (text resolved from the sidecar) and tool signatures back", async () => {
    const seen: LlmRequest[] = [];
    const { runtime, eventStore } = boot({ seen, reasoningStore: memStore() });
    const h = await runtime.start(flowDef, {}, { executionId: "c1" });
    expect((await h.waitForCompletion()).status).toBe("completed");

    expect(reasoningIn(seen[0] as LlmRequest)).toEqual([]);
    const second = reasoningIn(seen[1] as LlmRequest);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ signature: "sig-m-0", text: secretOf(0) });
    expect(signaturesIn(seen[1] as LlmRequest)).toEqual(["ts0"]);
    expect(reasoningIn(seen[3] as LlmRequest).map((p) => p.signature)).toEqual([
      "sig-m-0",
      "sig-m-1",
      "sig-m-2",
    ]);
    // The assistant message carries the reasoning BEFORE its text and tool_use.
    const assistant = (seen[1] as LlmRequest).messages.find((m) => m.role === "assistant");
    expect((assistant?.content as { type: string }[])[0]?.type).toBe("reasoning");

    // Negative: readable reasoning is in NO journaled value (step values, frame inputs, events).
    const log = JSON.stringify(await eventStore.read("c1"));
    expect(log).not.toContain("SECRET-THOUGHT");
    expect(log).toContain("sig-m-0"); // signatures are recorded inline
  });

  it("sends the vendor's block ORDER back: reasoning, tool_use, reasoning, text (not regrouped)", async () => {
    const seen: LlmRequest[] = [];
    const { runtime } = boot({ seen, reasoningStore: memStore(), interleaved: true });
    const h = await runtime.start(flowDef, {}, { executionId: "c-order" });
    expect((await h.waitForCompletion()).status).toBe("completed");
    const assistant = (seen[1] as LlmRequest).messages.find((m) => m.role === "assistant");
    expect((assistant?.content as { type: string }[]).map((p) => p.type)).toEqual([
      "reasoning",
      "tool_use",
      "reasoning",
      "text",
    ]);
    // Every later request keeps every earlier turn in that order, too.
    const last = (seen[3] as LlmRequest).messages.filter((m) => m.role === "assistant");
    for (const m of last) {
      expect((m.content as { type: string }[]).map((p) => p.type)).toEqual([
        "reasoning",
        "tool_use",
        "reasoning",
        "text",
      ]);
    }
  });

  it("with no store the text is not kept: the part is dropped from continuation, the call signature stays", async () => {
    const seen: LlmRequest[] = [];
    const { runtime, eventStore } = boot({ seen });
    const h = await runtime.start(flowDef, {}, { executionId: "c2" });
    expect((await h.waitForCompletion()).status).toBe("completed");
    // The only reasoning part is flagged omitted; the provider-visible request has none of it.
    expect(reasoningIn(seen[1] as LlmRequest)).toEqual([]);
    expect(signaturesIn(seen[1] as LlmRequest)).toEqual(["ts0"]);
    expect(JSON.stringify(await eventStore.read("c2"))).not.toContain("SECRET-THOUGHT");
  });

  it("compaction drops EVERY reasoning part from the kept suffix and from the summarizer input; tool signatures stay", async () => {
    const seen: LlmRequest[] = [];
    const summarizerInputs: unknown[] = [];
    const { runtime } = boot({
      seen,
      reasoningStore: memStore(),
      compaction: { afterMessages: 3, keepRecent: 2 },
      summarizerInputs,
    });
    const h = await runtime.start(flowDef, {}, { executionId: "c3" });
    expect((await h.waitForCompletion()).status).toBe("completed");

    expect(summarizerInputs.length).toBeGreaterThan(0);
    expect(JSON.stringify(summarizerInputs)).not.toContain('"reasoning"');
    // Before the first compaction reasoning flowed; once the summary replaced the prefix, none of
    // the kept messages carried a part, yet the kept tool_use still has its signature.
    const compacted = seen.filter((r) =>
      r.messages.some((m) => typeof m.content === "string" && m.content.startsWith("Summary of"))
    );
    expect(compacted.length).toBeGreaterThan(0);
    const first = compacted[0] as LlmRequest;
    expect(reasoningIn(first)).toEqual([]);
    expect(signaturesIn(first).length).toBeGreaterThan(0);
    expect(signaturesIn(first).every((s) => typeof s === "string")).toBe(true);
    // The turns AFTER the edit point accumulate reasoning again (valid: produced after the edit).
    expect(seen.some((r) => reasoningIn(r).length > 0 && !compacted.includes(r))).toBe(true);
  });

  it("reasoning parts weigh zero bytes: a reasoning run compacts on exactly the turns a reasoning-free run does", async () => {
    const run = async (withReasoning: boolean): Promise<string[]> => {
      const seen: LlmRequest[] = [];
      const effects = new EffectRuntime();
      const base = reasoningProvider("m", seen);
      const provider: LlmProvider = withReasoning
        ? base
        : {
            async complete(r) {
              const { reasoning: _r, ...rest } = await base.complete(r);
              return rest;
            },
          };
      effects.register(
        "model",
        createAgentModelEffect(provider, { reasoning: { store: memStore() } })
      );
      effects.register("lookup", new ToolEffect(async (input) => ({ ok: true, input })));
      effects.register("summarize", new ToolEffect(async () => ({ summary: "folded" })));
      const eventStore = new InMemoryAsyncEventStore();
      const runtime = new WorkflowRuntime({
        eventStore,
        snapshotStore: new InMemoryAsyncSnapshotStore(),
        effectRuntime: effects,
      });
      const runner: FlowRunner<unknown, unknown> = async (ctx) =>
        agentLoop$(
          ctx,
          {
            definition: dba,
            modelToolId: "model",
            maxIterations: 9,
            compaction: { toolId: "summarize", afterBytes: 120, keepRecent: 2 },
          },
          { prompt: "go" }
        );
      runtime.registerFlow(flowDef, runner);
      const h = await runtime.start(flowDef, {}, { executionId: "z" });
      await h.waitForCompletion();
      return compactIds(await eventStore.read("z"));
    };
    const withR = await run(true);
    expect(withR.length).toBeGreaterThan(0);
    expect(withR).toEqual(await run(false));
  });

  it("replay: a run recorded with reasoning resumes with ZERO model calls for recorded turns and the live turn still gets the text", async () => {
    const seen1: LlmRequest[] = [];
    const reasoningStore = memStore();
    const first = boot({ seen: seen1, reasoningStore });
    const h = await first.runtime.start(flowDef, {}, { executionId: "rp" });
    expect((await h.waitForCompletion()).status).toBe("completed");
    const full = await first.eventStore.read("rp");

    const cutoff = full.findIndex((e: EventEnvelope) =>
      String((e.payload as { stepId?: string }).stepId ?? "").startsWith("dba#turn:2")
    );
    expect(cutoff).toBeGreaterThan(0);
    const prefix = full.slice(0, cutoff);
    const crashed = new InMemoryAsyncEventStore();
    for (const e of prefix) await crashed.append(e);
    const folded = new ReplayVM(prefix, {
      executionId: "rp",
      workflowId: "ask",
      workflowVersion: "1.0.0",
    }).getState();

    const seen2: LlmRequest[] = [];
    const resumed = boot({ seen: seen2, store: crashed, reasoningStore });
    const recovered = await resumed.runtime.restoreFromState(folded);
    expect((await recovered.waitForCompletion()).status).toBe("completed");
    // Turns 0 and 1 were served from the log: only turns 2 and 3 called the model.
    expect(seen2).toHaveLength(2);
    const live = reasoningIn(seen2[0] as LlmRequest);
    expect(live.map((p) => p.text)).toEqual([secretOf(0), secretOf(1)]);
  });
});

describe("a routed loop drops another model's reasoning (ADR 0133 D5, same-provider switch)", () => {
  function bootRouted(seen: { a: LlmRequest[]; b: LlmRequest[] }, withRing: boolean) {
    const order = ["a", "b", "b", "b"];
    let n = 0;
    const reasoning = new ReasoningRuntime({
      routes: [
        { id: "a", provider: reasoningProvider("a", seen.a, 3), tier: 0 },
        { id: "b", provider: reasoningProvider("b", seen.b, 3), tier: 1 },
      ],
      router: {
        select(_req, routes) {
          const id = order[Math.min(n++, order.length - 1)];
          return routes.find((r) => r.id === id) ?? (routes[0] as (typeof routes)[number]);
        },
      },
    });
    const effects = new EffectRuntime();
    effects.register("lookup", new ToolEffect(async (input) => ({ ok: true, input })));
    const reasoningStore = memStore();
    const toolIdFor = registerReasoningRoutes(effects, reasoning, {
      reasoning: { store: reasoningStore },
    });
    const eventStore = new InMemoryAsyncEventStore();
    const runtime = new WorkflowRuntime({
      eventStore,
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: effects,
    });
    const runner: FlowRunner<unknown, unknown> = async (ctx) =>
      agentLoop$(
        ctx,
        {
          definition: dba,
          reasoning,
          maxIterations: 9,
          ...(withRing && { reasoningToolId: toolIdFor }),
        },
        { prompt: "go" }
      );
    runtime.registerFlow(flowDef, runner);
    return { runtime, eventStore };
  }

  it("route b never receives route a's parts; it keeps its own", async () => {
    const seen = { a: [] as LlmRequest[], b: [] as LlmRequest[] };
    const { runtime, eventStore } = bootRouted(seen, true);
    const h = await runtime.start(flowDef, {}, { executionId: "rt" });
    expect((await h.waitForCompletion()).status).toBe("completed");
    expect(seen.a).toHaveLength(1);
    expect(seen.b.length).toBeGreaterThanOrEqual(2);
    // b's first request: only a's turn precedes it -> a's part is dropped, a's tool signature stays.
    expect(reasoningIn(seen.b[0] as LlmRequest)).toEqual([]);
    expect(signaturesIn(seen.b[0] as LlmRequest)).toEqual(["ts0"]);
    // b's second request: a's part still dropped, b's own part (turn 1) is carried.
    expect(reasoningIn(seen.b[1] as LlmRequest).map((p) => p.signature)).toEqual(["sig-b-1"]);
    expect(JSON.stringify(await eventStore.read("rt"))).not.toContain("SECRET-THOUGHT");
  });

  it("without the effect ring nothing readable is journaled and no reasoning block is carried", async () => {
    const seen = { a: [] as LlmRequest[], b: [] as LlmRequest[] };
    const { runtime, eventStore } = bootRouted(seen, false);
    const h = await runtime.start(flowDef, {}, { executionId: "rd" });
    expect((await h.waitForCompletion()).status).toBe("completed");
    const all = [...seen.a, ...seen.b];
    expect(all.every((r) => reasoningIn(r).length === 0)).toBe(true);
    expect(JSON.stringify(await eventStore.read("rd"))).not.toContain("SECRET-THOUGHT");
  });
});

describe("a change to the tool set is an edit point (ADR 0133 D5)", () => {
  const dbSlow = tool$({
    id: "db_slow_queries",
    name: "db_slow_queries",
    description: "List the slowest queries on the database",
    kind: "tool",
    inputSchema: z.object({}).passthrough(),
    outputSchema: z.object({}).passthrough(),
  });

  /** turn 0 searches (loading a tool), turn 1 calls it, turn 2 answers; every turn carries reasoning. */
  function searchingProvider(seen: LlmRequest[]): LlmProvider {
    return {
      async complete(request) {
        seen.push(request);
        const turn = request.messages.filter((m) => m.role === "assistant").length;
        const reasoning: LlmReasoning[] = [
          {
            kind: "summary",
            text: secretOf(turn),
            signature: `sig-${turn}`,
            provider: "anthropic",
          },
        ];
        if (turn === 0) {
          return {
            content: "search",
            toolCalls: [
              {
                id: "s0",
                name: "search_tools",
                input: { query: "slow queries" },
                signature: "ts0",
              },
            ],
            stopReason: "tool_use",
            reasoning,
          };
        }
        if (turn === 1) {
          return {
            content: "use it",
            toolCalls: [{ id: "c1", name: "db_slow_queries", input: {}, signature: "ts1" }],
            stopReason: "tool_use",
            reasoning,
          };
        }
        return { content: "final", stopReason: "end_turn", reasoning };
      },
    };
  }

  async function run(toolSearch: boolean) {
    const seen: LlmRequest[] = [];
    const effects = new EffectRuntime();
    effects.register(
      "model",
      createAgentModelEffect(searchingProvider(seen), { reasoning: { store: memStore() } })
    );
    effects.register("db_slow_queries", new ToolEffect(async () => ({ ok: true })));
    effects.register("lookup", new ToolEffect(async () => ({ ok: true })));
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: effects,
      divergence: "fail",
    });
    const runner: FlowRunner<unknown, { content: string }> = async (ctx) => ({
      content: (
        await agentLoop$(
          ctx,
          {
            definition: toolSearch
              ? dba
              : agent$({ id: "dba2", name: "DBA", tools: [lookup, dbSlow] }),
            modelToolId: "model",
            maxIterations: 9,
            ...(toolSearch && { toolSearch: { catalog: [dbSlow] } }),
          },
          { prompt: "go" }
        )
      ).content,
    });
    runtime.registerFlow(flowDef, runner as FlowRunner<unknown, unknown>);
    const h = await runtime.start(flowDef, {}, { executionId: toolSearch ? "ts-on" : "ts-off" });
    expect((await h.waitForCompletion()).status).toBe("completed");
    return seen;
  }

  it("after a search grows the menu, EVERY earlier reasoning part is dropped; tool signatures stay", async () => {
    const seen = await run(true);
    // The request that carried the search call is made with the tools it was signed under.
    expect(reasoningIn(seen[1] as LlmRequest)).toEqual([]); // tools grew after turn 0
    expect(signaturesIn(seen[1] as LlmRequest)).toEqual(["ts0"]);
    // Turn 1 was produced under the NEW tool set and nothing changed since: it is continued, turn 0's is not.
    expect(reasoningIn(seen[2] as LlmRequest).map((p) => p.signature)).toEqual(["sig-1"]);
    expect(signaturesIn(seen[2] as LlmRequest)).toEqual(["ts0", "ts1"]);
  });

  it("negative: with a fixed tool set no part is dropped", async () => {
    const seen = await run(false);
    expect(reasoningIn(seen[1] as LlmRequest).map((p) => p.signature)).toEqual(["sig-0"]);
    expect(reasoningIn(seen[2] as LlmRequest).map((p) => p.signature)).toEqual(["sig-0", "sig-1"]);
  });
});
