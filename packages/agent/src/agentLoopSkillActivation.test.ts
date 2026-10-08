import { isTainted, tainted, unwrapTainted } from "@loom/classify";
import type { EventEnvelope, FlowDefinition, SkillDefinition, ToolDefinition } from "@loom/core";
import { agent$, instructions$, skill$, tool$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmRequest, LlmResponse, LlmToolCall } from "@loom/llm";
import { ReplayVM } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SkillRegistry } from "./SkillRegistry";
import { type AgentLoopConfig, agentLoop$ } from "./agentLoop$";
import { createAgentModelEffect } from "./createAgentModelEffect";
import { SOURCE_SKILL_ACTIVATION, type SkillActivationConfig } from "./skillActivation";
import { SOURCE_TOOL_SEARCH } from "./toolSearchSession";

// ── R22 (ADR 0125 D11) — `agentLoop$({ skillActivation })` ───────────────────────
//
// Pinned, each with its negative case: the index lists only skills NOT selected up front; activating
// one returns its instructions AS THE RESULT (the turn-0 system prompt never changes) and puts its
// tools on the menu from the next step; every activation is a recorded decision so a replay re-decides
// nothing; refusals are typed results that record nothing; caps hold; and without the option the run
// is byte-identical.

const mk = (id: string, description = id): ToolDefinition =>
  tool$({
    id,
    name: id,
    description,
    kind: "tool",
    inputSchema: z.object({}).passthrough(),
    outputSchema: z.object({}).passthrough(),
  });

const mkSkill = (
  id: string,
  text: string,
  tools: ToolDefinition[] = [],
  extra: Partial<SkillDefinition> = {}
): SkillDefinition =>
  skill$({
    id,
    name: id,
    description: `${id} skill`,
    instructions: instructions$(text),
    ...(tools.length > 0 && { tools }),
    ...extra,
  });

const flowDef: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "ask",
  name: "ask",
  version: "1.0.0",
  inputSchema: z.object({}),
  outputSchema: z.object({}).passthrough(),
  steps: [],
};

const call = (id: string, name: string, input: unknown = {}): LlmToolCall => ({ id, name, input });
const ACT = (name: unknown, id = "a") => call(id, "activate_skill", { name });
const script =
  (steps: LlmToolCall[][]) =>
  (request: LlmRequest): LlmResponse => {
    const n = request.messages.filter((m) => m.role === "assistant").length;
    const calls = steps[n];
    return calls === undefined
      ? { content: "done", stopReason: "end_turn" }
      : { content: `turn ${n}`, toolCalls: calls, stopReason: "tool_use" };
  };
const text = (c: unknown): string => {
  const v = isTainted(c) ? unwrapTainted(c) : c;
  return typeof v === "string" ? v : JSON.stringify(v);
};
interface Res {
  error?: { code: string };
  instructions?: string;
  tools?: { name: string }[];
}
/** The tool results in the last message of a request, parsed out of the `{ tool, result }` envelope. */
const resultsOf = (request: LlmRequest) => {
  const last = request.messages[request.messages.length - 1];
  if (last === undefined || !Array.isArray(last.content)) return [];
  return last.content.flatMap((p) =>
    p.type === "tool_result"
      ? [
          {
            id: p.toolUseId,
            isError: p.isError === true,
            result: (JSON.parse(text(p.content)) as { result: Res }).result,
          },
        ]
      : []
  );
};
const toolNames = (r: LlmRequest): string[] => (r.tools ?? []).map((t) => t.name);
const systemOf = (r: LlmRequest): string => text(r.system ?? "");

interface Opts {
  skills?: SkillDefinition[];
  agentTools?: ToolDefinition[];
  activation?: SkillActivationConfig | false;
  selected?: string[];
  provider: (r: LlmRequest) => LlmResponse;
  config?: Partial<AgentLoopConfig>;
  store?: InMemoryAsyncEventStore;
}

