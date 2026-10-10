# ADR 0126 — Unicode lexical scoring, prompt overrides, and time zones on schedules (R19)

- Status: **Accepted**
- Date: 2026-10-10
- Closes: R19 (PR #554, shipped without a record; this ADR is the retroactive governance entry)
- Builds on: [ADR 0123](0123-planning-depth-plan-graphs-replanning-and-goals.md) (`planGoal`, plan-graph prompts),
  [ADR 0085](0085-untrusted-content-integrity-axis.md) (taint, the untrusted-content note),
  [ADR 0125](0125-tool-search.md) (the tool-search tokenizer was already Unicode-aware),
  T1.2 (`schedule$` and the cron `TimerService`).
- Placement: **1P, additive.** `KERNEL_ABI`, `EVENT_SCHEMA` and every SPI are unchanged; no syscall, no event kind. One optional
  field, `ScheduleDefinition.timeZone`, is added to an authoring type.

## Context

Three English-only assumptions sat in 1P code. The keyword scorers behind `CapabilityCatalog.find` and `SkillRegistry.find`
split on ASCII `\W+`, so "Rechnung prüfen" lost its non-ASCII letters and "請求書" produced no terms. The fixed English prompt
text of `PlannerRuntime`, `IntentRuntime` and `planGoal` could not be replaced. And `schedule$` read its five cron fields on
the UTC clock only, so "09:00 on weekdays" in Berlin drifted by an hour twice a year.

## Decision

**D1 — Unicode tokenizer (`lexicalTerms`).** The two scorers tokenize with NFKC normalization, then runs of letters, numbers
and marks in any script. Scripts written without spaces (Han, Hiragana, Katakana, Thai, Lao, Khmer, Myanmar) become overlapping
character bigrams; there is no dictionary segmenter and no dependency. The memory and tool-search tokenizers were already
Unicode-aware and are deliberately untouched (memory's feeds persisted FTS indexes).

**D2 — Replay argument.** For ASCII input the new tokenizer is byte-identical to the old one (underscore stays a word
character; the length-over-2 filter and the term cap are unchanged), so no existing selection changes. Where a result could
change (a non-ASCII query), nothing replays the scorer: `agentLoop$` records its skill selection as a decision (the `#skills`
decision), so a replay serves the recorded selection and runs no scoring. A tokenizer change therefore cannot diverge a recorded
execution.

**D3 — Prompt overrides, English by default.** `new PlannerRuntime({ prompts: { system, user } })`,
`new IntentRuntime({ prompts: { system, user } })`, and `planGoal(ctx, { prompts })` / `makeReviser({ prompts })` with
`PlannerPrompts` (`system`, `maxSteps`, `capabilities`, `goal`, `rejected`). Absent, the English text is used unchanged. A
replacement `system` must still ask for the reply shape the parser reads (a JSON plan, or a bare capability id). **The
untrusted-content note is ALWAYS appended to the plan-graph system prompt**, whatever the override: it is a security boundary
(ADR 0085), not wording, and a locale must not be able to drop it.

**D4 — Time zones on schedules.** `schedule$({ timeZone })` (also `ScheduleDefinition.timeZone` and
`sentinelPreset({ timeZone })`) takes an IANA name. The five cron fields are read on that zone's wall clock, computed with
`Intl.DateTimeFormat`. Default is **UTC**, so every existing schedule is unchanged. An unknown zone throws when `schedule$` is
called, and `parseCron` / `TimerService` re-check it. The zone is data on the schedule, not the node's, so every node computes
the same occurrences. **The occurrence id stays the UTC epoch ms**, so an occurrence's execution id (`scheduleId@occurrence`)
is unambiguous across the DST fold and its start stays idempotent.

**D5 — The DST rule.** A fixed wall time runs once per day it matches:
- **Skipped wall time (spring forward):** it runs once, shifted forward by the gap (`30 2 * * *` in `America/New_York` on
  2026-03-08 runs at 03:30 EDT).
- **Repeated wall time (fall back):** it runs once, at its FIRST occurrence (`30 1 * * *` on 2026-11-01 runs at 01:30 EDT and
  not again at 01:30 EST).

A consequence is that an hourly or sub-hourly expression (`0 * * * *`, `*/15 * * * *`) in a DST zone silently loses the
repeated hour's second pass. Fixed-interval schedules belong in UTC; `schedule$` warns once when it sees the combination.

## Consequences

- Non-English queries now match; ASCII behaviour and recorded executions are unchanged. Bigrams over-match short CJK queries
  slightly; ranking beyond term overlap stays the caller's concern (the `ToolRanker` / embedding path).
- A locale can reword the planner and intent prompts, but cannot remove the untrusted-content note.
- Schedules in a DST zone are correct for daily and fixed-time expressions, and have one documented, signalled limit
  (repeated hour, sub-hourly).
- No kernel, ABI, schema or SPI change; the registry entry is `unicode-locale` (L2).
