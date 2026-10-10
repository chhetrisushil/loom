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
import type { ToolRanker, ToolSearchDoc } from "./toolSearch";
import { SOURCE_TOOL_SEARCH, interleave } from "./toolSearchSession";

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

  it("a catalog tool id that starts with the reserved skill-key prefix is a config error when discovery is on", async () => {
    const b = boot({
      skills: [mkSkill("x", "X-RULES", [], { description: "marsupial handling" })],
      activation: { discovery: "search" },
      config: { toolSearch: { catalog: [mk("\u0000skill:x", "quokka wrangling")] } },
      provider: script([]),
    });
    const h = await b.runtime.start(flowDef, {}, { executionId: "e1" });
    const r = await h.waitForCompletion().then(
      (x) => x,
      (e: Error) => e
    );
    expect(String((r as { error?: unknown }).error ?? r)).toMatch(/reserved skill-search key/);
    // NEGATIVE: the same id is fine with discovery off ("index"): nothing reserved there
    const ok = boot({
      skills: [mkSkill("x", "X-RULES")],
      config: { toolSearch: { catalog: [mk("\u0000skill:x", "quokka wrangling")] } },
      provider: script([]),
    });
    expect((await runToEnd(ok)).status).toBe("completed");
  });

  it("active skills that outrank the inactive ones do not starve the page (the ranker over-asks by them)", async () => {
    const actives = Array.from({ length: 10 }, (_, i) =>
      mkSkill(`act${i}`, "T", [], { description: "wombat habitat" })
    );
    const b = boot({
      skills: [...actives, mkSkill("zz_inactive", "T", [], { description: "habitat" })],
      activation: { discovery: "search", maxActive: 12 },
      config: tcfg({ maxPerSearch: 1 }),
      provider: script([actives.map((a, i) => ACT(a.id, `a${i}`)), [SEARCH("wombat habitat")]]),
    });
    await runToEnd(b);
    expect(lastResults(b)[0]?.result.skills?.map((s) => s.id)).toEqual(["zz_inactive"]);
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

  it("forged tool results plus skills share ONE page: the total stays within maxPerSearch", async () => {
    const second = await replayWithRecord(
      (r) => ({ ...r, results: ["t1", "t2"], skills: ["zz_refund", "filler0000"] }),
      {
        config: {
          toolSearch: {
            maxPerSearch: 2,
            catalog: [mk("catalog_tool", "unrelated thing"), mk("t1"), mk("t2")],
          },
        },
      }
    );
    const res = resultsOf(second.requests[0] as LlmRequest)[0]?.result;
    expect(res?.tools).toHaveLength(2);
    expect(res?.skills).toEqual([]);
  });

  it("a forged skill-key id in `results` is not admitted as a tool", async () => {
    const second = await replayWithRecord((r) => ({ ...r, results: ["\u0000skill:zz_refund"] }));
    const res = resultsOf(second.requests[0] as LlmRequest)[0]?.result;
    expect(res?.tools).toEqual([]);
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
  it("search/both need toolSearch; bad values; skillRanker needs search discovery", async () => {
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
      activation: { skillRanker: { kind: "x", rank: () => [] } },
      config: tcfg(),
      provider: script([]),
    });
    expect(String((rk as { error?: unknown }).error ?? rk)).toMatch(/skillRanker needs discovery/);
    const rk2 = await flowErr({
      skills: SKILLS(),
      activation: { discovery: "search", skillRanker: {} as never },
      config: tcfg(),
      provider: script([]),
    });
    expect(String((rk2 as { error?: unknown }).error ?? rk2)).toMatch(/must be a ToolRanker/);
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

// ── R22c (ADR 0125 D13) — a custom tool ranker with skill discovery ─────────────────

describe("R22c - interleave (the page rule)", () => {
  it.each([
    [["t1", "t2", "t3"], ["s1", "s2", "s3"], 4, ["t1", "t2"], ["s1", "s2"]],
    [["t1", "t2", "t3"], ["s1", "s2", "s3"], 5, ["t1", "t2", "t3"], ["s1", "s2"]],
    [["t1"], ["s1", "s2", "s3"], 4, ["t1"], ["s1", "s2", "s3"]],
    [["t1", "t2", "t3"], ["s1"], 4, ["t1", "t2", "t3"], ["s1"]],
    [[], ["s1", "s2"], 5, [], ["s1", "s2"]],
    [["t1", "t2"], [], 5, ["t1", "t2"], []],
    [["t1", "t2"], ["s1", "s2"], 1, ["t1"], []],
    [["t1", "t2"], ["s1", "s2"], 0, [], []],
  ])("%j / %j want %i", (t, s, want, ot, os) => {
    expect(interleave(t, s, want)).toEqual({ first: ot, second: os });
  });
});

describe("R22c - custom tool ranker + skill discovery", () => {
  const TOOLS = ["pay_a", "pay_b", "pay_c", "pay_d"].map((id) => mk(id, `${id} payments`));
  const SK = () => [
    mkSkill("refund_one", "R1", [], { description: "refund customer chargeback handling" }),
    mkSkill("refund_two", "R2", [], { description: "refund customer money back policy" }),
    mkSkill("refund_three", "R3", [], { description: "refund customer escalation" }),
    mkSkill("unrelated", "U", [], { description: "weather forecast" }),
  ];
  /** A spy tool ranker: records every (query, limit) and every returned/seen id. */
  const spyTools = (ids: string[], hostile: string[] = []) => {
    const calls: { query: string; limit: number }[] = [];
    const ranker: ToolRanker = {
      kind: "spy-tools",
      rank: (query, limit) => {
        calls.push({ query, limit });
        return [...hostile, ...ids].slice(0, limit).map((id, i) => ({ id, score: 100 - i }));
      },
    };
    return { ranker, calls };
  };
  const spySkills = (ids: string[]) => {
    const calls: { query: string; limit: number }[] = [];
    const ranker: ToolRanker = {
      kind: "spy-skills",
      rank: (query, limit) => {
        calls.push({ query, limit });
        return ids.slice(0, limit).map((id, i) => ({ id, score: 100 - i }));
      },
    };
    return { ranker, calls };
  };
  const setup = (
    tools: ReturnType<typeof spyTools>,
    extra: Partial<Opts> = {},
    toolSearch: Partial<AgentLoopConfig["toolSearch"] & object> = {},
    activation: SkillActivationConfig = { discovery: "search" }
  ): Opts => ({
    skills: SK(),
    activation,
    config: { toolSearch: { catalog: TOOLS, ranker: tools.ranker, ...toolSearch } },
    provider: script([[SEARCH("refund payments")]]),
    ...extra,
  });

  it.each(["search", "both"] as const)(
    "%s: tool hits come from the custom ranker, skill hits from built-in BM25F over skills only",
    async (discovery) => {
      const t = spyTools(["pay_b", "pay_a"], ["\u0000skill:refund_two"]);
      const b = boot(setup(t, {}, {}, { discovery }));
      expect((await runToEnd(b)).status).toBe("completed");
      const [res] = lastResults(b);
      expect(res?.result.tools?.map((x) => x.name)).toEqual(["pay_b", "pay_a"]);
      // the hostile skill key from the tool ranker is dropped as a tool; skills come from BM25F
      expect(res?.result.skills?.map((x) => x.id)).toEqual(
        expect.arrayContaining(["refund_one", "refund_two", "refund_three"])
      );
      expect(res?.result.skills?.map((x) => x.id)).not.toContain("unrelated");
      const [rec] = await searches(b);
      const v = rec?.value as Record<string, unknown>;
      expect(v.ranker).toBe("spy-tools");
      expect(v.skillRanker).toBe("bm25f");
      expect(v.results).toEqual(["pay_b", "pay_a"]);
    }
  );

  it("the custom ranker only ever sees the query and a limit; the skill ranker only raw skill ids", async () => {
    const t = spyTools(["pay_a"]);
    const sk = spySkills(["refund_two", "pay_a", "\u0000skill:refund_one", "ghost"]);
    const b = boot(setup(t, {}, {}, { discovery: "search", skillRanker: sk.ranker }));
    await runToEnd(b);
    const [res] = lastResults(b);
    // the skill ranker's non-skill / prefixed / unknown ids are dropped
    expect(res?.result.skills?.map((x) => x.id)).toEqual(["refund_two"]);
    expect(res?.result.tools?.map((x) => x.name)).toEqual(["pay_a"]);
    expect(t.calls.length).toBeGreaterThan(0);
    expect(sk.calls.length).toBeGreaterThan(0);
    const rec = (await searches(b))[0]?.value as Record<string, unknown>;
    expect(rec.skillRanker).toBe("spy-skills");
  });

  it("skillRanker alone (built-in tool ranker): tools never contain skills, skills come from the host ranker", async () => {
    const sk = spySkills(["refund_three"]);
    const b = boot({
      skills: SK(),
      activation: { discovery: "both", skillRanker: sk.ranker },
      config: { toolSearch: { catalog: TOOLS } },
      provider: script([[SEARCH("payments")]]),
    });
    await runToEnd(b);
    const [res] = lastResults(b);
    expect(res?.result.skills?.map((x) => x.id)).toEqual(["refund_three"]);
    expect(res?.result.tools?.length).toBeGreaterThan(0);
    const rec = (await searches(b))[0]?.value as Record<string, unknown>;
    expect(rec.ranker).toBe("bm25f");
    expect(rec.skillRanker).toBe("spy-skills");
  });

  it("R22e: a skillRanker factory gets skill docs only (raw ids), a tool-ranker factory never sees skill keys", async () => {
    let skillDocs: readonly ToolSearchDoc[] = [];
    let toolDocs: readonly ToolSearchDoc[] = [];
    let skillBuilds = 0;
    const b = boot({
      skills: SK(),
      activation: {
        discovery: "search",
        skillRanker: (docs) => {
          skillBuilds++;
          skillDocs = docs;
          return { kind: "sk-fx", rank: () => [{ id: "refund_two", score: 1 }] };
        },
      },
      config: {
        toolSearch: {
          catalog: TOOLS,
          ranker: (docs) => {
            toolDocs = docs;
            return { kind: "tl-fx", rank: () => [{ id: "pay_a", score: 1 }] };
          },
        },
      },
      provider: script([[SEARCH("refund payments", "s1")], [SEARCH("again", "s2")]]),
    });
    await runToEnd(b);
    expect(skillBuilds).toBe(1);
    expect(skillDocs.map((d) => d.id).sort()).toEqual(
      ["refund_one", "refund_three", "refund_two", "unrelated"].sort()
    );
    expect(skillDocs.find((d) => d.id === "refund_two")?.description).toContain("money back");
    expect(toolDocs.map((d) => d.id).sort()).toEqual(["pay_a", "pay_b", "pay_c", "pay_d"]);
    expect(JSON.stringify(toolDocs)).not.toContain("skill");
    const rec = (await searches(b))[0]?.value as Record<string, unknown>;
    expect(rec.ranker).toBe("tl-fx");
    expect(rec.skillRanker).toBe("sk-fx");
  });

  it("R22e: a throwing skillRanker factory is search_unavailable", async () => {
    const b = boot({
      skills: SK(),
      activation: {
        discovery: "search",
        skillRanker: () => {
          throw new Error("nope");
        },
      },
      config: { toolSearch: { catalog: TOOLS } },
      provider: script([[SEARCH("refund")]]),
    });
    await runToEnd(b);
    expect(JSON.stringify(lastResults(b)[0]?.result)).toContain("search_unavailable");
    expect(await searches(b)).toEqual([]);
  });

  it("the page interleaves tool-first by rank position, up to maxPerSearch (no score mixing)", async () => {
    const t = spyTools(["pay_a", "pay_b", "pay_c"]);
    const sk = spySkills(["refund_one", "refund_two", "refund_three"]);
    const b = boot(
      setup(t, {}, { maxPerSearch: 4 }, { discovery: "search", skillRanker: sk.ranker })
    );
    await runToEnd(b);
    const [res] = lastResults(b);
    expect(res?.result.tools?.map((x) => x.name)).toEqual(["pay_a", "pay_b"]);
    expect(res?.result.skills?.map((x) => x.id)).toEqual(["refund_one", "refund_two"]);
  });

  it.each([
    ["tools exhausted", ["pay_a"], ["refund_one", "refund_two", "refund_three"], 1, 3],
    ["skills exhausted", ["pay_a", "pay_b", "pay_c"], ["refund_one"], 3, 1],
    ["no skills", ["pay_a", "pay_b"], [], 2, 0],
    ["no tools", [], ["refund_one", "refund_two"], 0, 2],
  ])("one kind exhausted: %s hands its share to the other", async (_n, ts, ss, nt, ns) => {
    const t = spyTools(ts);
    const sk = spySkills(ss);
    const b = boot(
      setup(t, {}, { maxPerSearch: 4 }, { discovery: "search", skillRanker: sk.ranker })
    );
    await runToEnd(b);
    const [res] = lastResults(b);
    expect(res?.result.tools).toHaveLength(nt);
    expect(res?.result.skills).toHaveLength(ns);
  });

  it("a tool ranker that throws is search_unavailable, nothing recorded, no text leaked", async () => {
    const sk = spySkills(["refund_one"]);
    const b = boot(
      setup(
        {
          ranker: {
            kind: "boom",
            rank: () => {
              throw new Error("SECRET-tools");
            },
          },
          calls: [],
        },
        {},
        {},
        { discovery: "search", skillRanker: sk.ranker }
      )
    );
    expect((await runToEnd(b)).status).toBe("completed");
    const [res] = lastResults(b);
    expect(res?.result.error?.code).toBe("search_unavailable");
    expect(JSON.stringify(res)).not.toContain("SECRET");
    expect(await searches(b)).toHaveLength(0);
  });

  it("a skill ranker that throws is search_unavailable, nothing recorded", async () => {
    const t = spyTools(["pay_a"]);
    const b = boot(
      setup(
        t,
        {},
        {},
        {
          discovery: "search",
          skillRanker: {
            kind: "boom",
            rank: () => {
              throw new Error("SECRET-skills");
            },
          },
        }
      )
    );
    expect((await runToEnd(b)).status).toBe("completed");
    const [res] = lastResults(b);
    expect(res?.result.error?.code).toBe("search_unavailable");
    expect(JSON.stringify(res)).not.toContain("SECRET");
    expect(await searches(b)).toHaveLength(0);
  });

  it("a terminal error from either ranker still propagates", async () => {
    const quota = Object.assign(new Error("quota"), { name: "QuotaExceededError" });
    const boom: ToolRanker = {
      kind: "boom",
      rank: () => {
        throw quota;
      },
    };
    const t = spyTools(["pay_a"]);
    await expect(
      runToEnd(boot(setup({ ranker: boom, calls: [] }, {}, {}, { discovery: "search" })))
    ).rejects.toThrow(/quota/);
    await expect(
      runToEnd(boot(setup(t, {}, {}, { discovery: "search", skillRanker: boom })))
    ).rejects.toThrow(/quota/);
  });

  it("over-ask: each ranker is asked for the page plus ITS OWN hidden count (tools: loaded + hidden; skills: active)", async () => {
    const t = spyTools(["pay_a", "pay_b"]);
    const sk = spySkills(["refund_one", "refund_two", "refund_three"]);
    const b = boot(
      setup(
        t,
        {
          agentTools: [mk("on_menu")],
          provider: script([[ACT("refund_one")], [SEARCH("refund payments")]]),
        },
        {
          maxPerSearch: 2,
          namespaces: ["pay_"],
          catalog: [...TOOLS, mk("hidden_1"), mk("hidden_2")],
        },
        { discovery: "search", skillRanker: sk.ranker }
      )
    );
    await runToEnd(b);
    // tools: want 2 + loaded 1 (agent tool on_menu) + hidden 2; skills: want 2 + 1 active
    expect(t.calls[0]?.limit).toBe(5);
    expect(sk.calls[0]?.limit).toBe(3);
    const [res] = lastResults(b);
    // active refund_one is not a hit
    expect(res?.result.skills?.map((x) => x.id)).not.toContain("refund_one");
  });

  it("widening is per ranker and bounded: a ranker whose head is unusable is re-asked with a doubled limit", async () => {
    const t = spyTools(["pay_a"], ["g1", "g2", "g3"]);
    const sk = spySkills(["g1", "g2", "g3", "refund_one"]);
    const b = boot(
      setup(
        t,
        { provider: script([[SEARCH("x")]]) },
        { maxPerSearch: 1 },
        { discovery: "search", skillRanker: sk.ranker }
      )
    );
    await runToEnd(b);
    expect(t.calls.map((c) => c.limit)).toEqual([1, 2, 4]);
    expect(sk.calls.map((c) => c.limit)).toEqual([1, 2, 4]);
    const [res] = lastResults(b);
    expect(res?.result.tools?.map((x) => x.name)).toEqual(["pay_a"]);
    // want 1 -> the tool takes the single slot
    expect(res?.result.skills).toEqual([]);
  });

  it("widening stops after the bounded number of rounds", async () => {
    const ghosts = Array.from({ length: 200 }, (_, i) => `g${i}`);
    const t = spyTools(ghosts);
    const b = boot(
      setup(t, { provider: script([[SEARCH("x")]]) }, { maxPerSearch: 1 }, { discovery: "search" })
    );
    await runToEnd(b);
    expect(t.calls.map((c) => c.limit)).toEqual([1, 2, 4, 8]);
  });

  // nothing discoverable means no activation offers, so skill search is never attached: pin that the
  // host skill ranker is then never asked
  it("a skillRanker is never asked when nothing is discoverable (every skill selected upfront)", async () => {
    const t = spyTools(["pay_a"]);
    const s = spySkills(["refund_one"]);
    const b = boot(
      setup(
        t,
        { selected: ["refund_one", "refund_two", "refund_three", "unrelated"] },
        {},
        { discovery: "search", skillRanker: s.ranker }
      )
    );
    expect((await runToEnd(b)).status).toBe("completed");
    expect(s.calls).toEqual([]);
    expect(lastResults(b)[0]?.result.tools?.map((x) => x.name)).toEqual(["pay_a"]);
  });

  describe("replay", () => {
    async function replayDual(
      forge: (rec: Record<string, unknown>) => Record<string, unknown> = (r) => r,
      want = 4,
      plainReplay = false
    ) {
      const t1 = spyTools(["pay_a", "pay_b", "pay_c"]);
      const s1 = spySkills(["refund_one", "refund_two", "refund_three"]);
      const mkOpts = (store: InMemoryAsyncEventStore, t: typeof t1, s: typeof s1): Opts =>
        setup(t, { store }, { maxPerSearch: want }, { discovery: "search", skillRanker: s.ranker });
      const store = new InMemoryAsyncEventStore();
      const first = boot(mkOpts(store, t1, s1));
      await runToEnd(first);
      const live = resultsOf(first.requests[1] as LlmRequest)[0]?.result;
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
      const t2 = spyTools(["never"]);
      const s2 = spySkills(["never"]);
      // plainReplay: the replaying host no longer configures either custom ranker
      const second = boot(
        plainReplay
          ? {
              ...mkOpts(crashed, t2, s2),
              activation: { discovery: "search" },
              config: { toolSearch: { catalog: TOOLS } },
            }
          : mkOpts(crashed, t2, s2)
      );
      await (await second.runtime.restoreFromState(folded)).waitForCompletion();
      return {
        live,
        replayed: resultsOf(second.requests[0] as LlmRequest)[0]?.result,
        second,
        t2,
        s2,
      };
    }

    it("an untampered interleaved page replays identically (divergence: fail), calling neither ranker", async () => {
      const { live, replayed, second, t2, s2 } = await replayDual();
      expect(live?.tools).toHaveLength(2);
      expect(live?.skills).toHaveLength(2);
      expect(replayed).toEqual(live);
      expect(t2.calls).toEqual([]);
      expect(s2.calls).toEqual([]);
      expect(second.warnings).toEqual([]);
    });

    it("an odd-sized interleaved page (tool-led 3 + 2) replays identically too", async () => {
      const { live, replayed } = await replayDual((r) => r, 5);
      expect(live?.tools).toHaveLength(3);
      expect(live?.skills).toHaveLength(2);
      expect(replayed).toEqual(live);
    });

    it("a two-ranker record replays identically under a config with NO custom ranker", async () => {
      const { live, replayed, second, t2, s2 } = await replayDual((r) => r, 4, true);
      expect(live?.skills).toHaveLength(2);
      expect(replayed).toEqual(live);
      expect(t2.calls).toEqual([]);
      expect(s2.calls).toEqual([]);
      expect(second.warnings).toEqual([]);
    });

    it("a forged record is re-admitted: unknown ids dropped, the page capped, still no ranker call", async () => {
      const { replayed, t2, s2 } = await replayDual(
        (r) => ({
          ...r,
          results: ["ghost", "pay_a", "pay_b", "pay_c", "pay_d"],
          skills: ["refund_one", "refund_two"],
        }),
        4
      );
      expect(replayed?.tools?.map((x) => x.name)).toEqual(["pay_a", "pay_b", "pay_c", "pay_d"]);
      expect(replayed?.skills).toEqual([]);
      expect(t2.calls).toEqual([]);
      expect(s2.calls).toEqual([]);
    });
  });

  it("with two rankers the tool index holds NO skill docs: strongly matching skills cannot crowd a tool out", async () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      mkSkill(`rs${i}`, "X", [], { description: "refund chargeback" })
    );
    const b = boot({
      skills: many,
      activation: { discovery: "search", skillRanker: spySkills([]).ranker },
      config: {
        toolSearch: {
          catalog: [mk("weak_tool", "refund"), mk("other", "unrelated")],
          maxPerSearch: 1,
        },
      },
      provider: script([[SEARCH("refund chargeback")]]),
    });
    await runToEnd(b);
    expect(lastResults(b)[0]?.result.tools?.map((x) => x.name)).toEqual(["weak_tool"]);
  });

  it("the single-ranker path is unchanged: no skillRanker in the record, one combined index", async () => {
    const b = boot({
      skills: SK(),
      activation: { discovery: "search" },
      config: { toolSearch: { catalog: TOOLS } },
      provider: script([[SEARCH("refund")]]),
    });
    await runToEnd(b);
    const rec = (await searches(b))[0]?.value as Record<string, unknown>;
    expect(rec.ranker).toBe("bm25f");
    expect(Object.keys(rec)).not.toContain("skillRanker");
    expect(lastResults(b)[0]?.result.skills?.map((x) => x.id)).toContain("refund_one");
  });
});

describe("R22d (ADR 0125 D14) - a skillRanker / tool ranker that ignores `limit` is clamped (two-ranker mode)", () => {
  const TOOLS = ["pay_a", "pay_b"].map((id) => mk(id, `${id} payments`));
  const SK = () => ["refund_one", "refund_two"].map((id) => mkSkill(id, id.toUpperCase()));
  const flood = (reads: { n: number }, head: string[]) =>
    Array.from({ length: 10_000 }, (_, i) => ({
      score: 1,
      get id() {
        reads.n++;
        return head[i] ?? `ghost_${i}`;
      },
    }));

  it("skillRanker: reads at most the sum of its asks, and the live page is correct", async () => {
    const reads = { n: 0 };
    const asks: number[] = [];
    const sloppy: ToolRanker = {
      kind: "sloppy-skills",
      rank: (_q, limit) => {
        asks.push(limit);
        return flood(reads, ["refund_two", "refund_one"]);
      },
    };
    const b = boot({
      skills: SK(),
      activation: { discovery: "search", skillRanker: sloppy },
      config: { toolSearch: { catalog: TOOLS } },
      provider: script([[SEARCH("refund")]]),
    });
    expect((await runToEnd(b)).status).toBe("completed");
    const [res] = lastResults(b);
    expect(res?.result.skills?.map((x) => x.id)).toEqual(["refund_two", "refund_one"]);
    expect(asks.length).toBeGreaterThan(0);
    expect(reads.n).toBeLessThanOrEqual(asks.reduce((a, b) => a + b, 0));
  });

  it("custom tool ranker in two-ranker mode: same clamp", async () => {
    const reads = { n: 0 };
    const asks: number[] = [];
    const sloppy: ToolRanker = {
      kind: "sloppy-tools",
      rank: (_q, limit) => {
        asks.push(limit);
        return flood(reads, ["pay_b"]);
      },
    };
    const b = boot({
      skills: SK(),
      activation: { discovery: "search" },
      config: { toolSearch: { catalog: TOOLS, ranker: sloppy } },
      provider: script([[SEARCH("pay")]]),
    });
    await runToEnd(b);
    const [res] = lastResults(b);
    expect(res?.result.tools?.map((x) => x.name)).toEqual(["pay_b"]);
    expect(reads.n).toBeLessThanOrEqual(asks.reduce((a, b) => a + b, 0));
  });
});

describe("R22e (ADR 0125 D15) review - skill-side factory traps", () => {
  const T = [mk("pay_a", "pay thing")];
  it("a factory that mutates the skill docs it received cannot change the registry or later searches", async () => {
    const skills = [
      mkSkill("refund_one", "R1", [], { tags: ["t1"], aliases: ["a1"] }),
      mkSkill("other", "O"),
    ];
    const attempts: string[] = [];
    const b = boot({
      skills,
      activation: {
        discovery: "search",
        skillRanker: (docs) => {
          for (const f of [
            () => (docs[0]?.tags as string[]).push("HOSTILE"),
            () => (docs[0]?.aliases as string[]).push("HOSTILE"),
            () => (docs as ToolSearchDoc[]).pop(),
          ]) {
            try {
              f();
              attempts.push("mutated");
            } catch {
              /* frozen */
            }
          }
          return { kind: "sk", rank: () => [{ id: "refund_one", score: 1 }] };
        },
      },
      config: { toolSearch: { catalog: T } },
      provider: script([[SEARCH("a", "s1")], [SEARCH("b", "s2")]]),
    });
    await runToEnd(b);
    expect(attempts).toEqual([]);
    expect(skills[0]?.tags).toEqual(["t1"]);
    expect(skills[0]?.aliases).toEqual(["a1"]);
    expect(JSON.stringify(lastResults(b)[0]?.result)).toContain("refund_one");
  });

  it("a CLASS or a rank-less object as skillRanker is a config error", async () => {
    class SkR {
      readonly kind = "c";
      rank() {
        return [];
      }
    }
    for (const [skillRanker, re] of [
      [SkR, /skillRanker is a class/],
      [{ kind: "x" }, /skillRanker.*rank/],
      [{ rank: () => [] }, /string `kind`/],
    ] as const) {
      const b = boot({
        skills: [mkSkill("s", "S")],
        activation: { discovery: "search", skillRanker: skillRanker as never },
        config: { toolSearch: { catalog: T } },
        provider: script([[SEARCH("x")]]),
      });
      const h = await b.runtime.start(flowDef, {}, { executionId: "e1" });
      const r = await h.waitForCompletion().then(
        (x) => x,
        (e: Error) => e
      );
      expect(String((r as { error?: unknown }).error ?? r)).toMatch(re);
    }
  });

  it("async tool + skill factories in one run: search_unavailable, and ONE LOOM_AGENT_RANKER_FACTORY warning for the run", async () => {
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const asyncFx = (async () => ({ kind: "x", rank: () => [] })) as never;
      const b = boot({
        skills: [mkSkill("s", "S")],
        activation: { discovery: "search", skillRanker: asyncFx },
        config: { toolSearch: { catalog: T, ranker: asyncFx } },
        provider: script([[SEARCH("x", "s1")], [SEARCH("y", "s2")]]),
      });
      await runToEnd(b);
      expect(JSON.stringify(lastResults(b)[0]?.result)).toContain("search_unavailable");
      const codes = spy.mock.calls
        .map((c) => (c[1] as { code?: string } | undefined)?.code)
        .filter((c) => c === "LOOM_AGENT_RANKER_FACTORY");
      expect(codes).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});
