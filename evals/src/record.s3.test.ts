import { readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import type { LlmProvider } from "@loom/llm";
import { describe, expect, it, vi } from "vitest";
import { TASKS } from "./agentLoop/tasks";
import { APPGEN_CASES } from "./appgen/cases";
import { turnOf } from "./cassetteFiles";
import { PLANNER_CASES } from "./planner/cases";
import {
  MODEL_ENV,
  type RecordDeps,
  judgeAppgenRecording,
  judgePlannerRecording,
  judgeRecording,
  recordTargets,
  runRecord,
} from "./record";

// `pnpm eval:record` after slice S3: the same guarantees for the appgen and planner cassettes as for the agentLoop
// ones (record.test.ts), plus the S2 review backlog item: a Gemini HTTP 200 with NO candidates is not a recording.
// A FAKE provider only: nothing here can reach Gemini.

const env = { GEMINI_API_KEY: "sekrit-key-123", [MODEL_ENV]: "gemini:fake" };
const empty = { content: "", stopReason: "end_turn" as const };

function harness(provider: LlmProvider) {
  const written: Record<string, Record<string, unknown>> = {};
  const lines: string[] = [];
  const d: RecordDeps = {
    makeProvider: vi.fn(async () => provider),
    write: (id, data) => {
      written[id] = data;
    },
    log: (l) => lines.push(l),
  };
  return { d, written, lines, text: () => lines.join("\n") };
}

describe("eval:record refuses an empty 200 (no candidates), for every kind of target", () => {
  // The adapter turns an HTTP 200 with no candidates into `content: ""` + `end_turn` (no throw), so a loop completes
  // the run with nothing in it. Before this, an expected-`completed` task accepted it.

  it("agentLoop: an expected-completed task with no final answer and no tool call is NOT WRITTEN", async () => {
    const h = harness({ complete: async () => empty });
    expect(await runRecord(["--live", "--task", "no-tool-answer"], env, h.d)).toBe(1);
    expect(h.written).toEqual({});
    expect(h.text()).toMatch(
      /no-tool-answer: NOT WRITTEN.*empty model answer.*no final answer and no tool call/
    );
  });

  it("judgeRecording: an answer alone or a tool call alone is enough; neither is not; a failed-by-design task is exempt", () => {
    const done = { expected: { status: "completed" } } as never;
    const base = { status: "completed", steps: 1 } as const;
    expect(judgeRecording(done, { ...base, answer: "", toolCalls: 0 }, 1, [])).toMatch(
      /empty model answer/
    );
    expect(judgeRecording(done, { ...base, answer: "   ", toolCalls: 0 }, 1, [])).toMatch(
      /empty model answer/
    );
    expect(judgeRecording(done, { ...base, answer: "", toolCalls: 1 }, 1, [])).toBeUndefined();
    expect(judgeRecording(done, { ...base, answer: "ok", toolCalls: 0 }, 1, [])).toBeUndefined();
    const fails = { expected: { status: "failed" } } as never;
    expect(
      judgeRecording(fails, { status: "failed", steps: 1, answer: "", toolCalls: 1 }, 1, [])
    ).toBeUndefined();
  });

  it("appgen: every reply empty is NOT WRITTEN (the planner would silently fall back to the deterministic plan)", async () => {
    const h = harness({ complete: async () => empty });
    expect(await runRecord(["--live", "--task", "appgen/edit-triage-approval"], env, h.d)).toBe(1);
    expect(h.written).toEqual({});
    expect(h.text()).toMatch(/appgen\/edit-triage-approval: NOT WRITTEN.*empty model answer/);
  });

  it("planner: an empty router answer (keyword fallback) is NOT WRITTEN", async () => {
    const h = harness({ complete: async () => empty });
    expect(await runRecord(["--live", "--task", "planner/cpu-single"], env, h.d)).toBe(1);
    expect(h.written).toEqual({});
    expect(h.text()).toMatch(/planner\/cpu-single: NOT WRITTEN.*did not name a capability/);
  });

  it("planner: an empty 200 on the no-capability case is NOT WRITTEN; a proper NONE refusal is written", async () => {
    const h = harness({ complete: async () => empty });
    expect(await runRecord(["--live", "--task", "planner/no-capability"], env, h.d)).toBe(1);
    expect(h.written).toEqual({});
    expect(h.text()).toMatch(/planner\/no-capability: NOT WRITTEN.*no explicit refusal/);

    const c = PLANNER_CASES.find((x) => x.id === "no-capability");
    const run = c?.script as NonNullable<typeof c>["script"];
    const g = harness({ complete: async (req) => run(turnOf(req), req) });
    expect(await runRecord(["--live", "--task", "planner/no-capability"], env, g.d), g.text()).toBe(
      0
    );
    expect(Object.keys(g.written)).toEqual(["planner/no-capability"]);
  });

  it("the S3 judges, directly", () => {
    const ok = {
      spec: { planner: "model", capabilities: [{ id: "a" }] },
      reasons: [],
      replies: ["{}"],
    } as never;
    expect(judgeAppgenRecording(ok, 1, [])).toBeUndefined();
    expect(judgeAppgenRecording(ok, 0, [])).toMatch(/empty recording/);
    expect(judgeAppgenRecording(ok, 1, ["429"])).toMatch(/provider error: 429/);
    expect(
      judgeAppgenRecording(
        {
          spec: { planner: "deterministic", capabilities: [] },
          reasons: ["why"],
          replies: ["x"],
        } as never,
        1,
        []
      )
    ).toMatch(/not accepted: why/);
    expect(
      judgeAppgenRecording(
        { spec: { planner: "model", capabilities: [] }, reasons: [], replies: ["x"] } as never,
        1,
        []
      )
    ).toMatch(/empty plan/);
    expect(
      judgeAppgenRecording({ spec: undefined, reasons: [], replies: ["", " "] } as never, 1, [])
    ).toMatch(/empty model answer/);

    const graph = { route: "x", routedBy: "model", graph: [{ id: "a" }] } as never;
    const with_ = (o: object) => ({ ...(graph as object), ...o }) as never;
    expect(judgePlannerRecording(false, graph, 2, [])).toBeUndefined();
    expect(judgePlannerRecording(false, with_({ graph: [] }), 2, [])).toMatch(/empty graph/);
    expect(judgePlannerRecording(false, with_({ graph: "refused:empty" }), 2, [])).toMatch(
      /empty graph/
    );
    expect(
      judgePlannerRecording(
        true,
        with_({ graph: "refused:empty", route: null, routedBy: "none", routerReply: "NONE" }),
        2,
        []
      )
    ).toBeUndefined();
    expect(judgePlannerRecording(true, graph, 2, [])).toMatch(/expected a refusal/);
    const refused = { graph: "refused:empty", route: null, routedBy: "none" };
    expect(judgePlannerRecording(true, with_(refused), 2, [])).toMatch(/no explicit refusal/);
    expect(judgePlannerRecording(true, with_({ ...refused, routerReply: "  " }), 2, [])).toMatch(
      /reply was empty/
    );
    expect(
      judgePlannerRecording(true, with_({ ...refused, routerReply: "I am not sure" }), 2, [])
    ).toMatch(/did not answer NONE/);
    expect(judgePlannerRecording(false, with_({ routedBy: "keyword" }), 2, [])).toMatch(
      /keyword matcher/
    );
    expect(judgePlannerRecording(false, with_({ error: "boom" }), 2, [])).toMatch(
      /planning failed: boom/
    );
    expect(judgePlannerRecording(false, graph, 0, [])).toMatch(/empty recording/);
  });
});

describe("eval:record covers the appgen and planner cassettes", () => {
  it("targets: every task, every appgen intent and every planner intent, ids unique and prefixed", () => {
    const ids = recordTargets().map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((i) => i.startsWith("appgen/")).length).toBe(APPGEN_CASES.length);
    expect(ids.filter((i) => i.startsWith("planner/")).length).toBe(PLANNER_CASES.length);
    expect(ids.length).toBe(TASKS.length + APPGEN_CASES.length + PLANNER_CASES.length);
  });

  it("a dry run lists them and records nothing (no provider, no write)", async () => {
    const h = harness({ complete: async () => empty });
    expect(await runRecord([], { GEMINI_API_KEY: "k" }, h.d)).toBe(0);
    expect(h.text()).toMatch(/appgen\/new-ticket-router/);
    expect(h.text()).toMatch(/planner\/cpu-single/);
    expect(h.d.makeProvider).not.toHaveBeenCalled();
    expect(h.written).toEqual({});
  });

  it("refuses under CI and refuses an unknown S3 id, before building any provider", async () => {
    const a = harness({ complete: async () => empty });
    expect(
      await runRecord(["--live", "--task", "planner/cpu-single"], { ...env, CI: "true" }, a.d)
    ).toBe(1);
    expect(a.text()).toMatch(/refusing to record under CI/);
    const b = harness({ complete: async () => empty });
    expect(await runRecord(["--live", "--task", "appgen/nope"], env, b.d)).toBe(1);
    expect(b.text()).toMatch(/unknown task "appgen\/nope"/);
    const c = harness({ complete: async () => empty });
    expect(
      await runRecord(
        ["--live", "--task", "appgen/new-ticket-router"],
        { GEMINI_API_KEY: "k" },
        c.d
      )
    ).toBe(1);
    expect(c.text()).toMatch(/no model given/);
    for (const x of [a, b, c]) expect(x.d.makeProvider).not.toHaveBeenCalled();
  });

  it("a clean live run over a fake provider writes exactly the committed cassette (appgen and planner)", async () => {
    const appgen = APPGEN_CASES.find((c) => c.id === "edit-refunds-ui");
    const planner = PLANNER_CASES.find((c) => c.id === "cpu-fix-chain-repair");
    expect(appgen).toBeDefined();
    expect(planner).toBeDefined();
    for (const [id, script] of [
      [`appgen/${appgen?.id}`, appgen?.script],
      [`planner/${planner?.id}`, planner?.script],
    ] as const) {
      const run = script as NonNullable<typeof script>;
      const h = harness({ complete: async (req) => run(turnOf(req), req) });
      expect(await runRecord(["--live", "--task", id], env, h.d), id).toBe(0);
      expect(Object.keys(h.written)).toEqual([id]);
      const target = recordTargets().find((t) => t.id === id);
      expect(JSON.stringify(h.written[id])).toBe(
        JSON.stringify(JSON.parse(readFileSync(target?.path as string, "utf8")))
      );
    }
  });

  it("a provider error on an S3 target writes nothing, aborts the rest, never prints the key", async () => {
    const h = harness({
      complete: async () => {
        throw new Error("401 Unauthorized for key sekrit-key-123");
      },
    });
    expect(
      await runRecord(
        ["--live", "--task", "planner/cpu-single", "--task", "appgen/new-ticket-router"],
        env,
        h.d
      )
    ).toBe(1);
    expect(h.written).toEqual({});
    expect(h.text()).toMatch(/NOT WRITTEN.*provider error: 401/);
    expect(h.text()).toMatch(/aborting the remaining tasks/);
    expect(h.text()).not.toContain("sekrit-key-123");
  });

  it("no temp file is left in any cassette directory", () => {
    for (const t of recordTargets()) {
      expect(readdirSync(dirname(t.path)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    }
  });
});
