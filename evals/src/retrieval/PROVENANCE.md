# Provenance: retrieval dataset (memory and knowledge)

- **Files:** `corpus.ts` (40 synthetic documents, 8 topics x 5), `queries.ts` (33 graded queries and one
  pathological termination query).
- **Labeller:** Claude Opus 5.5 (1M context), as the implementing agent of ADR 0131 slice S1, for the repo owner.
- **Date:** 2026-10-17.
- **Source:** original synthetic text about everyday topics. No real user data, no third-party or copied text.
- **Blind labelling:** the corpus and every graded query were written and committed BEFORE any store was searched
  (commit `test(evals): S1 datasets, labelled blind`). Grades come from reading the documents alone.
- **Label rules:**
  1. Grade 2: the document directly answers the question. Grade 1: related and partly useful. Absent: 0.
  2. A document that merely shares a word with the query is NOT graded (for example "mites" in the bee document for a
     houseplant pest question, "feed" in the houseplant document for a starter question). The corpus has such lexical
     traps on purpose.
  3. Recall counts any graded document (grade >= 1) as relevant; nDCG uses the grades (gain 2^grade - 1).
  4. Every query has at least one graded document (the sweep guards assert it).
- **Pathological query:** one word repeated 20,000 times (audit arc 3). A termination case with no labels.
- **Label edits after measurement:** none (each edit, if one ever happens, must be listed here with its reason, and only
  for an objective labelling error, never to move a score).
- **Adding a case:** add the document or query, grade it from the text first, re-run `pnpm eval`, and commit the new
  baseline with `pnpm eval:update-baseline`.
- **Limits:** 33 queries over 40 documents is a tripwire for regression, not a claim about absolute quality. Backends rank
  differently (BM25, `ts_rank`, a reference scorer), so a per-backend threshold needs a stated reason.
