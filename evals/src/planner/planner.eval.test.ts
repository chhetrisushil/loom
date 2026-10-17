import { readdirSync } from "node:fs";
import { CassetteMissError, reportDigest } from "@loom/eval";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { serializeCassette } from "../cassetteFiles";
import { failingMetrics, toRows } from "../gate";
import { buildScoreboard, serializeScoreboard } from "../scoreboard";
import { PLANNER_CASES, type PlannerCase } from "./cases";
import { type SuiteRun, authorPlannerCassette, runPlannerSuite, store } from "./measure";
import { PLANNER_THRESHOLDS } from "./thresholds";

// ADR 0131 S3 (planner). The REAL `IntentRuntime.route` and `PlannerRuntime.planGraph` over the committed
// cassettes must clear the committed floors; each DEGRADATION must fall outside them and the failure must NAME the
// metric. Every degraded test sits beside the real run clearing the same gate. The planner prompts are pinned at
// their defaults (ADR 0126 makes them overridable; a cassette is keyed by the exact request).

const kase = (id: string): PlannerCase => {
  const c = PLANNER_CASES.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
};
const gate = (run: SuiteRun) => failingMetrics(run.scores, PLANNER_THRESHOLDS);
const swap = (id: string, data: ReturnType<typeof store.load>) => (c: PlannerCase) =>
  c.id === id ? data : store.load(c.id);
const isRouting = (system: string | undefined) =>
  system?.startsWith("You route a user's request") === true;

