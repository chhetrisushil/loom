# Provenance: planner dataset (slice S3)

- **Files:** `cases.ts` (12 operator intents, each with the capability it must route to, the exact agent graph it must
  plan, and a hand-written model script), `catalog.ts` (the 8-capability database-operations catalogue), `cassettes/*.json`
  (one cassette per intent), `subject.ts` (the case runner), `measure.ts`, `author.ts`.
- **Labeller:** Claude (Sonnet subagent), reviewed by Claude (Sonnet), as the implementing agent of ADR 0131 slice S3, for the repo owner.
- **Date:** 2026-10-17.
- **Source:** original synthetic text. The catalogue and the intent shapes follow the sibling `loom-examples`
  `db-command-center` example (diagnose, assess, apply, scale), with synthetic ids and wording. No real user data, no
  third-party text.

## THE CASSETTES ARE HAND-AUTHORED. NO MODEL WAS CALLED.

Every model response in `cassettes/` was written by hand as a `script` in `cases.ts` (what a sensible router and planner
would answer). `pnpm eval:author` then runs the REAL `IntentRuntime.route` and `PlannerRuntime.planGraph` (inside a real
`WorkflowRuntime`, the model behind a registered `createAgentModelEffect`, journaled through `ctx.decide`) over that
script through a `CassetteProvider` in record mode and stores each request/response pair. No provider, no network and
no API key was involved, and the user has not approved live recording. A test regenerates every cassette from its script
and requires the committed file to match byte for byte.

**What this measures:** given a model that answers like this, does `IntentRuntime` route by the MODEL (not its keyword
fallback), and does `PlannerRuntime.planGraph` parse, validate (catalogue ids, `$from` references, `dependsOn` edges,
argument schemas) and, when the first plan is rejected, retry with the validator's feedback, so that the DAG is exactly
the expected one? It also pins the typed refusal when nothing fits.

**What it does NOT measure:** a model's quality. The script always does the sensible thing. The runtimes' prompts are
pinned at their defaults (ADR 0126 makes them overridable; a cassette is keyed by the exact request), so a legitimate
prompt change MISSES (the signal); regenerate with `pnpm eval:author` and review the diff.

## Metrics

- **routeAccuracy** - cases where `IntentRuntime.route` returned the expected capability AND `rationale` is
  "model routed", or the expected "no route" came out as none. (With a model configured the router has no keyword
  fallback, so a reply it cannot use is a miss, never a silent keyword pick.)
- **graphCorrectness** - cases whose planned graph is exactly the expected one: node ids, capability ids, `args`
  (including `{"$from": ...}` bindings; key order irrelevant), `dependsOn` (order irrelevant), node order. The free-text
  `rationale` is not part of the graph. A planner that gives up is `refused:<reason>` and is compared the same way.

## Label rules

1. Each case's `route` and `graph` are written from the INTENT (what an operator wants done, in what order, with which
   bindings), before any runtime ran over it. Node ids are the short names the script uses; they are labels, not
   semantics, and are part of the exact comparison.
2. `dependsOn` lists exactly the steps whose output the step consumes or must follow; independent steps have none (the
   executor runs them in one wave).
3. A request nothing in the catalogue can serve expects `route: null` and a typed refusal, never an invented step.

## Measured gap, recorded not hidden (FIXED 2026-10-17)

`no-capability` ("Find me a good Italian restaurant for dinner tonight."): the router model answers `NONE`, and
`IntentRuntime.route` used to FALL BACK to its offline keyword matcher on any unusable answer, an explicit `NONE`
included. The matcher routed the request to `diagnose-cpu` on shared words. The label (`route: null`) is what the
intent implies; the first measurement was therefore routeAccuracy 11/12, with a pinned test asserting that behaviour and
the floor one case lower. **Fixed, 2026-10-17:** a configured model's `NONE` is final and an unparseable or ambiguous
reply routes nowhere; the keyword matcher runs only with no model. The measured routeAccuracy is now 12/12, the pinned
test asserts the NONE is honoured, and the floor is raised to 11/12 (`thresholds.ts`). No label changed.

## Label edits after measurement

None, with one disclosed exception: the `no-capability` intent text was changed once BEFORE any score was recorded,
from a request that contained the catalogue's own tag word "table" to the current wording, because that first wording
was an unfair probe (it genuinely overlapped a capability). The remaining overlap on "find" is the measured gap above.
(Each later edit, if one ever happens, must be listed here with its reason, and only for an objective labelling error,
never to move a score.)

- **Adding a case:** write the intent, `route`, `graph` and script, run `pnpm eval:author`, then `pnpm eval` and
  `pnpm eval:update-baseline`; thresholds change only as a reviewed diff with a reason.
- **Limits:** 12 intents over scripted transcripts is a tripwire for the planning code, not a claim about absolute quality.
