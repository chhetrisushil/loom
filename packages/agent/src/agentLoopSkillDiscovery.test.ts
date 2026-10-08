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

// ── R22b (ADR 0125 D12) — skills discoverable through `search_tools` ───────────────
//
// The boot harness is the D11 one. Pinned, each with its negative case: the default (`index`) is
// unchanged; `search` swaps the index for one fixed line; `both` keeps it; a skill past the index cut
// is found and activated; a skill hit loads nothing; a skill and a tool never collide; the record is
// re-admitted against the live discoverable set on replay; config errors are loud.

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
  skills?: { kind: string; id: string; description: string }[];
  note?: string;
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

const SKILLS = () => [
  mkSkill("billing", "BILLING-RULES", [mk("audit_tool", "audit things")]),
  mkSkill("alpha", "ALPHA-RULES"),
  mkSkill("zeta", "ZETA-RULES", [], { tags: ["z1", "z2"] }),
];
const SEARCH = (query: string, id = "s") => call(id, "search_tools", { query });
const searches = async (b: Booted) =>
  decisions(await b.store.read("e1")).filter((d) => d.source === SOURCE_TOOL_SEARCH);
const lastResults = (b: Booted) => resultsOf(b.requests[b.requests.length - 1] as LlmRequest);
/** N filler skills with distinct vocabulary plus one needle that sorts LAST by id. */
const bigRegistry = (n: number): SkillDefinition[] => [
  ...Array.from({ length: n }, (_, i) =>
    mkSkill(`filler${String(i).padStart(4, "0")}`, `FILLER-${i}`, [], {
      description: `generic filler number ${i}`,
    })
  ),
  mkSkill("zz_refund", "REFUND-RULES", [mk("refund_tool")], {
    description: "handle customer refunds and chargebacks",
    aliases: ["give the money back"],
  }),
];
const tcfg = (extra: Partial<AgentLoopConfig["toolSearch"] & object> = {}) => ({
  toolSearch: { catalog: [mk("catalog_tool", "unrelated thing")], ...extra },
});

describe("R22b - discovery modes", () => {
  it('default "index" is unchanged: no skills key, index in the prompt, same hit shape', async () => {
    const b = boot({
      skills: SKILLS(),
      config: tcfg(),
      provider: script([[SEARCH("billing")]]),
    });
    await runToEnd(b);
    const sys = systemOf(b.requests[0] as LlmRequest);
    expect(sys).toContain("- billing: billing skill");
    expect(sys).not.toContain("search_tools");
    const [res] = lastResults(b);
    expect(res?.result.skills).toBeUndefined();
    expect(await searches(b)).toHaveLength(1);
    expect(Object.keys((await searches(b))[0]?.value as object)).not.toContain("skills");
    expect(res?.result.note).toBe("No matching tools.");
    const meta = (b.requests[0] as LlmRequest).tools?.find((t) => t.name === "search_tools");
    expect(String(meta?.description)).not.toContain("skills");
  });

  it('"search" replaces the index by one fixed line with no skill text', async () => {
    const b = boot({
      skills: SKILLS(),
      activation: { discovery: "search" },
      config: tcfg(),
      provider: script([]),
    });
    await runToEnd(b);
    const sys = systemOf(b.requests[0] as LlmRequest);
    expect(sys).toContain("`search_tools`");
    expect(sys).toContain("`activate_skill`");
    expect(sys).not.toContain("billing");
    expect(sys).not.toContain("ALPHA");
    expect(sys.split("\n").filter((l) => l.startsWith("- "))).toEqual([]);
    expect(toolNames(b.requests[0] as LlmRequest)).toEqual(["search_tools", "activate_skill"]);
  });

  it('"both" keeps the index and search also covers skills', async () => {
    const b = boot({
      skills: SKILLS(),
      activation: { discovery: "both" },
      config: tcfg(),
      provider: script([[SEARCH("zeta")]]),
    });
    await runToEnd(b);
    expect(systemOf(b.requests[0] as LlmRequest)).toContain("- zeta: zeta skill");
    const [res] = lastResults(b);
    expect(res?.result.skills?.map((s) => s.id)).toEqual(["zeta"]);
  });

  it('"both" with an index that fits nothing is allowed (search reaches everything)', async () => {
    const b = boot({
      skills: SKILLS(),
      activation: { discovery: "both", maxIndexBytes: 100 },
      config: tcfg(),
      provider: script([[SEARCH("alpha")], [ACT("alpha")]]),
    });
    await runToEnd(b);
    expect(systemOf(b.requests[0] as LlmRequest)).toContain("find them with `search_tools`");
    const [r] = resultsOf(b.requests[b.requests.length - 1] as LlmRequest);
    expect(r?.result.instructions).toBe("ALPHA-RULES");
  });
});

