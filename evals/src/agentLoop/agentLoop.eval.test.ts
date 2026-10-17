import { readdirSync } from "node:fs";
import { CassetteMissError, CassetteProvider, reportDigest } from "@loom/eval";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { exceedingMetrics, failingMetrics, toRows } from "../gate";
import { buildScoreboard, serializeScoreboard } from "../scoreboard";
import { CASSETTE_DIR, authorCassette, loadCassette, serializeCassette } from "./cassettes";
import { type SuiteRun, runAgentLoopSuite } from "./measure";
import { type Script, TASKS, type Task } from "./tasks";
import { AGENT_LOOP_CEILINGS, AGENT_LOOP_THRESHOLDS } from "./thresholds";

// ADR 0131 S2. The REAL loop over the committed cassettes must clear the committed floor and ceilings; each
// DEGRADATION (verification (a) to (d)) must fall outside them and the failure must NAME the metric. Every
// degraded test sits beside the real run clearing the same gate, so the failure is the degradation.

const task = (id: string): Task => {
  const t = TASKS.find((x) => x.id === id);
  if (t === undefined) throw new Error(`no task ${id}`);
  return t;
};
const failed = (run: SuiteRun) =>
  run.report.cases.filter((c) => c.status !== "passed").map((c) => c.id);
const gate = (run: SuiteRun) => ({
  floors: failingMetrics(run.scores, AGENT_LOOP_THRESHOLDS),
  ceilings: exceedingMetrics(run.scores, AGENT_LOOP_CEILINGS),
});
/** The committed cassettes, with one task's replaced. */
const swap = (id: string, data: ReturnType<typeof loadCassette>) => (t: Task) =>
  t.id === id ? data : loadCassette(t.id);