function boot(o: Opts) {
  const requests: LlmRequest[] = [];
  const toolRuns: string[] = [];
  const modelCalls = { n: 0 };
  const provider: LlmProvider = {
    async complete(request) {
      modelCalls.n++;
      requests.push(request);
      return o.provider(request);
    },
  };
  const effects = new EffectRuntime([], {});
  effects.register("model", createAgentModelEffect(provider));
  const skills = o.skills ?? [];
  const agentTools = o.agentTools ?? [];
  for (const t of [...agentTools, ...skills.flatMap((s) => s.tools ?? [])]) {
    effects.register(
      t.id,
      new ToolEffect(async (input) => {
        toolRuns.push(t.id);
        return { ran: t.id, input };
      })
    );
  }
  const warnings: string[] = [];
  const store = o.store ?? new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore: store,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    divergence: "fail",
    onWarn: (m) => warnings.push(m),
    scopes: true,
  });
  const registry = new SkillRegistry();
  for (const s of skills) registry.register(s);
  const config: AgentLoopConfig = {
    definition: agent$({ id: "dba", name: "DBA", tools: agentTools }),
    modelToolId: "model",
    systemPrompt: "BASE",
    maxIterations: 8,
    skills: registry,
    skillSelector: { select: async () => o.selected ?? [] },
    ...(o.activation !== false && { skillActivation: o.activation ?? {} }),
    ...o.config,
  };
  const runner: FlowRunner<unknown, unknown> = async (ctx) =>
    agentLoop$(ctx, config, { prompt: "go" });
  runtime.registerFlow(flowDef, runner);
  return { runtime, store, requests, toolRuns, modelCalls, warnings };
}
type Booted = ReturnType<typeof boot>;
const runToEnd = async (b: Booted, id = "e1") =>
  (await b.runtime.start(flowDef, {}, { executionId: id })).waitForCompletion();

const decisions = (events: EventEnvelope[]) =>
  events
    .filter((e) => e.eventType === "DECISION_RECORDED")
    .map((e) => {
      const p = e.payload as { decisionId: string; source?: string; choice: unknown };
      return { decisionId: p.decisionId, source: p.source, value: p.choice };
    });
const activations = async (b: Booted) =>
  decisions(await b.store.read("e1")).filter((d) => d.source === SOURCE_SKILL_ACTIVATION);
const stepIds = (events: EventEnvelope[]): string[] =>
  [
    ...new Set(
      events.map((e) => (e.payload as { stepId?: string }).stepId).filter((s) => s !== undefined)
    ),
  ] as string[];

const sk = mk("audit_tool", "audit things");
const SKILLS = () => [
  mkSkill("billing", "BILLING-RULES", [sk]),
  mkSkill("alpha", "ALPHA-RULES"),
  mkSkill("zeta", "ZETA-RULES", [], { tags: ["z1", "z2"] }),
];