describe("R22b - a registry past the index cut", () => {
  const steps = [[SEARCH("refunds chargebacks")], [ACT("zz_refund")], [call("r", "refund_tool")]];
  it.each(["search", "both"] as const)(
    "%s: a skill past the cut is found by search and activated; the tools join only on activation",
    async (discovery) => {
      const b = boot({
        skills: bigRegistry(500),
        activation: { discovery, maxIndexBytes: 600 },
        config: tcfg(),
        provider: script(steps),
      });
      expect((await runToEnd(b)).status).toBe("completed");
      // the needle is NOT in the (tiny) index
      expect(systemOf(b.requests[0] as LlmRequest)).not.toContain("zz_refund");
      const [hit] = resultsOf(b.requests[1] as LlmRequest);
      expect(hit?.result.skills?.[0]).toEqual({
        kind: "skill",
        id: "zz_refund",
        description: "handle customer refunds and chargebacks",
      });
      // the hit alone loaded nothing: no skill tool on the next request, no instructions in the result
      expect(toolNames(b.requests[1] as LlmRequest)).toEqual(["search_tools", "activate_skill"]);
      expect(JSON.stringify(hit?.result)).not.toContain("REFUND-RULES");
      const [act] = resultsOf(b.requests[2] as LlmRequest);
      expect(act?.result.instructions).toBe("REFUND-RULES");
      expect(toolNames(b.requests[2] as LlmRequest)).toContain("refund_tool");
      expect(b.toolRuns).toEqual(["refund_tool"]);
      expect(await activations(b)).toHaveLength(1);
    }
  );

  it('NEGATIVE: with discovery "index" the same skill is unreachable (unknown_skill)', async () => {
    const b = boot({
      skills: bigRegistry(500),
      activation: { maxIndexBytes: 600 },
      config: tcfg(),
      provider: script([[ACT("zz_refund")]]),
    });
    await runToEnd(b);
    const [r] = lastResults(b);
    expect(r?.result.error?.code).toBe("unknown_skill");
  });

  it("an id that is neither listed nor discoverable is still unknown_skill", async () => {
    const b = boot({
      skills: SKILLS(),
      selected: ["alpha"],
      activation: { discovery: "search" },
      config: tcfg(),
      provider: script([[ACT("alpha"), ACT("ghost", "b")]]),
    });
    await runToEnd(b);
    const rs = lastResults(b);
    expect(rs.map((r) => r.result.error?.code)).toEqual(["unknown_skill", "unknown_skill"]);
  });
});

