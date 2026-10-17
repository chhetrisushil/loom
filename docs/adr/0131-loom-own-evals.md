# ADR 0131 — Loom's own evals: quality gates for the first-party agentic layer

- Status: **Accepted** (2026-10-17) — user approved and scheduled slice S1 2026-10-17.
- Date: 2026-10-17
- Builds on: [ADR 0008](0008-evals-and-deploy-simulation.md) (`@loom/eval`, `@loom/deploy-sim`),
  [ADR 0124](0124-learning-lifecycle.md) (the LLM evaluation harness: graded suites, cassette providers),
  [ADR 0078](0078-exploration-in-the-routing-seam.md)–[0080](0080-learning-substrate.md) (`@loom/learning` offline evaluation and `promotionGate`),
  [ADR 0125](0125-tool-search.md) (tool search, D13/D15), [ADR 0121](0121-one-canonical-agent-loop.md) (`agentLoop$`),
  [ADR 0090](0090-knowledge-is-retrieval-over-memory.md) / [0091](0091-corpus-lifecycle-and-the-knowledge-package.md) / [0085](0085-untrusted-content-integrity-axis.md) (memory and knowledge retrieval),
  [ADR 0033](0033-spi-conformance-contracts.md) (conformance kits).
- Gate: [ADR 0083](0083-second-consumer-rule.md) (the second-consumer rule, satisfied below).
- Placement: **repo-internal, unpublished.** Kernel change ZERO. No new published package, no new exported vocabulary.
- Version impact: none (`EVENT_SCHEMA`, every SPI and `KERNEL_ABI` unchanged).

## Context

Loom ships eval TOOLING for the apps built on it: `@loom/eval` (`replayAsFixture`, `diffRuns`, `scoreRun`, and the
graded-suite harness `runEvalSuite` with `exactMatch` / `regexMatch` / `jsonSchema` / `llmJudge` graders over a
`CassetteProvider`; ADR 0008 and 0124), the `loom eval --dir <path>` CLI verb, `@loom/deploy-sim`, and the offline policy
evaluation and `promotionGate` of `@loom/learning` (`evaluatePolicy`). It has no evals of ITSELF. Its self-checks are all
about correctness: unit tests, deterministic simulation (`tools/dst`), SPI conformance kits (ADR 0033) and a throughput bench
(`tools/bench-throughput`). There is no `evals/` directory and no `*.eval.ts` file.

Correctness checks cannot see one failure class. Parts of the first-party agentic layer make QUALITY decisions: which tools
`search_tools` returns for a query (the lexical ranker, the stoplist, host annotations, a custom ranker factory), which
passages `MemoryStore.search` ranks first (`queryTerms`, per-backend scoring), which skill an intent activates, how
`agentLoop$` chooses and sequences tools, and what plan `@loom/appgen` / `@loom/appgen-model` or the intent and planner
runtimes produce. A change to a prompt, a tokenizer, a stoplist or a scoring weight can make these worse while every
assertion stays green, because each test asserts a hand-picked example and none measures a population. The ADR 0125 D15
example ("bill the customer" finds `charge_invoice` alone) is a single case that passes today and says nothing about the
other forty queries a reshuffled ranker may now get wrong.

The kernel is not in this class. It is deterministic, and tests plus DST cover it. The proposal is scoped to the layers where
quality, not correctness, is the property that can regress.

## Decision

### D1 — Placement: a repo-internal eval workspace, kernel untouched

Evals live in an unpublished pnpm workspace package (working name `@loom/evals-internal`, `"private": true`) under `evals/`,
one directory per area (`evals/tool-search/`, `evals/retrieval/`, and so on). It is added to `pnpm-workspace.yaml` and run
with `pnpm eval`. It publishes nothing and exports no vocabulary, so it needs no `@loom/spec` registry entry.

Verdict by the placement litmus: kernel ZERO (nothing here changes a log, an SPI or an ABI); 1P package NO (no app consumes
it); repo-internal workspace YES (it is a development gate, like the DST runs and the fitness tests).

### D2 — Second consumer (ADR 0083)

The rule gates ADDING first-party surface. This adds none, but it adds a consumer: who is the second consumer of the
`@loom/eval` harness? Today it has one, apps (and the `loom eval` verb over golden logs). Loom's own agentic layer becomes
the second, unrelated one. A retrieval ranker scored by recall and MRR has nothing to do with an app's golden-log replay, and
exercising `runEvalSuite`, `compareReports` and `reportDigest` against loom's own corpora is how the harness finds the limits
its first consumer did not (for example a rank metric it cannot yet express). The gate is satisfied.

### D3 — Targets and metrics

| Target | Metric | Mode |
|---|---|---|
| `agentLoop$` tool search: `search_tools`, stoplist, annotations, custom ranker factory (ADR 0125 D13/D15) | recall@k, MRR over labelled query to tool-set pairs (for example "bill the customer" to `charge_invoice` only) | deterministic, no model |
| Memory and `@loom/knowledge` retrieval: `MemoryStore.search`, `queryTerms` (ADR 0085/0090/0091) | recall@k, nDCG over a labelled corpus, on EVERY backend (`InMemoryMemoryStore`, `SqliteMemoryStore`, `PostgresMemoryStore` via the per-package test DB) | deterministic |
| Skill discovery: `activate_skill`, `discovery: "search"` | the right skill surfaces for an intent (hit@1, hit@k) | deterministic |
| `agentLoop$` behaviour: tool choice, parallel tools, approvals, `isError` feedback (ADR 0121) | task success, step count, tool-call count on scripted tasks | model, cassette replay |
| `@loom/appgen` and the `@loom/appgen-model` planner | plan validity (the generated app builds and typechecks), intent coverage | model, cassette replay |
| Intent to planner (the `db-command-center` pattern: `IntentRuntime`, `PlannerRuntime`) | the correct agent graph for an intent | model, cassette replay |