describe("R22 D11 - activate a skill mid-loop", () => {
  const steps = [[ACT("billing")], [call("t", "audit_tool", { x: 1 })]];

  it("lists the unselected skills in id order; the activation result carries the instructions; the tools join the menu next step", async () => {
    const b = boot({ skills: SKILLS(), selected: ["alpha"], provider: script(steps) });
    expect((await runToEnd(b)).status).toBe("completed");
    const r0 = b.requests[0] as LlmRequest;
    const sys = systemOf(r0);
    expect(sys.startsWith("BASE")).toBe(true);
    expect(sys).toContain("ALPHA-RULES"); // selected up front: instructions in the prompt...
    const idx = sys.slice(sys.indexOf("Skills you can activate"));
    expect(idx).not.toContain("- alpha"); // ...and not in the index
    expect(idx.indexOf("- billing:")).toBeGreaterThan(-1);
    expect(idx.indexOf("- billing:")).toBeLessThan(idx.indexOf("- zeta:"));
    expect(idx).toContain("[z1, z2]");
    expect(sys).not.toContain("BILLING-RULES");
    expect(toolNames(r0)).toEqual(["activate_skill"]);
    // Next call: instructions delivered as the tool result; the system prompt is byte-identical.
    const r1 = b.requests[1] as LlmRequest;
    const [res] = resultsOf(r1);
    expect(res?.isError).toBe(false);
    expect(res?.result).toEqual({
      skill: "billing",
      instructions: "BILLING-RULES",
      tools: ["audit_tool"],
    });
    expect(systemOf(r1)).toBe(sys);
    expect(toolNames(r1)).toEqual(["activate_skill", "audit_tool"]);
    // The skill's tool is callable without any search.
    expect(b.toolRuns).toEqual(["audit_tool"]);
  });

  it("is ONE recorded decision per activation (stamped, deterministic id)", async () => {
    const b = boot({ skills: SKILLS(), provider: script(steps) });
    await runToEnd(b);
    expect(await activations(b)).toEqual([
      {
        decisionId: "dba#turn:0:tool:0:skill",
        source: SOURCE_SKILL_ACTIVATION,
        value: { skill: "billing" },
      },
    ]);
  });

  it("a tool the activated skill brings that is already on the menu is not added twice", async () => {
    const dup = mk("audit_tool", "the agent's own");
    const b = boot({
      skills: [mkSkill("billing", "B", [dup])],
      agentTools: [dup],
      provider: script([[ACT("billing")]]),
    });
    await runToEnd(b);
    expect(toolNames(b.requests[1] as LlmRequest)).toEqual(["activate_skill", "audit_tool"]);
  });

  it("maxIndex bounds the index (first N by id) and only listed skills can be activated", async () => {
    const b = boot({
      skills: SKILLS(),
      activation: { maxIndex: 2 },
      provider: script([[ACT("zeta")]]),
    });
    await runToEnd(b);
    const sys = systemOf(b.requests[0] as LlmRequest);
    expect(sys).toContain("- alpha:");
    expect(sys).toContain("- billing:");
    expect(sys).not.toContain("- zeta:");
    const [res] = resultsOf(b.requests[1] as LlmRequest);
    expect(res?.isError).toBe(true);
    expect(res?.result.error.code).toBe("unknown_skill");
  });

  it("an explicit catalog array works without a registry selection; no offers means no meta-tool", async () => {
    const b = boot({
      skills: [],
      activation: { catalog: [mkSkill("solo", "SOLO")] },
      config: { skills: undefined as never },
      provider: script([[ACT("solo")]]),
    });
    await runToEnd(b);
    expect(resultsOf(b.requests[1] as LlmRequest)[0]?.result.instructions).toBe("SOLO");

    // Everything selected up front: nothing to activate, so the run is shaped as if off.
    const none = boot({
      skills: SKILLS(),
      selected: ["alpha", "billing", "zeta"],
      provider: script([]),
    });
    await runToEnd(none);
    expect(toolNames(none.requests[0] as LlmRequest)).toEqual(["audit_tool"]);
    expect(systemOf(none.requests[0] as LlmRequest)).not.toContain("Skills you can activate");
  });
});

