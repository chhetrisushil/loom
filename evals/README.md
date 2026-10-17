# @loom/evals-internal

Loom's own evals ([ADR 0131](../docs/adr/0131-loom-own-evals.md)). Private and unpublished: it exports nothing and no
runtime package imports it.

Unit tests and DST check that loom is CORRECT. They cannot see a change that makes a quality decision WORSE while every
assertion stays green: a ranker weight, a stoplist, a tokenizer, a backend's scoring. An eval measures a population of
labelled cases and fails when the score drops.

## What is here (slice S1: retrieval, no model)

| Area | Subject | Metrics |
| --- | --- | --- |
| `src/toolSearch/` | `search_tools` through the public `ToolSearchSession`: built-in BM25F, default stoplist, host annotations, a custom ranker factory | recall@3, recall@5, MRR (overall and per slice), page precision on function-word queries |
| `src/retrieval/` | `MemoryStore.search` and `KnowledgeBase.retrieve` on EVERY backend: `InMemoryMemoryStore`, `SqliteMemoryStore`, `PostgresMemoryStore` | recall@5, nDCG@10 |
| `src/skills/` | skill discovery (`discovery: "search"`), single index and two-ranker mode | hit@1, hit@3 |

## A threshold is a tripwire, not a quality claim

The datasets are small (about 30 to 50 cases each) and hand-written. A floor says "this did not get worse than the day it
was set", never "this is good". Each `thresholds.ts` records the measured value, the margin (measured minus 0.02, a bit
under one flipped case) and the reason beside every number. Lowering a floor needs a one-line reason in the PR and in the
file; raising is free.

## Running

```sh
pnpm eval                    # measure everything, write evals/out/scoreboard.{json,md}, print the delta vs evals/baseline/
pnpm eval:update-baseline    # rewrite evals/baseline/ (a reviewed diff)
pnpm --filter @loom/evals-internal test   # the gates: scores against thresholds, plus every fail-proof
```

The gates are ordinary vitest files, so `pnpm test` / turbo runs them. The Postgres leg needs `LOOM_TEST_POSTGRES_URL`
(CI sets it; each package gets its own database). Without it the leg is skipped with a printed reason and the sweep still
insists that at least two backends ran; `pnpm eval` then reports the Postgres metrics as `not-run` against the baseline.

`scoreboard.json` is byte-stable (sorted keys, 4 decimals, no timestamps or paths): two runs over the same code and data
produce identical bytes.

## Every gate is shown to fire

Each gate has a committed negative test that injects a degradation, asserts the score falls below the floor AND names the
failing metric, and sits next to the real implementation clearing the same floor (so the failure is the degradation, not a
broken harness): a reversed ranker, an emptied stoplist, ignored annotations, a degraded `queryTerms` on each backend,
shuffled skill descriptions. `datasets.sweep.test.ts` discovers the datasets by walking the directory and asserts a
non-zero count, a `PROVENANCE.md` in each, and no email or token-shaped string.

## Adding a case

1. Write the query (or tool, document, skill) from the USER side, then label it by reading the descriptions or documents,
   BEFORE running any ranker over it. Labels that follow the ranker make the gate vacuous.
2. Never edit an existing label after seeing a score, except to fix an objective labelling error; list the edit and its reason
   in that area's `PROVENANCE.md`.
3. Run `pnpm eval`, then `pnpm eval:update-baseline`, and review the baseline diff.
4. Datasets are synthetic or public-domain text only. No real user data (the sweep rejects emails and token-shaped strings).
