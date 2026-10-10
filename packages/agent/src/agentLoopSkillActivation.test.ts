import { createHash } from "node:crypto";
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
import { describe, expect, it, vi } from "vitest";
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

const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

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
  /** Awaited inside every registered tool's effect (to observe concurrency). */
  onRun?: (id: string) => Promise<void>;
  /** Registers a `summarize` effect (for a `compaction: { toolId: "summarize" }` config). */
  summarizer?: true;
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
        await o.onRun?.(t.id);
        return { ran: t.id, input };
      })
    );
  }
  if (o.summarizer === true) {
    effects.register("summarize", new ToolEffect(async () => ({ summary: "folded" })));
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
        value: {
          skill: "billing",
          digest: sha("BILLING-RULES"),
          bytes: 15,
          resultBytes: expect.any(Number),
        },
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

describe("R22 D11 - refusals are typed results (an instructions refusal records its verdict, the rest record nothing)", () => {
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

  it("already active re-delivers the instructions (P3-6): nothing recorded, no tools, not counted", async () => {
    const b = await run({
      skills: SKILLS(),
      activation: { maxActive: 1 },
      calls: [[ACT("billing")], [ACT("billing")], [ACT("billing")]],
    });
    const again = resultsOf(b.requests[2] as LlmRequest)[0];
    expect(again?.isError).toBe(false);
    expect(again?.result.instructions).toBe("BILLING-RULES");
    expect(again?.result.tools).toBeUndefined();
    // Repeated with maxActive 1: re-delivery never trips skill_limit_reached.
    expect(resultsOf(b.requests[3] as LlmRequest)[0]?.result.instructions).toBe("BILLING-RULES");
    expect(await activations(b)).toHaveLength(1);
    expect(toolNames(b.requests[3] as LlmRequest)).toEqual(["activate_skill", "audit_tool"]);
  });

  it("over maxActive", async () => {
    const b = await run({
      activation: { maxActive: 1 },
      calls: [[ACT("alpha")], [ACT("zeta")]],
    });
    expect(codes(b, 2)).toEqual(["skill_limit_reached"]);
    expect((await activations(b)).map((d) => d.value)).toEqual([
      { skill: "alpha", digest: sha("ALPHA-RULES"), bytes: 13, resultBytes: expect.any(Number) },
    ]);
  });

  it("instructions over the byte cap are refused (multi-byte counted as bytes)", async () => {
    const b = await run({
      skills: [mkSkill("big", "é".repeat(60))],
      activation: { maxInstructionBytes: 100 },
      calls: [[ACT("big")]],
    });
    expect(codes(b, 1)).toEqual(["instructions_too_large"]);
    expect((await activations(b)).map((d) => d.value)).toEqual([
      { skill: "big", refused: "instructions_too_large" },
    ]);
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
    expect((await activations(b)).map((d) => d.value)).toEqual([
      { skill: "evil", refused: "instructions_refused" },
      { skill: "num", refused: "instructions_refused" },
    ]);
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

// ═══ Review round 1 ═══════════════════════════════════════════════════════════════════════════

/** In-flight tracker: `peak` is the highest number of tool effects running at once. */
const concurrency = () => {
  const c = { inFlight: 0, peak: 0 };
  const onRun = async (): Promise<void> => {
    c.inFlight++;
    c.peak = Math.max(c.peak, c.inFlight);
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    c.inFlight--;
  };
  return { c, onRun };
};

describe("R22 review P2-1 - a human tool the settle phase brings keeps the turn sequential", () => {
  const human = tool$({
    id: "ask_human",
    name: "ask_human",
    description: "ask a person",
    kind: "human",
    inputSchema: z.object({}).passthrough(),
    outputSchema: z.object({}).passthrough(),
  });
  const turn = [ACT("rev", "a"), call("b", "t0"), call("c", "ask_human"), call("d", "t2")];

  it("skill path: [activate_skill, t0, ask_human, t2] never overlaps", async () => {
    const { c, onRun } = concurrency();
    const b = boot({
      skills: [mkSkill("rev", "REV", [human])],
      agentTools: [mk("t0"), mk("t2")],
      config: { parallelTools: true },
      onRun,
      provider: script([turn]),
    });
    expect((await runToEnd(b)).status).toBe("completed");
    expect(b.toolRuns).toEqual(["t0", "ask_human", "t2"]); // call order
    expect(c.peak).toBe(1);
  });

  it("NEGATIVE: the same turn WITHOUT a human tool still runs in parallel", async () => {
    const { c, onRun } = concurrency();
    const b = boot({
      skills: [mkSkill("rev", "REV", [mk("plain")])],
      agentTools: [mk("t0"), mk("t2")],
      config: { parallelTools: true },
      onRun,
      provider: script([[ACT("rev", "a"), call("b", "t0"), call("c", "plain"), call("d", "t2")]]),
    });
    await runToEnd(b);
    expect(c.peak).toBe(3);
  });
});

describe("R22 review P3-2 - the search meta-tool's name against offered skills' tools", () => {
  it("a skill bringing a tool named like the search meta-tool is a config error", async () => {
    const b = boot({
      skills: [mkSkill("s", "x", [mk("search_tools")])],
      config: { toolSearch: {} },
      provider: script([]),
    });
    await expect(runToEnd(b)).rejects.toThrow(/search_tools.*collides|collides/);
  });
  it("NEGATIVE: no collision, no error", async () => {
    const b = boot({
      skills: [mkSkill("s", "x", [mk("other")])],
      config: { toolSearch: {} },
      provider: script([]),
    });
    expect((await runToEnd(b)).status).toBe("completed");
  });
});

describe("R22 review P3-3 - the index is byte-bounded and one line per skill", () => {
  const indexOf = (b: Booted) => {
    const sys = systemOf(b.requests[0] as LlmRequest);
    return sys.slice(sys.indexOf("Skills you can activate"));
  };

  it("caps id and tag characters; an id that cannot be shown whole on one line is not offered", async () => {
    const longId = "x".repeat(65);
    const b = boot({
      skills: [
        mkSkill("ok", "fine", [], { tags: ["t".repeat(100), "a\u2028b\rc"] }),
        mkSkill(longId, "too long"),
        mkSkill("bad\nid", "newline id"),
      ],
      provider: script([[ACT(longId, "1"), ACT("bad\nid", "2")]]),
    });
    await runToEnd(b);
    const idx = indexOf(b);
    expect(idx).not.toContain(longId);
    expect(idx).not.toContain("bad");
    const line = idx.split("\n").find((l) => l.startsWith("- ok:")) as string;
    expect(line).toContain(`[${"t".repeat(32)}…, a`);
    expect(idx).not.toMatch(/[\r\u2028\u2029]/);
    expect(resultsOf(b.requests[1] as LlmRequest).map((r) => r.result.error?.code)).toEqual([
      "unknown_skill",
      "unknown_skill",
    ]);
  });

  it("every line separator ends a description's first line", async () => {
    const b = boot({
      skills: [
        mkSkill("a", "x", [], { description: "first\u2028INJECTED" }),
        mkSkill("b", "x", [], { description: "first\rINJECTED" }),
        mkSkill("c", "x", [], { description: "first\u2029INJECTED" }),
      ],
      provider: script([]),
    });
    await runToEnd(b);
    expect(indexOf(b)).not.toContain("INJECTED");
  });

  it("a total byte cap truncates deterministically with a +N more marker; skills past it cannot be activated", async () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      mkSkill(`skill_${String(i).padStart(3, "0")}`, "x", [], { description: "d".repeat(190) })
    );
    const mkRun = () =>
      boot({
        skills: many,
        activation: { maxIndex: 500, maxIndexBytes: 4096 },
        provider: script([[ACT("skill_399")]]),
      });
    const a = mkRun();
    await runToEnd(a);
    const idx = indexOf(a);
    expect(new TextEncoder().encode(idx).length).toBeLessThanOrEqual(4096);
    expect(idx).toMatch(/\(\+\d+ more skills not listed\)/);
    expect(idx).toContain("- skill_000:");
    expect(idx).not.toContain("- skill_399:");
    expect(resultsOf(a.requests[1] as LlmRequest)[0]?.result.error?.code).toBe("unknown_skill");
    const b = mkRun();
    await runToEnd(b);
    expect(indexOf(b)).toBe(idx); // deterministic
  });

  it("the default cap holds for a pathological registry (105 KB before)", async () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      mkSkill(`${"s".repeat(40)}${i}`, "x", [], {
        description: "d".repeat(500),
        tags: Array.from({ length: 20 }, () => "g".repeat(200)),
      })
    );
    const b = boot({ skills: many, activation: { maxIndex: 500 }, provider: script([]) });
    await runToEnd(b);
    expect(new TextEncoder().encode(indexOf(b)).length).toBeLessThanOrEqual(8 * 1024);
  });

  it("maxIndexBytes is validated", async () => {
    const b = boot({ skills: SKILLS(), activation: { maxIndexBytes: 0 }, provider: script([]) });
    await expect(runToEnd(b)).rejects.toThrow(/maxIndexBytes/);
  });
});

describe("R22 review P3-4 - a refusal does not echo an unbounded model-supplied name", () => {
  it("unknown_skill caps the echoed name", async () => {
    const huge = "n".repeat(50_000);
    const b = boot({ skills: SKILLS(), provider: script([[ACT(huge)]]) });
    await runToEnd(b);
    const [r] = resultsOf(b.requests[1] as LlmRequest);
    expect(r?.result.error?.code).toBe("unknown_skill");
    expect(JSON.stringify(r?.result).length).toBeLessThan(500);
  });
});

describe("R22 review P3-5 - once a decision is recorded, a replay honours it", () => {
  /** Run `first`, then resume the log cut before turn 1 against a registry holding `second`. */
  async function resume(first: SkillDefinition[], second: SkillDefinition[], max: number) {
    const act: SkillActivationConfig = { maxInstructionBytes: max };
    const steps = [[ACT("rev")]];
    const store = new InMemoryAsyncEventStore();
    const a = boot({ store, skills: first, activation: act, provider: script(steps) });
    await runToEnd(a);
    const full = await store.read("e1");
    const cutoff = full.findIndex((e) =>
      String((e.payload as { stepId?: string }).stepId ?? "").startsWith("dba#turn:1")
    );
    const prefix = full.slice(0, cutoff);
    const crashed = new InMemoryAsyncEventStore();
    for (const e of prefix) await crashed.append(e);
    const folded = new ReplayVM(prefix, {
      executionId: "e1",
      workflowId: "ask",
      workflowVersion: "1.0.0",
    }).getState();
    const b = boot({ store: crashed, skills: second, activation: act, provider: script(steps) });
    const st = await (await b.runtime.restoreFromState(folded)).waitForCompletion();
    expect(st.status).toBe("completed");
    expect(b.warnings.filter((w) => /diverge/i.test(w))).toEqual([]);
    return { b, before: decisions(prefix), after: decisions(await crashed.read("e1")) };
  }
  const tool = mk("rev_tool");

  it("a skill that GREW past the cap after the activation was recorded: the activation stands, the tools join, the instructions are reported unavailable, nothing new is recorded", async () => {
    const { b, before, after } = await resume(
      [mkSkill("rev", "short", [tool])],
      [mkSkill("rev", "x".repeat(500), [tool])],
      100
    );
    expect(after).toEqual(before);
    const [r] = resultsOf(b.requests[0] as LlmRequest);
    expect(r?.isError).toBe(true);
    expect(r?.result.error?.code).toBe("instructions_unavailable");
    expect(toolNames(b.requests[0] as LlmRequest)).toEqual(["activate_skill", "rev_tool"]);
  });

  it("a skill that SHRANK after a recorded refusal: the refusal is reproduced, no new decision, no tools", async () => {
    const { b, before, after } = await resume(
      [mkSkill("rev", "x".repeat(500), [tool])],
      [mkSkill("rev", "short", [tool])],
      100
    );
    expect(before.filter((d) => d.source === SOURCE_SKILL_ACTIVATION).map((d) => d.value)).toEqual([
      { skill: "rev", refused: "instructions_too_large" },
    ]);
    expect(after).toEqual(before);
    const [r] = resultsOf(b.requests[0] as LlmRequest);
    expect(r?.result.error?.code).toBe("instructions_too_large");
    expect(toolNames(b.requests[0] as LlmRequest)).toEqual(["activate_skill"]);
  });

  it("NEGATIVE: an unchanged registry replays the same activation with its instructions", async () => {
    const same = [mkSkill("rev", "short", [tool])];
    const { b, before, after } = await resume(same, same, 100);
    expect(after).toEqual(before);
    expect(resultsOf(b.requests[0] as LlmRequest)[0]?.result.instructions).toBe("short");
  });
});

describe("R22 polish P3-a/b - an unloadable skill is feedback; an index that fits nothing is a config error", () => {
  const failing = (err: unknown): SkillDefinition =>
    ({
      ...mkSkill("flaky", "x"),
      instructions: async () => {
        throw err;
      },
    }) as SkillDefinition;

  it("loadInstructions throwing returns instructions_unavailable and records nothing", async () => {
    const b = boot({
      skills: [failing(new Error("SECRET-io"))],
      provider: script([[ACT("flaky")]]),
    });
    await runToEnd(b);
    const [r] = resultsOf(b.requests[1] as LlmRequest);
    expect(r?.isError).toBe(true);
    expect(r?.result.error?.code).toBe("instructions_unavailable");
    expect(JSON.stringify(r?.result)).not.toContain("SECRET-io");
    expect(await activations(b)).toEqual([]);
  });

  it("a terminal error from loadInstructions still propagates", async () => {
    const quota = Object.assign(new Error("quota"), { name: "QuotaExceededError" });
    const b = boot({ skills: [failing(quota)], provider: script([[ACT("flaky")]]) });
    await expect(runToEnd(b)).rejects.toThrow(/quota/);
  });

  it("maxIndexBytes too small for any skill throws a config error", async () => {
    const b = boot({
      skills: SKILLS(),
      activation: { maxIndexBytes: 100 },
      provider: script([]),
    });
    await expect(runToEnd(b)).rejects.toThrow(/maxIndexBytes/);
  });
});

// ── R22d (ADR 0125 D14) — instructions are pinned by a digest ───────────────────

describe("R22d D14 - the delivered instructions are pinned by a recorded digest", () => {
  const tool = mk("rev_tool");
  /** A skill whose instructions can change under the run (a registry hot-reload). */
  const live = (initial: string, tools: ToolDefinition[] = [tool]) => {
    const box = { text: initial };
    const skill = {
      ...mkSkill("rev", initial, tools),
      instructions: async () => ({ default: box.text }),
    } as SkillDefinition;
    return { box, skill };
  };
  const warnings = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls
      .filter((c) => (c[1] as { code?: string } | undefined)?.code === "LOOM_AGENT_SKILL_CHANGED")
      .map((c) => String(c[0]));

  /** Run `steps` against `first`, cut the log before turn 1, resume against `second`. */
  async function resume(
    first: SkillDefinition,
    second: SkillDefinition,
    mapEvent: (e: EventEnvelope) => EventEnvelope = (e) => e
  ) {
    const steps = [[ACT("rev")]];
    const store = new InMemoryAsyncEventStore();
    await runToEnd(boot({ store, skills: [first], provider: script(steps) }));
    const full = await store.read("e1");
    const cutoff = full.findIndex((e) =>
      String((e.payload as { stepId?: string }).stepId ?? "").startsWith("dba#turn:1")
    );
    const prefix = full.slice(0, cutoff).map(mapEvent);
    const crashed = new InMemoryAsyncEventStore();
    for (const e of prefix) await crashed.append(e);
    const folded = new ReplayVM(prefix, {
      executionId: "e1",
      workflowId: "ask",
      workflowVersion: "1.0.0",
    }).getState();
    const b = boot({ store: crashed, skills: [second], provider: script(steps) });
    const st = await (await b.runtime.restoreFromState(folded)).waitForCompletion();
    expect(st.status).toBe("completed");
    expect(b.warnings.filter((w) => /diverge/i.test(w))).toEqual([]);
    return { b, before: decisions(prefix), after: decisions(await crashed.read("e1")) };
  }

  it("an accepted activation records the sha256 of the text it delivered", async () => {
    const b = boot({
      skills: [mkSkill("rev", "RULES-v1", [tool])],
      provider: script([[ACT("rev")]]),
    });
    await runToEnd(b);
    expect((await activations(b)).map((d) => d.value)).toEqual([
      { skill: "rev", digest: sha("RULES-v1"), bytes: 10, resultBytes: expect.any(Number) },
    ]);
  });

  it("NEGATIVE: a refusal records its verdict only (no digest: nothing was delivered)", async () => {
    const b = boot({
      skills: [mkSkill("rev", "x".repeat(500), [tool])],
      activation: { maxInstructionBytes: 100 },
      provider: script([[ACT("rev")]]),
    });
    await runToEnd(b);
    expect((await activations(b)).map((d) => d.value)).toEqual([
      { skill: "rev", refused: "instructions_too_large" },
    ]);
  });

  it("replay with the SAME text delivers it (digest matches), no warning", async () => {
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const a = live("RULES-v1");
      const { b, before, after } = await resume(a.skill, live("RULES-v1").skill);
      expect(after).toEqual(before);
      expect(resultsOf(b.requests[0] as LlmRequest)[0]?.result.instructions).toBe("RULES-v1");
      expect(warnings(spy)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("replay with CHANGED (still valid) text delivers nothing: instructions_changed, tools stay, nothing recorded, one warning", async () => {
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const { b, before, after } = await resume(live("RULES-v1").skill, live("RULES-v2-NEW").skill);
      expect(after).toEqual(before);
      const [r] = resultsOf(b.requests[0] as LlmRequest);
      expect(r?.isError).toBe(true);
      expect(r?.result.error?.code).toBe("instructions_changed");
      expect(JSON.stringify(r?.result)).not.toContain("RULES-v2-NEW");
      expect(r?.result.tools).toEqual(["rev_tool"]);
      expect(toolNames(b.requests[0] as LlmRequest)).toEqual(["activate_skill", "rev_tool"]);
      expect(warnings(spy)).toHaveLength(1);
      expect(warnings(spy)[0]).toContain("rev");
    } finally {
      spy.mockRestore();
    }
  });

  it("an OLD record (no digest) keeps today's behaviour: the current text is delivered, silently", async () => {
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const strip = (e: EventEnvelope): EventEnvelope => {
        const p = e.payload as { source?: string; choice?: { skill: string } };
        return p.source === SOURCE_SKILL_ACTIVATION
          ? ({
              ...e,
              payload: { ...p, choice: { skill: p.choice?.skill } },
            } as unknown as EventEnvelope)
          : e;
      };
      const { b } = await resume(live("RULES-v1").skill, live("RULES-v2-NEW").skill, strip);
      const [r] = resultsOf(b.requests[0] as LlmRequest);
      expect(r?.isError).toBe(false);
      expect(r?.result.instructions).toBe("RULES-v2-NEW");
      expect(warnings(spy)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("a recorded digest that is not a string is ignored (legacy behaviour), never trusted", async () => {
    const junk = (e: EventEnvelope): EventEnvelope => {
      const p = e.payload as { source?: string; choice?: Record<string, unknown> };
      return p.source === SOURCE_SKILL_ACTIVATION
        ? ({
            ...e,
            payload: { ...p, choice: { ...p.choice, digest: 42 } },
          } as unknown as EventEnvelope)
        : e;
    };
    const { b } = await resume(live("RULES-v1").skill, live("RULES-v2-NEW").skill, junk);
    expect(resultsOf(b.requests[0] as LlmRequest)[0]?.result.instructions).toBe("RULES-v2-NEW");
  });

  it("re-delivering an active skill compares with the digest recorded at activation (live run)", async () => {
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const a = live("RULES-v1");
      let mutated = false;
      const b = boot({
        skills: [a.skill],
        // The registry text changes after the first activation delivered v1.
        provider: (req) => {
          if (!mutated && req.messages.filter((m) => m.role === "assistant").length === 1) {
            a.box.text = "RULES-v2-NEW";
            mutated = true;
          }
          return script([[ACT("rev")], [ACT("rev")]])(req);
        },
      });
      await runToEnd(b);
      const [again] = resultsOf(b.requests[2] as LlmRequest);
      expect(again?.isError).toBe(true);
      expect(again?.result.error?.code).toBe("instructions_changed");
      expect(JSON.stringify(again?.result)).not.toContain("RULES-v2-NEW");
      expect(await activations(b)).toHaveLength(1); // re-delivery still records nothing
      expect(warnings(spy)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("NEGATIVE: re-delivering an active skill whose text is unchanged still returns it, no warning", async () => {
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const b = boot({
        skills: [live("RULES-v1").skill],
        provider: script([[ACT("rev")], [ACT("rev")]]),
      });
      await runToEnd(b);
      const [again] = resultsOf(b.requests[2] as LlmRequest);
      expect(again?.result.instructions).toBe("RULES-v1");
      expect(warnings(spy)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

// ── R22d review round 1 - a replay that shrinks the transcript must not move compaction ────────
//
// The byte trigger is recomputed on replay from the tool-result bytes in the transcript, and the log
// does not pin those bytes. A changed skill text replaces up to 32 KiB of instructions with a short
// error, so a recorded `#turn:t:compact` frame was "not asked for" (a divergence). The activation
// record now carries the delivered size; a replay that cannot deliver counts THAT size.

describe("R22d D14 review - compaction's byte trigger survives a changed skill text on replay", () => {
  const tool = mk("rev_tool");
  const BASE = "R".repeat(3000);
  const compactionBase = { toolId: "summarize", afterBytes: 2000, keepRecent: 1 };
  const live = (initial: string, tools: ToolDefinition[] = [tool]) => {
    const box = { text: initial };
    const skill = {
      ...mkSkill("rev", initial, tools),
      instructions: async () => ({ default: box.text }),
    } as SkillDefinition;
    return { box, skill };
  };

  async function resumeCompacted(
    second: string,
    steps: LlmToolCall[][] = [[ACT("rev")], [call("t", "rev_tool")]],
    mapEvent: (e: EventEnvelope) => EventEnvelope = (e) => e,
    opts: {
      afterBytes?: number;
      firstTools?: ToolDefinition[];
      secondTools?: ToolDefinition[];
      requireCompact?: boolean;
    } = {}
  ) {
    const compaction = {
      ...compactionBase,
      afterBytes: opts.afterBytes ?? compactionBase.afterBytes,
    };
    const store = new InMemoryAsyncEventStore();
    const first = boot({
      store,
      skills: [live(`${BASE}X`, opts.firstTools).skill],
      summarizer: true,
      config: { compaction },
      provider: script(steps),
    });
    expect((await runToEnd(first)).status).toBe("completed");
    const full = await store.read("e1");
    if (opts.requireCompact !== false) {
      expect(stepIds(full)).toContain("dba#turn:1:compact"); // the live run DID compact
    }
    const cutoff = full.findIndex((e) =>
      String((e.payload as { stepId?: string }).stepId ?? "").startsWith("dba#turn:2")
    );
    const prefix = full.slice(0, cutoff).map(mapEvent);
    const crashed = new InMemoryAsyncEventStore();
    for (const e of prefix) await crashed.append(e);
    const folded = new ReplayVM(prefix, {
      executionId: "e1",
      workflowId: "ask",
      workflowVersion: "1.0.0",
    }).getState();
    const b = boot({
      store: crashed,
      skills: [live(second, opts.secondTools).skill],
      summarizer: true,
      config: { compaction },
      provider: script(steps),
    });
    const st = await (await b.runtime.restoreFromState(folded)).waitForCompletion();
    return {
      b,
      st,
      ids: stepIds(await crashed.read("e1")),
      liveCompacted: stepIds(full).includes("dba#turn:1:compact"),
      liveFrames: stepIds(full).filter((x) => /compact/.test(x)),
    };
  }

  it("a ONE-CHARACTER edit (same length) resumes: the recorded compact frame is still asked for", async () => {
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const { b, st, ids } = await resumeCompacted(`${BASE}Y`);
      expect(st.status).toBe("completed");
      expect(b.warnings.filter((w) => /diverge/i.test(w))).toEqual([]);
      expect(ids).toContain("dba#turn:1:compact");
    } finally {
      spy.mockRestore();
    }
  });

  it("a LENGTH change resumes too", async () => {
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const { b, st } = await resumeCompacted(`${BASE}XYZ-longer`);
      expect(st.status).toBe("completed");
      expect(b.warnings.filter((w) => /diverge/i.test(w))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("the skill text becoming UNAVAILABLE (over the cap) on replay resumes too", async () => {
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const { st } = await resumeCompacted("R".repeat(40_000));
      expect(st.status).toBe("completed");
    } finally {
      spy.mockRestore();
    }
  });

  it("tools-and-text BOTH changed: the virtual size is the recorded live size - exact across the boundary", async () => {
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const extra = mk(`rev_tool_extra_${"z".repeat(48)}`); // ~65 bytes of added id in the result
      let compacted = 0;
      let skipped = 0;
      // A deterministic sweep of the threshold across the whole boundary (no timing).
      for (let afterBytes = 3000; afterBytes <= 3400; afterBytes += 4) {
        const r = await resumeCompacted(`${BASE}Y-changed`, undefined, undefined, {
          afterBytes,
          secondTools: [tool, extra],
          requireCompact: false,
        });
        expect(r.st.status, `afterBytes=${afterBytes}`).toBe("completed");
        expect(r.b.warnings.filter((w) => /diverge/i.test(w))).toEqual([]);
        expect(
          r.ids.filter((x) => /compact/.test(x)),
          `frames afterBytes=${afterBytes}`
        ).toEqual(r.liveFrames);
        if (r.liveCompacted) compacted++;
        else skipped++;
      }
      // The sweep really straddled the live trigger.
      expect(compacted).toBeGreaterThan(0);
      expect(skipped).toBeGreaterThan(0);
      // The other direction: tools REMOVED and text changed (the replay is the shorter list).
      for (let afterBytes = 3000; afterBytes <= 3400; afterBytes += 4) {
        const r = await resumeCompacted(`${BASE}Y-changed`, undefined, undefined, {
          afterBytes,
          firstTools: [tool, extra],
          secondTools: [tool],
          requireCompact: false,
        });
        expect(r.st.status, `removed afterBytes=${afterBytes}`).toBe("completed");
        expect(
          r.ids.filter((x) => /compact/.test(x)),
          `removed frames ${afterBytes}`
        ).toEqual(r.liveFrames);
        expect(r.b.warnings.filter((w) => /diverge/i.test(w))).toEqual([]);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("a tools-only change (same text) resumes too", async () => {
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const extra = mk(`rev_tool_extra_${"z".repeat(48)}`);
      for (let afterBytes = 3000; afterBytes <= 3400; afterBytes += 4) {
        const r = await resumeCompacted(`${BASE}X`, undefined, undefined, {
          afterBytes,
          secondTools: [tool, extra],
          requireCompact: false,
        });
        expect(r.st.status, `afterBytes=${afterBytes}`).toBe("completed");
      }
      for (let afterBytes = 3000; afterBytes <= 3400; afterBytes += 4) {
        const r = await resumeCompacted(`${BASE}X`, undefined, undefined, {
          afterBytes,
          firstTools: [tool, extra],
          secondTools: [tool],
          requireCompact: false,
        });
        expect(r.st.status, `removed afterBytes=${afterBytes}`).toBe("completed");
        expect(
          r.ids.filter((x) => /compact/.test(x)),
          `removed frames ${afterBytes}`
        ).toEqual(r.liveFrames);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("NEGATIVE: an OLD record (`bytes` but no `resultBytes`) keeps round-1 behaviour - the residual: a tool-list change inside the margin makes the replay's compaction differ from the live run's", async () => {
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const extra = mk(`rev_tool_extra_${"z".repeat(48)}`);
      const strip = (e: EventEnvelope): EventEnvelope => {
        const p = e.payload as { source?: string; choice?: Record<string, unknown> };
        if (p.source !== SOURCE_SKILL_ACTIVATION) return e;
        const { resultBytes: _drop, ...choice } = p.choice ?? {};
        return { ...e, payload: { ...p, choice } } as unknown as EventEnvelope;
      };
      let diverged = 0;
      for (let afterBytes = 3000; afterBytes <= 3400; afterBytes += 4) {
        try {
          const r = await resumeCompacted(`${BASE}Y-changed`, undefined, strip, {
            afterBytes,
            firstTools: [tool, extra],
            secondTools: [tool],
            requireCompact: false,
          });
          if (
            JSON.stringify(r.ids.filter((x) => /compact/.test(x))) !== JSON.stringify(r.liveFrames)
          )
            diverged++;
        } catch (err) {
          if (/not asked for|diverge/i.test(String(err))) diverged++;
          else throw err;
        }
      }
      expect(diverged).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("a TAMPERED `resultBytes` (below `bytes`, fractional, non-number, over the cap) is ignored: the replay behaves exactly as for a record without it", async () => {
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const extra = mk(`rev_tool_extra_${"z".repeat(48)}`);
      const rewrite =
        (value: (bytes: number) => unknown, drop = false) =>
        (e: EventEnvelope): EventEnvelope => {
          const p = e.payload as { source?: string; choice?: Record<string, unknown> };
          if (p.source !== SOURCE_SKILL_ACTIVATION) return e;
          const { resultBytes: _drop, ...rest } = p.choice ?? {};
          const choice = drop ? rest : { ...rest, resultBytes: value(rest.bytes as number) };
          return { ...e, payload: { ...p, choice } } as unknown as EventEnvelope;
        };
      // What a replay does with NO resultBytes, per threshold (frames, or the divergence).
      const outcome = async (mutate: (e: EventEnvelope) => EventEnvelope, afterBytes: number) => {
        try {
          const r = await resumeCompacted(`${BASE}Y-changed`, undefined, mutate, {
            afterBytes,
            firstTools: [tool, extra],
            secondTools: [tool],
            requireCompact: false,
          });
          return JSON.stringify(r.ids.filter((x) => /compact/.test(x)));
        } catch (err) {
          if (/not asked for|diverge/i.test(String(err))) return "diverged";
          throw err;
        }
      };
      const tampers: [string, (bytes: number) => unknown][] = [
        ["below bytes", (b) => b - 1],
        ["fractional", (b) => b + 64.5],
        ["a string", (b) => String(b + 64)],
        ["over the cap", () => 1e12],
      ];
      let differsFromHonest = 0;
      for (let afterBytes = 3000; afterBytes <= 3400; afterBytes += 8) {
        const stripped = await outcome(
          rewrite(() => undefined, true),
          afterBytes
        );
        const honest = await outcome((e) => e, afterBytes);
        if (stripped !== honest) differsFromHonest++;
        for (const [label, value] of tampers)
          expect(
            await outcome(rewrite(value), afterBytes),
            `${label} afterBytes=${afterBytes}`
          ).toBe(stripped);
      }
      // The sweep is not vacuous: somewhere in it an honest resultBytes changes the outcome.
      expect(differsFromHonest).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("NEGATIVE: an OLD record (no `bytes`) keeps today's behaviour - the residual: an edit still diverges", async () => {
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const strip = (e: EventEnvelope): EventEnvelope => {
        const p = e.payload as { source?: string; choice?: Record<string, unknown> };
        if (p.source !== SOURCE_SKILL_ACTIVATION) return e;
        const { bytes: _drop, resultBytes: _drop2, ...choice } = p.choice ?? {};
        return { ...e, payload: { ...p, choice } } as unknown as EventEnvelope;
      };
      await expect(resumeCompacted(`${BASE}Y`, undefined, strip)).rejects.toThrow(/not asked for/);
    } finally {
      spy.mockRestore();
    }
  });

  it("the activation records the delivered size (JSON-serialized UTF-8 length)", async () => {
    const t = `${BASE}é"\n`;
    const b = boot({ skills: [live(t).skill], provider: script([[ACT("rev")]]) });
    await runToEnd(b);
    const [d] = await activations(b);
    expect((d?.value as { bytes: number }).bytes).toBe(
      new TextEncoder().encode(JSON.stringify(t)).length
    );
  });

  it("re-delivery after a RESUME is pinned too: the pin comes from the replayed record", async () => {
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const steps = [[ACT("rev")], [ACT("rev")]];
      const store = new InMemoryAsyncEventStore();
      await runToEnd(boot({ store, skills: [live("RULES-v1").skill], provider: script(steps) }));
      const full = await store.read("e1");
      const cutoff = full.findIndex((e) =>
        String((e.payload as { stepId?: string }).stepId ?? "").startsWith("dba#turn:1")
      );
      const prefix = full.slice(0, cutoff);
      const crashed = new InMemoryAsyncEventStore();
      for (const e of prefix) await crashed.append(e);
      const folded = new ReplayVM(prefix, {
        executionId: "e1",
        workflowId: "ask",
        workflowVersion: "1.0.0",
      }).getState();
      const a = live("RULES-v1"); // same text at the replayed activation...
      let mutated = false;
      const b = boot({
        store: crashed,
        skills: [a.skill],
        provider: (req) => {
          // ...then it changes before the model re-activates (turn 1's request).
          if (!mutated && req.messages.filter((m) => m.role === "assistant").length === 1) {
            a.box.text = "RULES-v2-NEW";
            mutated = true;
          }
          return script(steps)(req);
        },
      });
      const st = await (await b.runtime.restoreFromState(folded)).waitForCompletion();
      expect(st.status).toBe("completed");
      const [first] = resultsOf(b.requests[0] as LlmRequest);
      expect(first?.result.instructions).toBe("RULES-v1"); // replay delivered v1 (pin set from the record)
      const [again] = resultsOf(b.requests[1] as LlmRequest);
      expect(again?.isError).toBe(true);
      expect(again?.result.error?.code).toBe("instructions_changed");
      expect(JSON.stringify(again?.result)).not.toContain("RULES-v2-NEW");
    } finally {
      spy.mockRestore();
    }
  });
});