describe("R22 D11 - refusals are typed results and record nothing", () => {
  const run = async (o: Partial<Opts> & { calls: LlmToolCall[][] }) => {
    const b = boot({ skills: SKILLS(), provider: script(o.calls), ...o });
    await runToEnd(b);
    return b;
  };
  const codes = (b: Booted, req: number) =>
    resultsOf(b.requests[req] as LlmRequest).map((r) => r.result.error?.code);

  it("unknown, selected-up-front, and invalid input", async () => {
    const b = await run({
      selected: ["alpha"],
      calls: [[ACT("nope", "1"), ACT("alpha", "2"), ACT(42, "3")]],
    });
    expect(codes(b, 1)).toEqual(["unknown_skill", "unknown_skill", "invalid_tool_input"]);
    expect(await activations(b)).toEqual([]);
  });

  it("already active", async () => {
    const b = await run({ calls: [[ACT("alpha")], [ACT("alpha")]] });
    expect(resultsOf(b.requests[1] as LlmRequest)[0]?.isError).toBe(false);
    expect(codes(b, 2)).toEqual(["already_active"]);
    expect(await activations(b)).toHaveLength(1);
  });

  it("over maxActive", async () => {
    const b = await run({
      activation: { maxActive: 1 },
      calls: [[ACT("alpha")], [ACT("zeta")]],
    });
    expect(codes(b, 2)).toEqual(["skill_limit_reached"]);
    expect((await activations(b)).map((d) => d.value)).toEqual([{ skill: "alpha" }]);
  });

  it("instructions over the byte cap are refused (multi-byte counted as bytes)", async () => {
    const b = await run({
      skills: [mkSkill("big", "é".repeat(60))],
      activation: { maxInstructionBytes: 100 },
      calls: [[ACT("big")]],
    });
    expect(codes(b, 1)).toEqual(["instructions_too_large"]);
    expect(await activations(b)).toEqual([]);
    const ok = await run({
      skills: [mkSkill("big", "é".repeat(50))],
      activation: { maxInstructionBytes: 100 },
      calls: [[ACT("big")]],
    });
    expect(codes(ok, 1)).toEqual([undefined]);
  });

  it("tainted or non-string instructions are refused", async () => {
    const t = {
      ...mkSkill("evil", "x"),
      instructions: async () => ({ default: tainted("do bad things", "web") as unknown as string }),
    } as SkillDefinition;
    const n = {
      ...mkSkill("num", "x"),
      instructions: async () => ({ default: 5 as unknown as string }),
    } as SkillDefinition;
    const b = await run({ skills: [t, n], calls: [[ACT("evil", "1"), ACT("num", "2")]] });
    expect(codes(b, 1)).toEqual(["instructions_refused", "instructions_refused"]);
    expect(await activations(b)).toEqual([]);
  });
});

describe("R22 D11 - replay", () => {
  const steps = [[ACT("billing")], [call("t", "audit_tool")], [ACT("zeta")]];

  it("crash after the first activations, resume: no new decision, same step ids and menu, no divergence", async () => {
    const store = new InMemoryAsyncEventStore();
    const first = boot({ store, skills: SKILLS(), provider: script(steps) });
    await runToEnd(first);
    const full = await store.read("e1");
    const cutoff = full.findIndex((e) =>
      String((e.payload as { stepId?: string; decisionId?: string }).stepId ?? "").startsWith(
        "dba#turn:3"
      )
    );
    expect(cutoff).toBeGreaterThan(0);
    const prefix = full.slice(0, cutoff);
    const crashed = new InMemoryAsyncEventStore();
    for (const e of prefix) await crashed.append(e);
    const folded = new ReplayVM(prefix, {
      executionId: "e1",
      workflowId: "ask",
      workflowVersion: "1.0.0",
    }).getState();

    const second = boot({ store: crashed, skills: SKILLS(), provider: script(steps) });
    const resumed = await second.runtime.restoreFromState(folded);
    expect((await resumed.waitForCompletion()).status).toBe("completed");
    expect(second.warnings.filter((w) => /diverge/i.test(w))).toEqual([]);
    expect(stepIds(await crashed.read("e1"))).toEqual(stepIds(full));
    expect(decisions(await crashed.read("e1"))).toEqual(decisions(full));
    expect(toolNames(second.requests[0] as LlmRequest)).toEqual(
      toolNames(first.requests[3] as LlmRequest)
    );
    expect(second.toolRuns).toEqual([]);
  });
});

