# Provenance: tool-search dataset

- **Files:** `catalogue.ts` (72 synthetic tools and 10 host annotations), `queries.ts` (48 labelled queries).
- **Labeller:** Claude Opus 5.5 (1M context), as the implementing agent of ADR 0131 slice S1, for the repo owner.
- **Date:** 2026-10-17.
- **Source:** original synthetic text. The menu shape follows the `tool-search-mcp-menu` example in the sibling
  `loom-examples` repo (nine domains, deliberately overlapping vocabulary). No real user data, no third-party text.
- **Blind labelling:** the catalogue, the annotations and every query's relevant set were written and committed
  BEFORE any ranker was run over them (commit `test(evals): S1 datasets, labelled blind`). Each relevant set was
  decided by reading the tool descriptions alone: "which tools would a competent engineer accept as a correct answer".
- **Label rules:**
  1. A query is written from the user-intent side first, then labelled.
  2. `relevant` lists every acceptable tool, not only the best one. It is never empty.
  3. A near-miss (a tool in the same domain that does a different job, for example `restart_service` for "restart the
     stuck worker") is NOT relevant.
  4. `kind: "stoplist"` queries are function-word heavy (ADR 0125 D15). `kind: "annotation"` queries use phrasing that
     appears only in a host annotation in `catalogue.ts`.
- **Label edits after measurement (post-review label corrections, S2 PR, 2026-10-17).** Two objective labelling errors
  found in review (rule 3: a near-miss is NOT relevant); the relevant sets were narrowed and no threshold was lowered to
  hide anything (the floors were re-derived as measured minus 0.02):
  - `t26` "sign the user out everywhere": dropped `list_active_sessions` (it only LISTS sessions; it signs nobody out).
  - `t27` "undo a bad release": dropped `cancel_deployment` (it stops a deployment in flight; it does not undo a shipped
    release). Each edit must be listed here with its reason, and only for an objective labelling error, never to move a
    score.
- **Adding a case:** add the tool (and annotation) or query, label it from the descriptions first, re-run `pnpm eval`,
  and commit the new baseline with `pnpm eval:update-baseline`. A threshold change is a reviewed diff with a reason.
- **Limits:** 48 queries over 72 tools is a tripwire for regression, not a claim about absolute quality.
