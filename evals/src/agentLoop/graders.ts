import { type CaseRun, type Grader, exactMatch, jsonSchema, regexMatch } from "@loom/eval";
import { z } from "zod";
import type { TaskOutput } from "./subject";
import type { Expected } from "./tasks";

// Three REQUIRED graders per task, all deterministic (no `llmJudge` anywhere in the gate):
//   - answer:  `regexMatch` on the final answer (or, for a run that must fail, on the failure text),
//   - tools:   `exactMatch` on the tool-call sequence (what the loop dispatched and what actually ran),
//   - outcome: `jsonSchema` on the run's shape (status, parked, refunds, feedback errors, concurrency, budget).
// Each is a thin per-case adapter: the pattern, sequence and schema come from the case's `expected`.

const exp = (r: CaseRun): Expected => r.case.expected as Expected;
const out = (r: CaseRun): TaskOutput => r.output as TaskOutput;

export const answerGrader: Grader = {
  name: "answer",
  grade(run) {
    const e = exp(run);
    const o = out(run);
    const text = e.status === "failed" ? (o.error ?? "") : o.answer;
    return regexMatch(new RegExp(e.answer, "i")).grade({ case: run.case, output: text });
  },
};

export const toolsGrader: Grader = {
  name: "tools",
  grade(run) {
    const e = exp(run);
    const o = out(run);
    return exactMatch().grade({
      case: { ...run.case, expected: { dispatched: e.dispatched, executed: e.executed } },
      output: { dispatched: o.dispatched, executed: o.executed },
    });
  },
};

export const outcomeGrader: Grader = {
  name: "outcome",
  grade(run) {
    const e = exp(run);
    const schema = z.object({
      status: z.literal(e.status),
      parked: z.literal(e.parked),
      refunds: z.literal(e.refunds),
      feedbackErrors: z.literal(e.feedbackErrors),
      peakConcurrency: z.number().min(e.minConcurrency),
      steps: e.exactSteps === undefined ? z.number() : z.literal(e.exactSteps),
    });
    const o = out(run);
    return jsonSchema(schema).grade({
      case: run.case,
      output: {
        status: o.status,
        parked: o.parked,
        refunds: o.refunds,
        feedbackErrors: o.feedbackErrors,
        peakConcurrency: o.peakConcurrency,
        steps: o.steps,
      },
    });
  },
};

export const GRADERS = [
  { grader: answerGrader, required: true },
  { grader: toolsGrader, required: true },
  { grader: outcomeGrader, required: true },
] as const;
