# @loomwork/analytics — read-only summaries of an execution's event log

Pure functions that take an array of events and return a summary: step counts, metered cost, routing
decisions, failures, latency, flame graphs, and a short advisory report with recommendations. They
read the log you hand them and never write to it or affect the fold. Use them in dashboards, CI
reports and tooling such as `loom introspect`. The recommendations are advice for you to act on; nothing
here changes a run.

```ts
import { analyze, hotFailures, runtimeIntelligence } from "@loomwork/analytics";
import type { EventStore } from "@loomwork/event-runtime";

declare const eventStore: EventStore;

const events = await eventStore.read("exec-123");

const { execution, cost, failure } = analyze(events);
console.log(execution.status, cost.costUsd, failure.failedSteps);

const { recommendations } = runtimeIntelligence(events, { budgetHeadroom: 1.5 });
console.log(recommendations.suggestedBudgetUsd, recommendations.hotFailures);
console.log(hotFailures(events, 3));
```

## Surface

- **Core summaries.** `analyze(events, options?)` returns `{ execution, cost, reasoning, failure }`; each
  part is also available alone (`executionAnalytics`, `costAnalytics`, `reasoningAnalytics`,
  `failureAnalytics`). Cost covers tokens, USD and milliseconds, plus any custom dimensions (at most 32
  names per report, the rest summed under `"(other)"`; ADR 0115).
- **Recommendations.** `rankModels`, `hotFailures`, `runtimeIntelligence`, and `advisoryPipeline` with
  `formatAdvisory`, which also correlates recommendations with the outcomes recorded later (ADR 0034).
- **Outcomes and decisions.** `outcomeAnalytics` and `rankFromOutcomes` aggregate `OUTCOME_RECORDED`
  events; `decisionRecords`, `decisionStore` and `decisionGraph` expose `DECISION_RECORDED` events.
- **Shape of a run.** `introspect` with `executionNodes`, `taskGraph`, `resourceGraph`, `dependencyGraph`
  and `formatIntrospection`; `profile`, `flameGraph`, `latencyBreakdown` and `formatProfile`;
  `chainLineage` for continue-as-new chains; `replayCost` for what a cold replay would fold.
- **Writing outcomes.** `recordOutcome(sink, outcome)` emits an `OUTCOME_RECORDED` event through a
  context's `emit`, and `attachOutcomes(runtime, rewards)` records late rewards for finished executions
  (ADR 0116). These are the only functions here that cause a write, and they go through the runtime.

## Behaviour that surprises people

- **A compacted log is missing its history.** Decisions and outcomes of a compacted execution live in
  its checkpoint, not in the log. `outcomeAnalytics` documents building the events from the folded
  state first (`evidenceEvents` in `@loomwork/learning`) when an execution may have been compacted.
- **Recommendations are heuristics.** `suggestedBudgetUsd` is observed cost times `budgetHeadroom`
  (default 1.5). `rankModels` counts how often each model was routed to, which is frequency and not
  quality; outcome-based rankings need recorded outcomes.
- **Same events in, same report out.** The functions take no clock, except that `outcomeAnalytics` with
  `halfLifeMs` decays against the newest outcome timestamp unless you pass `now`.

## Status / See also

`npm install @loomwork/analytics` (or pnpm / yarn). Pre-1.0: every `@loomwork/*` package shares one version, so keep them on the same release.
Inside this repo use `workspace:*`; a sibling checkout links it with a `link:` override (see [AGENTS.md](../../AGENTS.md)).

- [ADR 0034](../../docs/adr/0034-advisory-optimization-pipeline.md): the advisory pipeline.
- [ADR 0115](../../docs/adr/0115-open-vocabularies.md) and
  [ADR 0116](../../docs/adr/0116-late-outcome-attach.md): custom dimensions and late outcomes.
- API reference: section "`@loomwork/analytics` — event intelligence *(2.0)*" in
  [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [docs/user-guide.md](../../docs/user-guide.md), [docs/README.md](../../docs/README.md).