The retrieval metrics (recall@k, MRR, nDCG, hit@k) are small pure functions that live in the eval workspace. They are not
exported from `@loom/eval`; promoting them is a separate decision under ADR 0083 once a third consumer exists.

### D4 — Policy

1. **Deterministic retrieval evals are regression gates in the normal suite.** They run under `pnpm test` as ordinary vitest
   files, assert the measured score against a committed threshold, and fail the build on a drop. A threshold change is a
   reviewed diff that states its reason.
2. **Model evals replay cassettes by default.** `CassetteProvider` makes them deterministic, free and CI-safe. A cassette miss
   is a failure (`CassetteMissError`), never a silent live call.
3. **Live re-recording is manual only**: `pnpm eval:record`. It is never scheduled and never runs in CI. GitHub Actions
   minutes are a budget (AGENTS.md), and a scheduled live run would also move the baseline without a reviewed diff.
4. **Reports are scores, not just pass/fail.** Each run writes a scoreboard JSON and a markdown summary, diffable against the
   last committed baseline (`compareReports` / `reportDigest` for the model suites).
5. **Evals obey the AGENTS.md test rules**: wait on conditions, no `performance.now()`, no wall-clock ratios, no fixed sleeps.
   Latency and cost belong in `*.perf.test.ts`, not here.
6. **Datasets are small, hand-labelled and committed**, each with a provenance note (who labelled it, from what source, when).
   No dataset contains real user data; synthetic and public-domain text only.

### D5 — Slices

- **S1 retrieval evals** (tool search, memory and knowledge across every backend, skill discovery), plus the workspace, the
  scoreboard and the first committed baseline.
- **S2 `agentLoop$` task evals** over cassettes.
- **S3 appgen and planner evals** over cassettes.

One PR per slice. The implementation plan is kept outside the repository tree.

## Consequences

- A prompt, tokenizer, stoplist or scoring change now has a number attached. The reviewer sees "recall@5 0.91 to 0.88" in the
  diff instead of a user discovering it.
- The retrieval gates add test time and, for the Postgres backend, depend on the per-package test database. They are
  deterministic and bounded by small datasets.
- Datasets are a maintenance cost and a new place for drift. The provenance rule and the reviewed-threshold rule are the
  controls.
- Small datasets overfit. A threshold is a tripwire for regression, not a claim of absolute quality, and the workspace docs
  must say so.
- Cassettes go stale when a prompt legitimately changes. A cassette miss is the signal; re-recording is a deliberate manual
  step whose result is reviewed.
- The harness gains a second consumer, which is the point: its API is shaped by two unrelated users.

## Alternatives considered

- **Evals only in `loom-examples`.** Examples teach usage patterns and run in a separate repo against unpublished packages
  through `link:`. A framework regression would be caught a repo and a release later, and an example is a demonstration, not
  a measurement. Rejected as the home; examples remain good sources of scenarios.
- **An external eval platform.** Adds a service, credentials and data egress for tiny offline corpora, and its results would
  not gate a pull request locally. It would also leave `@loom/eval` without a second consumer. Rejected.
- **LLM-judge everything.** Retrieval has labelled ground truth, so a judge adds cost and noise where a deterministic metric is
  exact. The judge grader stays for the open-ended model targets only. Rejected for retrieval.
- **Do nothing.** Keeps today's blind spot: quality regressions in the ranking and planning layers ship while tests are green.
  Rejected.

## Verification

Every gate must be shown to fire. A threshold that nothing can fail is the vacuous-check pattern.

- **S1.** (a) The committed baseline reproduces from a clean checkout. (b) A deliberately degraded ranker (for example the
  tool-search ranker returning results in reverse order, or the stoplist emptied) runs through the same eval and the test
  FAILS below threshold; the negative case is a committed test that injects the degradation and asserts the failure and the
  failing metric's name. (c) The same for a degraded `queryTerms` against each backend. (d) The sweep that discovers the
  datasets and backends asserts it found a non-zero number of each, so an empty directory cannot pass.
- **S2.** (a) Replay with the committed cassettes passes with identical scores on two consecutive runs. (b) Removing one
  cassette entry fails with `CassetteMissError`, never a live call. (c) A scripted task whose cassette encodes a wrong tool
  choice scores as a failure.
- **S3.** (a) Cassette replay is deterministic. (b) A cassette that encodes an invalid plan is reported as invalid, with the
  build or typecheck failure surfaced. (c) A plan missing a required intent element lowers the coverage score.
- **All slices.** The scoreboard diff against the committed baseline is exercised by changing one score and asserting the diff
  names it. `pnpm lint`, `pnpm typecheck:tests` and the spec guard tests stay green; the workspace gets a
  `tsconfig.test.json` as AGENTS.md requires.

## Open questions

1. ~~Where thresholds live: a per-eval file beside each dataset, or one `baseline.json` for the whole workspace.~~ **Resolved 2026-10-17 (slice S1):** thresholds live in a per-area `thresholds.ts` beside the dataset (a reviewer sees the number, its measured value, its margin and its reason next to the data); the scoreboard baseline is the separate `evals/baseline/` snapshot used only for the diff.
2. Whether loom-ui's planner gets its own evals in the `loom-ui` repo. Likely yes, by the same pattern, since loom-ui builds
   capabilities before consumers.
3. Whether the scoreboard publishes to the public loom-site.