describe("R22b - hits: shape, collisions, caps, active skills", () => {
  it("a skill and a tool with the same id (even `skill:x`) never collide", async () => {
    const b = boot({
      skills: [mkSkill("x", "X-RULES", [], { description: "quokka wrangling" })],
      activation: { discovery: "search" },
      config: {
        toolSearch: {
          catalog: [mk("x", "quokka wrangling"), mk("skill:x", "quokka wrangling")],
        },
      },
      provider: script([[SEARCH("quokka wrangling")]]),
    });
    await runToEnd(b);
    const [res] = lastResults(b);
    expect((res?.result.tools ?? []).map((t) => t.name).sort()).toEqual(["skill:x", "x"]);
    expect(res?.result.skills?.map((s) => s.id)).toEqual(["x"]);
  });

  it("skill hits count toward maxPerSearch (one shared page)", async () => {
    const skills = Array.from({ length: 6 }, (_, i) =>
      mkSkill(`ska${i}`, "T", [], { description: "wombat habitat" })
    );
    const b = boot({
      skills,
      activation: { discovery: "search" },
      config: tcfg({ maxPerSearch: 3 }),
      provider: script([[SEARCH("wombat habitat")]]),
    });
    await runToEnd(b);
    const [res] = lastResults(b);
    expect(res?.result.skills).toHaveLength(3);
    expect((await searches(b))[0]?.value).toMatchObject({ skills: ["ska0", "ska1", "ska2"] });
  });

  it("a mixed page is bounded in total, live and recorded", async () => {
    const b = boot({
      skills: ["a", "b", "c"].map((x) =>
        mkSkill(`wombat_${x}`, "T", [], { description: "wombat habitat" })
      ),
      agentTools: [mk("other_one"), mk("other_two")], // loaded tools widen the ranker's ask past the page
      activation: { discovery: "search" },
      config: {
        toolSearch: { maxPerSearch: 2, catalog: [mk("wombat_tool", "wombat habitat")] },
      },
      provider: script([[SEARCH("wombat habitat")]]),
    });
    await runToEnd(b);
    const [res] = lastResults(b);
    expect((res?.result.tools?.length ?? 0) + (res?.result.skills?.length ?? 0)).toBe(2);
    const rec = (await searches(b))[0]?.value as { results: string[]; skills: string[] };
    expect(rec.results.length + rec.skills.length).toBe(2);
  });

  it("a tool id that would equal a skill's index key is not indexed (the skill still wins its key)", async () => {
    const b = boot({
      skills: [mkSkill("x", "X-RULES", [], { description: "marsupial handling" })],
      activation: { discovery: "search" },
      config: { toolSearch: { catalog: [mk("\u0000skill:x", "quokka wrangling")] } },
      provider: script([[SEARCH("quokka wrangling")], [SEARCH("marsupial handling")]]),
    });
    await runToEnd(b);
    // the colliding tool's text must not stand in for the skill's...
    const [first] = resultsOf(b.requests[1] as LlmRequest);
    expect(first?.result.skills).toEqual([]);
    expect(first?.result.tools).toEqual([]);
    // ...and the skill is ranked on its own text
    expect(lastResults(b)[0]?.result.skills?.map((s) => s.id)).toEqual(["x"]);
  });

  it("an already-active skill is not a hit", async () => {
    const b = boot({
      skills: bigRegistry(3),
      activation: { discovery: "search" },
      config: tcfg(),
      provider: script([[ACT("zz_refund")], [SEARCH("refunds chargebacks")]]),
    });
    await runToEnd(b);
    const [res] = lastResults(b);
    expect(res?.result.skills).toEqual([]);
    expect(res?.result.note).toBe("No matching tools or skills.");
  });

  it("an upfront-selected skill is not discoverable", async () => {
    const b = boot({
      skills: bigRegistry(3),
      selected: ["zz_refund"],
      activation: { discovery: "search" },
      config: tcfg(),
      provider: script([[SEARCH("refunds chargebacks")]]),
    });
    await runToEnd(b);
    expect(lastResults(b)[0]?.result.skills).toEqual([]);
  });

  it("a skill-only page says so", async () => {
    const b = boot({
      skills: bigRegistry(2),
      activation: { discovery: "search" },
      config: tcfg(),
      provider: script([[SEARCH("refunds chargebacks")]]),
    });
    await runToEnd(b);
    expect(lastResults(b)[0]?.result.note).toContain("activate_skill");
  });
});

