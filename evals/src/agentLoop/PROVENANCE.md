# Provenance: agentLoop$ task dataset (slice S2)

- **Files:** `tasks.ts` (13 scripted tasks, each with a hand-written model script and an `expected` outcome),
  `cassettes/*.json` (one cassette per task), `world.ts` (the synthetic tools), `graders.ts`, `subject.ts`.
- **Labeller:** Claude Opus 5.5 (1M context), as the implementing agent of ADR 0131 slice S2, for the repo owner.
- **Date:** 2026-10-17.
- **Source:** original synthetic text. The scenario shapes follow the sibling `loom-examples` `agent-loop-triage`
  example and the behaviours ADR 0121 documents (feedback not failure, terminal authority and quota errors, parallel
  scope, approval park and resume in a fresh runtime, step budget). No real user data, no third-party text.

## THE CASSETTES ARE HAND-AUTHORED. NO MODEL WAS CALLED.

Every model response in `cassettes/` was written by hand as a script in `tasks.ts` (what a sensible model would say at
each turn), then `pnpm eval:author` ran the REAL `agentLoop$` over that script through a `CassetteProvider` in record
mode and stored each request/response pair. No provider, no network and no API key was involved, and the user has not
approved live recording. A test (`agentLoop.eval.test.ts`) regenerates every cassette from its script and requires the
committed file to match byte for byte, so a hand-edited or stale cassette cannot hide.

**What this measures:** the loop's handling of model behaviour. Given a model that asks for these tools in this order,
does `agentLoop$` dispatch them, run independent calls in one parallel scope, feed a flaky tool's failure back as an
`isError` result and let the model recover, stop a terminal quota or capability error without asking the model again,
park a refund on an approval and resume it in a new runtime without re-running what was consumed, search before
loading a tool, answer without calling a tool, and stop at its step budget?

**What it does NOT measure:** a model's quality. The "model" is a script that always does the sensible thing, so nothing
here says whether a real model picks the right tool, retries sensibly or answers well. Success is therefore close to
1.0 by construction, and the gates are tripwires for the LOOP regressing (see `thresholds.ts`). A cassette also pins the
exact request the loop sends (system prompt, tool menu, transcript shape): a legitimate prompt or menu change MISSES,
which is the signal; regenerate with `pnpm eval:author` and review the diff.

## Re-recording live (on demand only, with Gemini)

`pnpm eval:record` is the only code in `evals/` that can reach a model. It is a dry run unless `--live` is passed, and
it refuses under `CI=true`. It uses loom's own `GeminiProvider` from `@loom/llm` (the adapter behind the CLI's
`--model gemini:<m>`), with the key from `GEMINI_API_KEY` (else `GOOGLE_API_KEY`), never printed. No model name is
assumed.

```sh
export GEMINI_API_KEY=...                                     # real tokens are spent; about 3 calls per task
pnpm eval:record                                              # dry run: lists the cassettes it would rewrite
pnpm eval:record --live --model gemini:<model-id> --task flaky-recover   # one task, selectively
LOOM_EVAL_RECORD_MODEL=gemini:<model-id> pnpm eval:record --live          # every task
```

It writes cassettes only, and only a clean recording replaces a committed one: a provider error (bad key, 429,
wrong model id), an empty or short recording, or a task that ends differently than `expected.status` is refused
with the reason (the key is never printed), the committed cassette is left untouched, and the exit code is 1. A
provider error also stops the remaining tasks; an outcome mismatch skips only that task. Then review the cassette diff like any other diff, run `pnpm eval`, and, if the scores moved
on purpose, `pnpm eval:update-baseline` (and revisit `thresholds.ts` with a reason). A live cassette measures the
loop PLUS that model's behaviour on these prompts; the hand-authored script is no longer the model, so some tasks may
legitimately fail and need their `expected` reviewed.

## Label rules

1. Each task's `expected` is written from the SCRIPT's intent (what a correct loop must do with it), before the loop
   was run over it: the final-answer pattern, the dispatched and executed tool sequences, whether it parks, refunds
   issued, error feedbacks, and the minimum concurrency for a parallel turn.
2. Three required graders per task, no `llmJudge`: `answer` (`regexMatch`), `tools` (`exactMatch` on the sequences),
   `outcome` (`jsonSchema` on status, parked, refunds, feedback errors, concurrency, and the exact step count for the
   budget task).
3. A run that must FAIL (quota stop, capability denial) is expected as `failed`, with the failure text matched; the
   model must not be asked a second time (`steps` is 1).

## Tasks that pin current behaviour

`step-budget` and `denied-tool` pin what the loop does TODAY, as a tripwire, not as a judgement that it is right:
a budget stop (`maxIterations`) ends the run as `completed` with the last assistant text (not as a failure), and a
capability denial fails the run without feeding the denial back to the model. If either behaviour is changed on
purpose, these tasks and their `expected` change in the same reviewed diff.

## Label edits after measurement

None. (Each edit, if one ever happens, must be listed here with its reason, and only for an objective labelling
error, never to move a score.)

- **Adding a task:** write the prompt and script, write `expected` from the script's intent, run `pnpm eval:author`,
  then `pnpm eval` and `pnpm eval:update-baseline`; thresholds change only as a reviewed diff with a reason.
- **Limits:** 13 tasks over scripted transcripts is a tripwire for loop regressions, not a claim about absolute quality.