describe("planner eval (@loom/intent + @loom/planner, hand-authored cassettes)", () => {
  let real: SuiteRun;
  const fetchSpy = vi.fn(() => {
    throw new Error("network call during a replay eval");
  });

  beforeAll(async () => {
    vi.stubGlobal("fetch", fetchSpy);
    real = await runPlannerSuite();
  });
  afterAll(() => vi.unstubAllGlobals());

  it("sweep: at least 12 intents, a cassette for each and none orphaned, every graph shape present", () => {
    expect(PLANNER_CASES.length).toBeGreaterThanOrEqual(12);
    expect(new Set(PLANNER_CASES.map((c) => c.id)).size).toBe(PLANNER_CASES.length);
    const files = readdirSync(store.dir).filter((f) => !f.startsWith("."));
    expect(files.sort()).toEqual(PLANNER_CASES.map((c) => `${c.id}.json`).sort());
    const tags = new Set(PLANNER_CASES.flatMap((c) => c.tags));
    for (const t of ["single", "chain", "parallel", "fan-in", "binding", "repair", "refusal"]) {
      expect(tags.has(t), t).toBe(true);
    }
    // shapes really are present in the expected graphs, not just tagged
    const graphs = PLANNER_CASES.map((c) => c.graph).filter((g) => typeof g !== "string");
    expect(graphs.some((g) => g.length === 1)).toBe(true);
    expect(graphs.some((g) => g.some((n) => n.dependsOn.length >= 2))).toBe(true);
    expect(graphs.some((g) => g.length >= 2 && g.every((n) => n.dependsOn.length === 0))).toBe(
      true
    );
    expect(graphs.some((g) => g.some((n) => JSON.stringify(n.args).includes("$from")))).toBe(true);
  });

  it("the cassettes are exactly what the hand-written scripts produce (no hand-edited or stale file)", async () => {
    for (const c of PLANNER_CASES) {
      expect(serializeCassette(await authorPlannerCassette(c)), c.id).toBe(
        serializeCassette(store.load(c.id))
      );
    }
  });

  it("the real runtimes clear both floors; every graph is exactly the expected one", () => {
    expect(real.report.summary.errored).toBe(0);
    expect(real.scores.graphCorrectness).toBe(1);
    expect(gate(real)).toEqual([]);
    for (const c of PLANNER_CASES) {
      const o = real.outcomes.get(c.id);
      expect(o?.graph, c.id).toEqual(c.graph);
      expect(o?.error, c.id).toBeUndefined();
    }
  });

  it("plans really go through the runtimes: the repaired plan took a retry, the refusal used every attempt", () => {
    expect(real.outcomes.get("cpu-single")?.modelCalls).toBe(2); // one route call, one plan call
    expect(real.outcomes.get("cpu-fix-chain-repair")?.modelCalls).toBe(3); // + the repair round
    expect(real.outcomes.get("no-capability")?.modelCalls).toBe(1 + 3); // route + 3 bounded attempts
    expect(real.outcomes.get("no-capability")?.graph).toBe("refused:empty");
  });

  it("a replay makes zero network calls (and no live provider exists in this path)", () => {
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // FIXED 2026-10-17: a model's NONE is final. The router model answered NONE ("nothing fits") for the
  // off-topic `no-capability` request; `IntentRuntime.route` used to override that with its offline keyword
  // matcher (routing it to `diagnose-cpu` on shared words). The keyword matcher now runs only with no model configured.
  it("a model NONE is honoured: no keyword override, routeAccuracy is 12/12", () => {
    const o = real.outcomes.get("no-capability");
    expect(o?.route).toBeNull();
    expect(o?.routedBy).toBe("none");
    expect(o?.routerReply?.trim()).toBe("NONE");
    expect(real.scores.routeAccuracy).toBe(1);
    for (const c of PLANNER_CASES.filter((x) => x.id !== "no-capability")) {
      expect(real.outcomes.get(c.id)?.routedBy, c.id).toBe("model");
    }
  });

  describe("fail-proofs", () => {
    it("(a) a wrong graph fails EXACT equality, naming graphCorrectness (one wrong argument is enough)", async () => {
      const c = kase("cpu-single");
      const bad = await authorPlannerCassette(c, (turn, req) =>
        isRouting(req.system)
          ? { content: "diagnose-cpu", stopReason: "end_turn" }
          : {
              content: JSON.stringify({
                nodes: [
                  {
                    id: "cpu",
                    capabilityId: "diagnose-cpu",
                    args: { target: "billing-db" },
                    rationale: "x",
                  },
                ],
              }),
              stopReason: "end_turn",
            }
      );
      expect(bad).not.toEqual(store.load(c.id));
      const run = await runPlannerSuite({ cassette: swap(c.id, bad) });
      expect(run.outcomes.get(c.id)?.graph).not.toEqual(c.graph);
      const g = run.report.cases
        .find((x) => x.id === c.id)
        ?.graders.find((x) => x.grader === "graph");
      expect(g?.pass).toBe(false);
      expect(g?.detail).toMatch(/billing-db/);
      expect(run.scores.graphCorrectness).toBeCloseTo(11 / 12, 10);
      expect(gate(run)).toEqual(["graphCorrectness"]);
      expect(gate(real)).toEqual([]);
    });

    it("(a2) a missing edge, a dropped step and a wrong capability each fail exact equality", async () => {
      const c = kase("cpu-and-locks-parallel");
      const variants: Record<string, object[]> = {
        "an extra dependency edge": [
          { id: "cpu", capabilityId: "diagnose-cpu", args: { target: "ledger-db" } },
          {
            id: "locks",
            capabilityId: "diagnose-locks",
            args: { target: "ledger-db" },
            dependsOn: ["cpu"],
          },
        ],
        "a dropped step": [
          { id: "cpu", capabilityId: "diagnose-cpu", args: { target: "ledger-db" } },
        ],
        "a wrong capability": [
          { id: "cpu", capabilityId: "diagnose-cpu", args: { target: "ledger-db" } },
          { id: "locks", capabilityId: "diagnose-replica-lag", args: { target: "ledger-db" } },
        ],
      };
      for (const [what, nodes] of Object.entries(variants)) {
        const bad = await authorPlannerCassette(c, (_t, req) =>
          isRouting(req.system)
            ? { content: "diagnose-cpu", stopReason: "end_turn" }
            : { content: JSON.stringify({ nodes }), stopReason: "end_turn" }
        );
        const run = await runPlannerSuite({ cassette: swap(c.id, bad) });
        expect(run.outcomes.get(c.id)?.graph, what).not.toEqual(c.graph);
        expect(gate(run), what).toEqual(["graphCorrectness"]);
      }
    });

    it("(a3) a plan the validator rejects on every attempt is a typed refusal, not a graph, and fails the case", async () => {
      const c = kase("cpu-single");
      const bad = await authorPlannerCassette(c, (_t, req) =>
        isRouting(req.system)
          ? { content: "diagnose-cpu", stopReason: "end_turn" }
          : {
              content: JSON.stringify({
                nodes: [{ id: "x", capabilityId: "no-such-capability", args: {} }],
              }),
              stopReason: "end_turn",
            }
      );
      const run = await runPlannerSuite({ cassette: swap(c.id, bad) });
      expect(run.outcomes.get(c.id)?.graph).toBe("refused:invalid");
      expect(gate(run)).toEqual(["graphCorrectness"]);
    });

    it("(b) a wrong route fails routeAccuracy, and a model answer the router cannot use does not count as a route", async () => {
      const c = kase("cpu-single");
      const wrongRoute = await authorPlannerCassette(c, (_t, req) =>
        isRouting(req.system)
          ? { content: "diagnose-locks", stopReason: "end_turn" }
          : {
              content: JSON.stringify({
                nodes: [{ id: "cpu", capabilityId: "diagnose-cpu", args: { target: "orders-db" } }],
              }),
              stopReason: "end_turn",
            }
      );
      const a = await runPlannerSuite({ cassette: swap(c.id, wrongRoute) });
      expect(a.outcomes.get(c.id)?.route).toBe("diagnose-locks");
      expect(a.scores.routeAccuracy).toBeCloseTo(11 / 12, 10);
      expect(gate(a)).toEqual(["routeAccuracy"]);

      // The router replies with prose naming no capability: IntentRuntime routes nowhere (it no longer guesses by
      // keywords, which here would have picked the RIGHT capability), so the case is a miss, not a silent pass.
      const prose = await authorPlannerCassette(c, (_t, req) =>
        isRouting(req.system)
          ? { content: "Hmm, hard to say.", stopReason: "end_turn" }
          : {
              content: JSON.stringify({
                nodes: [{ id: "cpu", capabilityId: "diagnose-cpu", args: { target: "orders-db" } }],
              }),
              stopReason: "end_turn",
            }
      );
      const b = await runPlannerSuite({ cassette: swap(c.id, prose) });
      expect(b.outcomes.get(c.id)?.route).toBeNull();
      expect(b.outcomes.get(c.id)?.routedBy).toBe("none");
      expect(b.scores.routeAccuracy).toBeCloseTo(11 / 12, 10);
      expect(gate(b)).toEqual(["routeAccuracy"]);
      expect(gate(real)).toEqual([]);
    });

    it("(c) removing one cassette entry fails with CassetteMissError, never a live call", async () => {
      const data = store.load("cpu-fix-chain-repair"); // route + two plan attempts
      const keys = Object.keys(data);
      const holed = { ...data };
      delete holed[keys[2] as string];
      const run = await runPlannerSuite({ cassette: swap("cpu-fix-chain-repair", holed) });
      const c = run.report.cases.find((x) => x.id === "cpu-fix-chain-repair");
      expect(c?.status).toBe("errored");
      expect(c?.error).toMatch(/no recorded response for request/);
      expect(run.scores.graphCorrectness).toBeCloseTo(11 / 12, 10);
      expect(gate(run)).toEqual(expect.arrayContaining(["graphCorrectness", "routeAccuracy"]));
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(new CassetteMissError("k")).toBeInstanceOf(Error);
    });

    it("(d) two consecutive replays are byte-identical (scoreboard rows and report digest)", async () => {
      const again = await runPlannerSuite();
      const board = (r: SuiteRun) =>
        serializeScoreboard(
          buildScoreboard(toRows("planner/cassette", r.scores, PLANNER_THRESHOLDS))
        );
      expect(board(again)).toBe(board(real));
      expect(reportDigest(again.report)).toBe(reportDigest(real.report));
    });

    it("the floors sit where the thresholds file says (derived from the real run)", () => {
      const n = PLANNER_CASES.length;
      // floor = the score after ONE MORE lost case, rounded up to 4 dp: a single further loss fails, the measured passes
      expect(PLANNER_THRESHOLDS.graphCorrectness as number).toBeGreaterThan((n - 1) / n - 1e-9);
      expect(PLANNER_THRESHOLDS.graphCorrectness as number).toBeLessThanOrEqual(
        real.scores.graphCorrectness as number
      );
      expect(PLANNER_THRESHOLDS.routeAccuracy as number).toBeGreaterThan((n - 1) / n - 1e-9);
      expect(PLANNER_THRESHOLDS.routeAccuracy as number).toBeLessThanOrEqual(
        real.scores.routeAccuracy as number
      );
    });
  });
});
