import { agent$, tool$ } from "@loomwork/core";
import type { FlowDefinition } from "@loomwork/core";
import { EffectRuntime, GrantTable, ToolEffect } from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore } from "@loomwork/event-runtime";
import type { LlmProvider, LlmRequest } from "@loomwork/llm";
import { InMemoryMemoryStore, TieredMemory } from "@loomwork/memory";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import {
  InMemoryGrantBroker,
  TaskGrantAuthorizer,
  installTaskAuthority,
} from "@loomwork/task-authority";
import { WorkflowRuntime, answerApproval } from "@loomwork/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type AgentLoopConfig,
  agentLoop$,
  memoryRecallEffect,
  memoryWriteBackEffect,
} from "./agentLoop$";
import { createAgentModelEffect } from "./createAgentModelEffect";

// ADR 0150 D8 (slice-2 S6a): memory recall as an effect, scoped by a task grant's `reads`.
const SECRET = "recall-secret";
const NOW = 1_000_000;
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

function boot(o: {
  recall: boolean;
  park?: boolean;
  reads?: string[] | undefined;
  scope?: string;
  /** `writeBack.scope` with `distill` (the existing-facts read). */
  distillScope?: string;
}) {
  const distillCalls: unknown[] = [];
  const store = new InMemoryMemoryStore();
  const reads = { n: 0 };
  const countingStore = Object.create(store, {
    read: {
      value: (...a: Parameters<InMemoryMemoryStore["read"]>) => {
        reads.n++;
        return store.read(...a);
      },
    },
  }) as InMemoryMemoryStore;
  const memory = new TieredMemory({
    store: countingStore,
    tiers: { working: { maxEntries: 100 } },
  });
  const requests: LlmRequest[] = [];
  const provider: LlmProvider = {
    async complete(r) {
      requests.push(r);
      const turn = r.messages.filter((m) => m.role === "assistant").length;
      return o.park === true && turn === 0
        ? {
            content: "t",
            toolCalls: [{ id: "c0", name: "t0", input: {} }],
            stopReason: "tool_use",
          }
        : { content: "final", stopReason: "end_turn" };
    },
  };
  const broker = new InMemoryGrantBroker({ secret: SECRET, now: () => NOW });
  const mk = (eventStore: InMemoryAsyncEventStore, snapshotStore: InMemoryAsyncSnapshotStore) => {
    const effects = new EffectRuntime([], {
      authorizer: new TaskGrantAuthorizer({
        secret: SECRET,
        base: new GrantTable({ ask: ["model", "memrecall", "t0", "memwrite", "distill"] }),
        now: () => NOW,
      }),
    });
    effects.register("model", createAgentModelEffect(provider));
    effects.register("memrecall", memoryRecallEffect(memory));
    effects.register("t0", new ToolEffect(async () => ({ ok: true })));
    effects.register("memwrite", memoryWriteBackEffect(memory));
    effects.register(
      "distill",
      new ToolEffect(async (i) => {
        distillCalls.push(i);
        return { add: [] };
      })
    );
    const runtime = new WorkflowRuntime({
      eventStore,
      snapshotStore,
      effectRuntime: effects,
      divergence: "fail",
      scopes: true,
    });
    installTaskAuthority(runtime, { source: broker, secret: SECRET, now: () => NOW });
    const config: AgentLoopConfig = {
      definition: agent$({
        id: "a",
        name: "A",
        tools: [],
      }),
      modelToolId: "model",
      maxIterations: 4,
      memory,
      memoryScope: o.scope ?? "user/1",
      ...(o.recall && { recall: { toolId: "memrecall" } }),
      ...(o.distillScope !== undefined && {
        writeBack: { toolId: "memwrite", scope: o.distillScope, distill: { toolId: "distill" } },
      }),
      ...(o.park === true && { needsApproval: () => true }),
    };
    if (o.park === true) {
      config.definition = agent$({
        id: "a",
        name: "A",
        tools: [
          tool$({
            id: "t0",
            name: "t0",
            description: "t0",
            kind: "tool",
            inputSchema: z.object({}).passthrough(),
            outputSchema: z.object({}).passthrough(),
          }),
        ],
      });
    }
    runtime.registerFlow(flowDef, async (ctx) => agentLoop$(ctx, config, { prompt: "go" }));
    return runtime;
  };
  const eventStore = new InMemoryAsyncEventStore();
  const snapshotStore = new InMemoryAsyncSnapshotStore();
  return {
    memory,
    distillCalls,
    reads,
    requests,
    eventStore,
    mk,
    snapshotStore,
    async start(id = "e1") {
      const runtime = mk(eventStore, snapshotStore);
      const g = await broker.mint({
        taskId: `t-${id}`,
        issuedTo: "agent-a",
        effects: ["model", "memrecall", "t0", "memwrite", "distill"],
        leases: {},
        ttlMs: 60_000,
        ...(o.reads !== undefined && { reads: o.reads }),
      });
      const h = await runtime.start(
        flowDef,
        {},
        { executionId: id, principal: { actor: "agent-a", taskGrant: g } }
      );
      return { runtime, h };
    },
  };
}
const seed = (m: TieredMemory, scope = "user/1") =>
  m.remember("working", scope, { id: "m1", role: "user", content: "remembered-thing" });
const seenInPrompt = (rs: LlmRequest[]) => JSON.stringify(rs.map((r) => r.messages));