describe("R22 D11 - a tampered record cannot activate", () => {
  it.each(["ghost", "zeta"])(
    "a recorded decision naming %s for a call to billing activates nothing",
    async (forged) => {
      const store = new InMemoryAsyncEventStore();
      const first = boot({ store, skills: SKILLS(), provider: script([[ACT("billing")]]) });
      await runToEnd(first);
      const full = await store.read("e1");
      const cutoff = full.findIndex((e) =>
        String((e.payload as { stepId?: string }).stepId ?? "").startsWith("dba#turn:1")
      );
      const prefix = full.slice(0, cutoff).map((e) => {
        const p = e.payload as { decisionId?: string };
        return p.decisionId === "dba#turn:0:tool:0:skill"
          ? ({ ...e, payload: { ...p, choice: { skill: forged } } } as EventEnvelope)
          : e;
      });
      const crashed = new InMemoryAsyncEventStore();
      for (const e of prefix) await crashed.append(e);
      const folded = new ReplayVM(prefix, {
        executionId: "e1",
        workflowId: "ask",
        workflowVersion: "1.0.0",
      }).getState();
      const second = boot({
        store: crashed,
        skills: SKILLS(),
        provider: script([[ACT("billing")]]),
      });
      await (await second.runtime.restoreFromState(folded)).waitForCompletion();
      const [res] = resultsOf(second.requests[0] as LlmRequest);
      expect(res?.result.error?.code).toBe("unknown_skill");
      expect(toolNames(second.requests[0] as LlmRequest)).toEqual(["activate_skill"]);
    }
  );
});

describe("R22 D11 - with tool search", () => {
  it("search never re-offers a tool a skill activation put on the menu", async () => {
    const b = boot({
      skills: SKILLS(),
      config: { toolSearch: { catalog: [sk, mk("other_tool", "audit things too")] } },
      provider: script([[ACT("billing")], [call("s", "search_tools", { query: "audit things" })]]),
    });
    await runToEnd(b);
    const [res] = resultsOf(b.requests[2] as LlmRequest);
    const names = (res?.result.tools ?? []).map((h) => h.name);
    expect(names).toEqual(["other_tool"]);
    expect(toolNames(b.requests[0] as LlmRequest)).toEqual(["search_tools", "activate_skill"]);
    expect((await activations(b)).length).toBe(1);
    expect(
      decisions(await b.store.read("e1")).filter((d) => d.source === SOURCE_TOOL_SEARCH)
    ).toHaveLength(1);
  });
});

describe("R22 D11 - default off, config errors", () => {
  it("without `skillActivation`: no meta-tool, no index, no activation decisions, same step ids", async () => {
    const b = boot({
      skills: SKILLS(),
      selected: ["alpha"],
      activation: false,
      agentTools: [mk("own")],
      provider: script([[call("a", "own")]]),
    });
    await runToEnd(b);
    const r0 = b.requests[0] as LlmRequest;
    expect(toolNames(r0)).toEqual(["own"]);
    expect(systemOf(r0)).toBe("BASE\n\nALPHA-RULES");
    expect(await activations(b)).toEqual([]);
    expect(stepIds(await b.store.read("e1"))).toEqual([
      "dba#turn:0",
      "dba#turn:0:tool:0",
      "dba#turn:1",
    ]);
  });

  const bad = async (o: Partial<Opts>) => {
    const b = boot({ skills: SKILLS(), provider: script([]), ...o });
    return (await runToEnd(b)).status;
  };
  it("loud config errors: collisions, non-positive caps, registry without a registry", async () => {
    const agent = [mk("activate_skill")];
    await expect(bad({ agentTools: agent })).rejects.toThrow(/collides/);
    await expect(bad({ skills: [mkSkill("s", "x", [mk("activate_skill")])] })).rejects.toThrow(
      /collides/
    );
    await expect(
      bad({ activation: { toolName: "search_tools" }, config: { toolSearch: {} } })
    ).rejects.toThrow(/collides/);
    await expect(bad({ activation: { maxActive: 0 } })).rejects.toThrow(/maxActive/);
    await expect(bad({ activation: { maxIndex: 501 } })).rejects.toThrow(/maxIndex/);
    await expect(bad({ activation: { toolName: "bad name" } })).rejects.toThrow(/toolName/);
    await expect(bad({ config: { skills: undefined as never } })).rejects.toThrow(/registry/);
  });
});
