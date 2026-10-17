import type { AgentLoopConfig } from "@loom/agent";
import {
  type CassetteData,
  CassetteProvider,
  type EvalCase,
  type EvalSuiteReport,
  runEvalSuite,
} from "@loom/eval";
import { type Scores, type Thresholds, toRows } from "../gate";
import { mean } from "../metrics";
import type { MetricRow } from "../scoreboard";
import { loadCassette } from "./cassettes";
import { GRADERS } from "./graders";
import { type TaskOutput, agentLoopSubject } from "./subject";
import { TASKS, type Task } from "./tasks";

// ── The agentLoop$ subject ────────────────────────────────────────────────────
//
// Every task runs the real loop over its committed cassette (`CassetteProvider`, replay: a miss throws, nothing
// is ever called live). Scores are over the whole task set:
//   successRate    tasks that passed all three graders, over ALL tasks (an errored task counts as a failure)
//   meanSteps      model calls per task                      (a COST: gated by a ceiling)
//   meanToolCalls  tool calls the model asked for per task   (a COST: gated by a ceiling)

export interface SuiteOptions {
  readonly tasks?: readonly Task[];
  /** The cassette data per task (default: the committed file). The fail-proofs swap in a doctored one. */
  readonly cassette?: (task: Task) => CassetteData;
  /** Loop config a degraded run layers over each task's own. */
  readonly degrade?: Partial<AgentLoopConfig>;
}

export interface SuiteRun {
  readonly report: EvalSuiteReport;
  readonly outputs: ReadonlyMap<string, TaskOutput>;
  readonly scores: Scores;
}

export async function runAgentLoopSuite(o: SuiteOptions = {}): Promise<SuiteRun> {
  const tasks = o.tasks ?? TASKS;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const outputs = new Map<string, TaskOutput>();
  const data = o.cassette ?? ((t: Task) => loadCassette(t.id));
  const subject = agentLoopSubject(
    (input) => new CassetteProvider({ mode: "replay", data: data(byId.get(input.id) as Task) }),
    o.degrade
  );
  const cases: EvalCase<Task>[] = tasks.map((t) => ({
    id: t.id,
    input: t,
    expected: t.expected,
    tags: t.tags,
  }));
  const report = await runEvalSuite({
    name: "agentLoop",
    cases,
    subject: async (input, c) => {
      const out = await subject(input, c);
      outputs.set(c.id, out);
      return out;
    },
    graders: GRADERS,
  });
  const outs = [...outputs.values()];
  const scores: Scores = {
    successRate: report.summary.passRate,
    meanSteps: mean(outs.map((x) => x.steps)),
    meanToolCalls: mean(outs.map((x) => x.toolCalls)),
  };
  return { report, outputs, scores };
}

export async function measureAgentLoop(
  floors: Thresholds,
  ceilings: Thresholds,
  o: SuiteOptions = {}
): Promise<MetricRow[]> {
  const { scores } = await runAgentLoopSuite(o);
  return toRows("agentLoop/cassette", scores, floors, ceilings);
}