describe("agentLoop$ recall.toolId (ADR 0150 D8)", () => {
  // kills: a recall effect that does not declare itself a read, or whose resource is not the scope
  it("memoryRecallEffect declares a read whose resource is the recall scope", () => {
    const e = memoryRecallEffect(boot({ recall: true }).memory);
    expect(e.capabilities).toEqual({ read: true });
    expect(e.resourceOf?.({ tier: "working", scope: "user/1" })).toBe("user/1");
  });

  // kills: an authorizer that ignores `reads`, or a recall that bypasses the effect ring
  it("a recall covered by reads runs and reaches the prompt", async () => {
    const b = boot({ recall: true, reads: ["memrecall:user/*"] });
    await seed(b.memory);
    const { h } = await b.start();
    expect((await h.waitForCompletion()).status).toBe("completed");
    expect(seenInPrompt(b.requests)).toContain("remembered-thing");
  });

  // kills: always routing through the effect (changes the log of every existing agent), or dropping the decide record
  it("unset: the recall is the inline decision, no effect step, and works without any grant `reads`", async () => {
    const b = boot({ recall: false });
    await seed(b.memory);
    const { h } = await b.start();
    expect((await h.waitForCompletion()).status).toBe("completed");
    const events = await b.eventStore.read("e1");
    const recallDecision = (e: { eventType: string; payload: unknown }) =>
      e.eventType === "DECISION_RECORDED" && JSON.stringify(e.payload).includes("#recall");
    const recallStep = (e: { eventType: string; payload: unknown }) =>
      e.eventType === "STEP_STARTED" && JSON.stringify(e.payload).includes("a#recall");
    // exactly today's shape: a recorded decision, then the first model turn (no recall step, no effect)
    expect(events.slice(1, 3).map((e) => e.eventType)).toEqual([
      "DECISION_RECORDED",
      "STEP_STARTED",
    ]);
    expect(events.some(recallDecision)).toBe(true);
    expect(events.some(recallStep)).toBe(false);
    const set = boot({ recall: true, reads: ["memrecall:user/*"] });
    await seed(set.memory);
    const s = await set.start();
    await s.h.waitForCompletion();
    const setEvents = await set.eventStore.read("e1");
    expect(setEvents.some(recallDecision)).toBe(false);
    expect(setEvents.some(recallStep)).toBe(true);
  });

  // kills: a recall effect that is not journaled (replay would read the store again)
  it("a replay serves the recorded recall: no second store read", async () => {
    const b = boot({ recall: true, park: true, reads: ["memrecall:user/*"] });
    await seed(b.memory);
    const { runtime, h } = await b.start();
    await h.waitForSuspend();
    const before = b.reads.n;
    const parked = (await runtime.loadState("e1"))!;
    const second = b.mk(b.eventStore, b.snapshotStore);
    const resumed = await second.resume("e1", answerApproval(parked, { approved: true }));
    expect((await resumed.waitForCompletion()).status).toBe("completed");
    expect(b.reads.n).toBe(before);
    expect(seenInPrompt(b.requests)).toContain("remembered-thing");
  });

  // kills: a distill existing-facts read that stays inline (unauthorized) even with recall.toolId set (R23 I1)
  it("with recall.toolId the distill existing-facts read is the recall EFFECT on the write-back scope", async () => {
    const b = boot({ recall: true, reads: ["memrecall:user/*"], distillScope: "user/2" });
    await seed(b.memory);
    await seed(b.memory, "user/2");
    const { h } = await b.start();
    expect((await h.waitForCompletion()).status).toBe("completed");
    const events = await b.eventStore.read("e1");
    const existing = events.filter(
      (e) =>
        e.eventType === "STEP_STARTED" && JSON.stringify(e.payload).includes("writeback:existing")
    );
    expect(existing).toHaveLength(1);
    expect(JSON.stringify(existing[0]?.payload)).toContain('"scope":"user/2"');
    expect(
      events.some(
        (e) =>
          e.eventType === "DECISION_RECORDED" &&
          JSON.stringify(e.payload).includes("writeback:existing")
      )
    ).toBe(false);
    expect(b.distillCalls).toHaveLength(1);
  });

  // kills: changing the recall-unset distill path (it stays the recorded decision)
  it("recall unset: the distill existing-facts read is still the recorded decision", async () => {
    const b = boot({ recall: false, distillScope: "user/2" });
    const { h } = await b.start();
    await h.waitForCompletion();
    const events = await b.eventStore.read("e1");
    expect(
      events.some(
        (e) =>
          e.eventType === "DECISION_RECORDED" &&
          JSON.stringify(e.payload).includes("writeback:existing")
      )
    ).toBe(true);
  });

  // kills: requireEffectRing allowing an inline recall; recall.toolId accepted with no memory
  it("requireEffectRing refuses `memory` without recall.toolId; recall.toolId without memory is a config error", async () => {
    const run = async (extra: Partial<AgentLoopConfig>) => {
      const b = boot({ recall: true });
      const effects = new EffectRuntime([]);
      effects.register(
        "model",
        createAgentModelEffect({ complete: async () => ({ content: "x", stopReason: "end_turn" }) })
      );
      const runtime = new WorkflowRuntime({
        eventStore: b.eventStore,
        snapshotStore: b.snapshotStore,
        effectRuntime: effects,
      });
      runtime.registerFlow(flowDef, async (ctx) =>
        agentLoop$(ctx, { definition: agent, modelToolId: "model", ...extra }, { prompt: "go" })
      );
      const h = await runtime.start(flowDef, {}, { executionId: "x" });
      return h.waitForCompletion().then(
        (s) => s.status,
        (e: Error) => e.message
      );
    };
    const mem = boot({ recall: false }).memory;
    expect(String(await run({ memory: mem, requireEffectRing: true }))).toMatch(/recall\.toolId/);
    expect(String(await run({ recall: { toolId: "memrecall" } }))).toMatch(/requires `memory`/);
    expect(
      await run({ memory: mem, recall: { toolId: "memrecall" }, requireEffectRing: true })
    ).not.toMatch(/recall\.toolId/);
  });
});