describe("agentLoop$ task eval (ADR 0121, hand-authored cassettes)", () => {
  let real: SuiteRun;
  const fetchSpy = vi.fn(() => {
    throw new Error("network call during a replay eval");
  });

  beforeAll(async () => {
    vi.stubGlobal("fetch", fetchSpy);
    real = await runAgentLoopSuite();
  });
  afterEach(() => undefined);

  it("sweep: at least 12 tasks, a cassette for each and none orphaned, every behaviour class present", () => {
    expect(TASKS.length).toBeGreaterThanOrEqual(12);
    const files = readdirSync(CASSETTE_DIR).filter((f) => f.endsWith(".json"));
    expect(files.sort()).toEqual(TASKS.map((t) => `${t.id}.json`).sort());
    const tags = new Set(TASKS.flatMap((t) => t.tags));
    for (const t of [
      "lookup",
      "parallel",
      "feedback",
      "approval",
      "no-tool",
      "tool-search",
      "terminal",
      "budget",
    ]) {
      expect(tags.has(t)).toBe(true);
    }
  });

  it("the cassettes are exactly what the hand-written scripts produce (no hand-edited or stale file)", async () => {
    for (const t of TASKS) {
      expect(serializeCassette(await authorCassette(t)), t.id).toBe(
        serializeCassette(loadCassette(t.id))
      );
    }
  });

  it("the real loop passes every task and clears the floor and both ceilings", () => {
    expect(failed(real)).toEqual([]);
    expect(real.report.summary.errored).toBe(0);
    expect(gate(real)).toEqual({ floors: [], ceilings: [] });
  });

  it("a terminal error FAILS the run and is never fed back (quota stop, capability denial)", () => {
    for (const id of ["quota-stop", "denied-tool"]) {
      const o = real.outputs.get(id);
      expect(o?.status, id).toBe("failed");
      expect(o?.steps, id).toBe(1); // the model was never asked again
      expect(o?.feedbackErrors, id).toBe(0);
    }
  });

  it("a replay makes zero network calls (and no live provider exists in this path)", () => {
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe("fail-proofs", () => {
    it("(a) removing one cassette entry fails with CassetteMissError, never a live call", async () => {
      const data = loadCassette("sequential-dependent");
      const [dropped] = Object.keys(data).slice(1);
      const holed = { ...data };
      delete holed[dropped as string];
      // The provider itself:
      const cp = new CassetteProvider({ mode: "replay", data: holed });
      const run = await runAgentLoopSuite({ cassette: swap("sequential-dependent", holed) });
      const c = run.report.cases.find((x) => x.id === "sequential-dependent");
      expect(c?.status).toBe("errored");
      expect(c?.error).toMatch(/no recorded response for request/);
      expect(failed(run)).toEqual(["sequential-dependent"]);
      expect(gate(run).floors).toContain("successRate");
      await expect(
        cp.complete({ messages: [{ role: "user", content: "never recorded" }] })
      ).rejects.toBeInstanceOf(CassetteMissError);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("(b) a cassette encoding a wrong tool choice scores a failed task and a success rate below the gate", async () => {
      const wrong: Script = (turn) =>
        turn === 0
          ? {
              content: "looking",
              toolCalls: [{ id: "c0", name: "lookup_customer", input: { order: 1042 } }],
              stopReason: "tool_use",
            }
          : { content: "Order 1042 (a desk lamp, $49) is delivered.", stopReason: "end_turn" };
      const bad = await authorCassette(task("single-lookup"), wrong);
      expect(bad).not.toEqual(loadCassette("single-lookup"));
      const run = await runAgentLoopSuite({ cassette: swap("single-lookup", bad) });
      expect(failed(run)).toEqual(["single-lookup"]);
      const graders = run.report.cases.find((x) => x.id === "single-lookup")?.graders ?? [];
      expect(graders.filter((g) => !g.pass).map((g) => g.grader)).toEqual(["tools"]);
      expect(run.scores.successRate).toBeCloseTo(12 / 13, 10);
      expect(run.scores.successRate).toBeLessThan(real.scores.successRate as number);
      expect(gate(run).floors).toEqual(["successRate"]);
    });

    it("(c) two consecutive replays are byte-identical (scoreboard and report digest)", async () => {
      const again = await runAgentLoopSuite();
      const board = (r: SuiteRun) =>
        serializeScoreboard(
          buildScoreboard(
            toRows("agentLoop/cassette", r.scores, AGENT_LOOP_THRESHOLDS, AGENT_LOOP_CEILINGS)
          )
        );
      expect(board(again)).toBe(board(real));
      expect(reportDigest(again.report)).toBe(reportDigest(real.report));
    });

    it("(d1) parallelTools off fails the tasks that need tools in flight together, naming successRate", async () => {
      const run = await runAgentLoopSuite({ degrade: { parallelTools: false } });
      expect(failed(run).sort()).toEqual(["search-then-parallel", "two-parallel"]);
      expect(gate(run).floors).toEqual(["successRate"]);
    });

    it("(d2) tool failures that fail the run (toolErrors: fail) fail the isError-feedback tasks", async () => {
      const run = await runAgentLoopSuite({ degrade: { toolErrors: "fail" } });
      expect(failed(run).sort()).toEqual(["flaky-explain", "flaky-recover"]);
      expect(gate(run).floors).toEqual(["successRate"]);
    });

    it("(d3) a step budget that is too low cuts the multi-turn tasks off, naming successRate", async () => {
      const run = await runAgentLoopSuite({ degrade: { maxIterations: 2 } });
      expect(failed(run).length).toBeGreaterThanOrEqual(5);
      expect(gate(run).floors).toEqual(["successRate"]);
      // the budget task itself asked for 3 and is now cut to 2
      expect(run.outputs.get("step-budget")?.steps).toBe(2);
    });

    it("(d4) a chattier loop (extra model calls and tool calls) exceeds the step and tool-call ceilings", async () => {
      const chatty: Script = (turn) =>
        turn < 3
          ? {
              content: "again",
              toolCalls: [{ id: `c${turn}`, name: "lookup_order", input: { order: 1042 } }],
              stopReason: "tool_use",
            }
          : { content: "Order 1042 (a desk lamp, $49) is delivered.", stopReason: "end_turn" };
      const noisy = await authorCassette(task("single-lookup"), chatty);
      const run = await runAgentLoopSuite({ cassette: swap("single-lookup", noisy) });
      expect(gate(run).ceilings.sort()).toEqual(["meanSteps", "meanToolCalls"]);
      // and ONE extra call is enough: the ceilings are one call above the measured means
      expect(32 / 13).toBeGreaterThan(AGENT_LOOP_CEILINGS.meanSteps as number);
      expect(24 / 13).toBeGreaterThan(AGENT_LOOP_CEILINGS.meanToolCalls as number);
    });
  });
});
