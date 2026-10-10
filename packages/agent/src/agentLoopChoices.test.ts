import type { FlowDefinition } from "@loom/core";
import { agent$, instructions$, skill$, tool$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";
import { TieredMemory } from "@loom/memory";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SkillRegistry } from "./SkillRegistry";
import type { SkillSelector } from "./SkillSelector";
import { agentLoop$ } from "./agentLoop$";
import { createAgentModelEffect } from "./createAgentModelEffect";

// ── The loop's CHOICES go through the decision seam ──────────────────────────
//
// R1 gave the loop a body that can reach `ctx.decide`; nothing in it used the
// seam. Two things in an agent turn are choices in exactly the sense P9 means —
// they change what the model is asked, and they are not derivable from the log:
//
//   • WHICH SKILLS are relevant. `llmSkillSelector`'s own comment recorded the
//     hole: "the LLM decision is not recorded". Replay re-ran the selector, so a
//     model-driven selection could reconstruct a DIFFERENT prompt than the one
//     the run actually used.
//   • WHAT MEMORY is recalled. A store that changed between the run and the
//     replay silently changes the prompt too.
//
// Recorded through `ctx.decide`, both are served from the log on replay: the
// decider is never called again, so the reconstructed prompt is the one that ran.

const lookup = tool$({
  id: "lookup",
  name: "Lookup",
  description: "Looks up",
  kind: "tool",
  inputSchema: z.object({}),
  outputSchema: z.object({}),
});

const sqlSkill = skill$({
  id: "sql",
  name: "SQL",
  description: "writing SQL",
  instructions: instructions$("Prefer CTEs."),
});

const answering: LlmResponse = { content: "answered", stopReason: "end_turn" };

function boot(opts: {
  selector?: SkillSelector;
  memory?: TieredMemory;
  eventStore?: InMemoryAsyncEventStore;
}) {
  const seen: LlmRequest[] = [];
  const provider: LlmProvider = {
    async complete(request) {
      seen.push(request);
      return answering;
    },
  };
  const effects = new EffectRuntime();
  effects.register("model", createAgentModelEffect(provider));
  effects.register("lookup", new ToolEffect(async () => ({})));

  const runtime = new WorkflowRuntime({
    eventStore: opts.eventStore ?? new InMemoryAsyncEventStore(),
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
        systemPrompt: "be terse",
        ...(opts.selector !== undefined && {
          skills: new SkillRegistry().register(sqlSkill),
          skillSelector: opts.selector,
        }),
        ...(opts.memory !== undefined && { memory: opts.memory, recallLimit: 2 }),
      },
      { prompt: "how many users?" }
    );
    return { content: out.content };
  };
  runtime.registerFlow(flowDef, runner as FlowRunner<unknown, unknown>);
  return { runtime, flowDef, seen };
}

/** A selector whose answer CHANGES between calls — a stand-in for a model. */
function driftingSelector(): SkillSelector {
  let call = 0;
  return {
    async select() {
      return call++ === 0 ? ["sql"] : [];
    },
  };
}

describe("the loop records its choices (P9)", () => {
  it("records the selected skills, and serves them on replay", async () => {
    const store = new InMemoryAsyncEventStore();
    const first = boot({ selector: driftingSelector(), eventStore: store });
    const handle = await first.runtime.start(first.flowDef, {}, { executionId: "x1" });
    await handle.waitForCompletion();

    // Turn 1 was asked WITH the skill's instructions.
    expect(first.seen[0]?.system).toContain("Prefer CTEs.");

    const decisions = (await store.read("x1")).filter((e) => e.eventType === "DECISION_RECORDED");
    expect(decisions.length).toBeGreaterThan(0);
    expect(JSON.stringify(decisions)).toContain("sql");
  });

  it("a replayed run reconstructs the prompt that actually ran", async () => {
    // The drifting selector would return [] the second time. Without the seam,
    // replay would rebuild a prompt with NO skill instructions — a different
    // prompt than the one whose answer is in the log.
    const store = new InMemoryAsyncEventStore();
    const first = boot({ selector: driftingSelector(), eventStore: store });
    const handle = await first.runtime.start(first.flowDef, {}, { executionId: "x1" });
    await handle.waitForCompletion();

    const events = await store.read("x1");
    const prefix = events.slice(0, 2); // EXECUTION_STARTED + the skills decision
    const replayStore = new InMemoryAsyncEventStore();
    for (const e of prefix) await replayStore.append(e);

    const second = boot({ selector: driftingSelector(), eventStore: replayStore });
    const folded = await second.runtime.loadState("x1");
    if (folded === null) throw new Error("no state to recover");
    const resumed = await second.runtime.restoreFromState(folded);
    await resumed.waitForCompletion();

    // Served from the log, not re-selected: the skill is still there.
    expect(second.seen[0]?.system).toContain("Prefer CTEs.");
  });

  it("recalls memory through the seam, bounded by recallLimit", async () => {
    const memory = new TieredMemory({ tiers: { working: {} } });
    for (const n of ["one", "two", "three"]) {
      await memory.remember("working", "x1", { role: "user", content: n });
    }
    const { runtime, flowDef, seen } = boot({ memory });
    const handle = await runtime.start(flowDef, {}, { executionId: "x1" });
    await handle.waitForCompletion();

    const contents = (seen[0]?.messages ?? []).map((m) => m.content).join("|");
    // The newest two, not all three: conversation length is a cost curve now,
    // not a hard wall.
    expect(contents).not.toContain("one");
    expect(contents).toContain("two");
    expect(contents).toContain("three");
  });

  it("is unchanged when neither is configured (G2)", async () => {
    const { runtime, flowDef, seen } = boot({});
    const handle = await runtime.start(flowDef, {}, { executionId: "x1" });
    await handle.waitForCompletion();
    expect(seen[0]?.system).toBe("be terse");
    expect(seen[0]?.messages).toHaveLength(1);
  });
});