describe("R22b - replay re-admits skill hits against the live set", () => {
  async function replayWithRecord(
    forge: (rec: Record<string, unknown>) => Record<string, unknown>,
    opts: Partial<Opts> = {}
  ) {
    const mkOpts = (store: InMemoryAsyncEventStore): Opts => ({
      store,
      skills: bigRegistry(3),
      activation: { discovery: "search" },
      config: tcfg(),
      provider: script([[SEARCH("refunds chargebacks")]]),
      ...opts,
    });
    const store = new InMemoryAsyncEventStore();
    await runToEnd(boot(mkOpts(store)));
    const full = await store.read("e1");
    const cutoff = full.findIndex((e) =>
      String((e.payload as { stepId?: string }).stepId ?? "").startsWith("dba#turn:1")
    );
    const prefix = full.slice(0, cutoff).map((e) => {
      const p = e.payload as { decisionId?: string; choice?: Record<string, unknown> };
      return p.decisionId === "dba#turn:0:tool:0:search"
        ? ({ ...e, payload: { ...p, choice: forge(p.choice ?? {}) } } as EventEnvelope)
        : e;
    });
    const crashed = new InMemoryAsyncEventStore();
    for (const e of prefix) await crashed.append(e);
    const folded = new ReplayVM(prefix, {
      executionId: "e1",
      workflowId: "ask",
      workflowVersion: "1.0.0",
    }).getState();
    const second = boot(mkOpts(crashed));
    await (await second.runtime.restoreFromState(folded)).waitForCompletion();
    return second;
  }

  it("NEGATIVE: an untampered record replays the same hit and makes no new search decision", async () => {
    const second = await replayWithRecord((r) => r);
    expect(resultsOf(second.requests[0] as LlmRequest)[0]?.result.skills?.map((s) => s.id)).toEqual(
      ["zz_refund"]
    );
    expect(second.warnings).toEqual([]);
  });

  it.each([
    ["a forged id", { skills: ["ghost", "zz_refund"] }, ["zz_refund"]],
    ["a non-array", { skills: "zz_refund" }, []],
    ["garbage entries", { skills: [1, null, {}, "zz_refund", "zz_refund"] }, ["zz_refund"]],
    ["no skills key (pre-D12 record)", { skills: undefined }, []],
  ])("%s", async (_n, patch, expected) => {
    const second = await replayWithRecord((r) => ({ ...r, ...patch }));
    const res = resultsOf(second.requests[0] as LlmRequest)[0]?.result;
    expect(res?.skills?.map((s) => s.id)).toEqual(expected);
  });

  it("a recorded skill that is upfront-selected NOW is dropped", async () => {
    const second = await replayWithRecord((r) => r, { selected: ["zz_refund"] });
    expect(resultsOf(second.requests[0] as LlmRequest)[0]?.result.skills).toEqual([]);
  });

  it("a forged skill list is capped at maxPerSearch", async () => {
    const second = await replayWithRecord(
      (r) => ({ ...r, skills: ["filler0000", "filler0001", "filler0002", "zz_refund"] }),
      { config: tcfg({ maxPerSearch: 2 }) }
    );
    expect(resultsOf(second.requests[0] as LlmRequest)[0]?.result.skills).toHaveLength(2);
  });
});

describe("R22b - config errors and unchanged failure path", () => {
  const flowErr = async (o: Opts) => {
    const b = boot(o);
    const h = await b.runtime.start(flowDef, {}, { executionId: "e1" });
    return h.waitForCompletion().then(
      (r) => r,
      (e: Error) => e
    );
  };
  it("search/both need toolSearch; bad values; a custom ranker", async () => {
    for (const discovery of ["search", "both"] as const) {
      const r = await flowErr({
        skills: SKILLS(),
        activation: { discovery },
        provider: script([]),
      });
      expect(String((r as { error?: unknown }).error ?? r)).toMatch(/needs `toolSearch`/);
    }
    const bad = await flowErr({
      skills: SKILLS(),
      activation: { discovery: "nope" as never },
      config: tcfg(),
      provider: script([]),
    });
    expect(String((bad as { error?: unknown }).error ?? bad)).toMatch(/discovery must be/);
    const rk = await flowErr({
      skills: SKILLS(),
      activation: { discovery: "search" },
      config: tcfg({ ranker: { kind: "x", rank: () => [] } }),
      provider: script([]),
    });
    expect(String((rk as { error?: unknown }).error ?? rk)).toMatch(/built-in ranker/);
  });

  it("a skill whose tool is named like the search meta-tool is still a config error in search mode", async () => {
    const r = await flowErr({
      skills: [mkSkill("s1", "T", [mk("search_tools")])],
      activation: { discovery: "search" },
      config: tcfg(),
      provider: script([]),
    });
    expect(String((r as { error?: unknown }).error ?? r)).toMatch(/collides/);
  });

  it("a failing index build is still search_unavailable and records nothing; the run goes on", async () => {
    const bad = mkSkill("boom", "T");
    Object.defineProperty(bad, "description", {
      get() {
        throw new Error("secret host detail");
      },
    });
    const b = boot({
      skills: [bad],
      activation: { discovery: "search" },
      config: tcfg(),
      provider: script([[SEARCH("anything")]]),
    });
    expect((await runToEnd(b)).status).toBe("completed");
    const [res] = lastResults(b);
    expect(res?.result.error?.code).toBe("search_unavailable");
    expect(JSON.stringify(res)).not.toContain("secret");
    expect(await searches(b)).toHaveLength(0);
  });
});
