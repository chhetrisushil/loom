# @loom/eval — use the event log as a test fixture, and grade model output

Two things, both offline. First, the log-as-fixture primitives: fold a recorded event log back into its
final state (`replayAsFixture`), diff two runs for golden-file regression (`diffRuns`), and score a
run. Second, a small evaluation harness: run a set of cases through a subject, grade each with exact,
regex, JSON Schema or LLM-judge graders, and get a report you can compare against a baseline. Model
calls in a suite are served from recorded cassettes, so a suite makes no live LLM or tool calls unless
you record. Use it in tests and CI; it is not a runtime component.

```ts
import { CassetteProvider, exactMatch, runEvalSuite } from "@loom/eval";
import type { CassetteData } from "@loom/eval";

declare const committed: CassetteData; // loaded from a committed cassette file
const provider = new CassetteProvider({ mode: "replay", data: committed });

const report = await runEvalSuite({
  name: "capitals",
  cases: [{ id: "fr", input: "Capital of France?", expected: "Paris" }],
  subject: async (question) => {
    const res = await provider.complete({ messages: [{ role: "user", content: question }] });
    return res.content;
  },
  graders: [exactMatch({ normalize: true })],
});

console.log(report.summary.passRate, report.summary.meanScore);
```

## Surface

- **Log as fixture.** `replayAsFixture(log)` returns the final `ExecutionState` with no live calls.
  `recordedStepOutputs(log)` returns `stepId -> output`. `diffRuns(golden, candidate)` reports changes in
  status, final output and each step's recorded output. `scoreRun(state, scorers)` runs named scorers.
- **Suites.** `runEvalSuite({ name, cases, subject, graders, passScore?, concurrency?, versions? })`
  returns an `EvalSuiteReport`. `flowSubject({ start })` is a subject that runs a flow to completion.
  `formatSuiteReport`, `reportDigest` and `compareReports(baseline, candidate, { tolerance? })` read the
  result.
- **Graders.** `exactMatch`, `regexMatch`, `jsonSchema` (JSON Schema or a zod-style `safeParse`), and
  `llmJudge`. A grader can be weighted or `required`.
- **Cassettes.** `CassetteProvider` (`replay` or `record`) and `stubProvider(fn)`.

## Behaviour that surprises people

- **A cassette miss fails loudly.** In replay mode, a request with no recording throws
  `CassetteMissError` rather than calling a model. After you change a prompt, a model parameter or a
  case input, re-record. Recording needs an `inner` provider and is on demand.
- **`diffRuns` compares JSON text.** It stringifies values, so two equal objects with keys in a
  different order read as a difference. `exactMatch` is key-order independent.
- **An errored case scores 0 and stays in the mean.** A case that throws never silently drops out.
  `flowSubject` rejects for a flow that did not complete.
- **Judges are strict.** `llmJudge` fails the case unless the reply is JSON with a finite `score` in
  0 to 1. With the `{ decide, toolId }` form the judge call is authorized, recorded and replayed
  (ADR 0119), so re-grading an old run does not call the model.
- **`jsonSchema` fails on a keyword it does not support** instead of passing unchecked.
- **A suite is a pure function of its inputs:** no clock, no randomness, cases reported in order.

## Status / See also

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override
(see [AGENTS.md](../../AGENTS.md)).

- [ADR 0124](../../docs/adr/0124-learning-lifecycle.md) (the evaluation harness) and
  [ADR 0131](../../docs/adr/0131-loom-own-evals.md) (loom's own evals).
- CLI: `loom eval --dir <path>` replays golden logs against expectations
  ([docs/usage-cli.md](../../docs/usage-cli.md)).
- API reference: section "`@loom/eval` — log-as-fixture evals" in
  [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [docs/user-guide.md](../../docs/user-guide.md), [docs/README.md](../../docs/README.md).
