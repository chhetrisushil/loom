# Provenance: skill-discovery dataset

- **Files:** `skills.ts` (15 synthetic skills), `intents.ts` (30 labelled intents).
- **Labeller:** Claude (Sonnet subagent), reviewed by Claude (Sonnet), as the implementing agent of ADR 0131 slice S1, for the repo owner.
- **Date:** 2026-10-17.
- **Source:** original synthetic text. No real user data, no third-party text.
- **Blind labelling:** skills and intents were written and committed BEFORE any ranker was run over them
  (commit `test(evals): S1 datasets, labelled blind`). Labels come from reading the skill descriptions alone.
- **Label rules:**
  1. One `expected` skill per intent: the single best match (scored by hit@1).
  2. `acceptable` always contains `expected` and lists any other skill a reasonable person would also accept (scored by
     hit@3). Most intents have one; three genuinely straddle two skills (bad release, slow database with
     a pager, paging runbook).
  3. The skill descriptions overlap on purpose (billing words in refunds and collections; access words in onboarding,
     offboarding and security review; alert words in incident triage and runbook writing).
- **Label edits after measurement (post-review label correction, S2 PR, 2026-10-17):** `i13` "write a how-to guide for the
  deploy process": dropped `release-management` from the acceptable set (a how-to guide is documentation work; the
  release-management skill runs a release, it does not write about one). Four straddling intents became three. Each edit
  must be listed here with its reason, and only for an objective labelling error, never to move a score.
- **Adding a case:** add the skill or intent, label from the descriptions first, re-run `pnpm eval`, and commit the new
  baseline with `pnpm eval:update-baseline`.
- **Limits:** 30 intents over 15 skills is a tripwire for regression, not a claim about absolute quality.
