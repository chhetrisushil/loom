// ── Retrieval metrics (ADR 0131 D3) ───────────────────────────────────────────
//
// Small pure functions over a RANKED list of ids (best first). They live here, not in `@loom/eval`:
// promoting them is a separate decision under ADR 0083 once a third consumer exists.
//
// Conventions, each pinned by `metrics.test.ts`:
//  - `k` larger than the list is fine (the list is simply shorter than k); `k <= 0` scores 0.
//  - an EMPTY relevant set scores 0 for every metric. It is not "perfect" and not NaN: a query
//    nothing can answer must never raise a mean. The datasets contain no such query, and the sweep
//    guards assert it, so this is a safety net rather than a feature.
//  - a repeated id in the ranked list counts once, at its first position (a ranker that returns the
//    same hit twice must not be credited twice).

const dedupe = (ranked: readonly string[]): string[] => [...new Set(ranked)];

const asSet = (relevant: Iterable<string>): Set<string> => new Set(relevant);

/** Fraction of the relevant set found in the top `k`. */
export function recallAtK(
  ranked: readonly string[],
  relevant: Iterable<string>,
  k: number
): number {
  const rel = asSet(relevant);
  if (rel.size === 0 || k <= 0) return 0;
  const top = dedupe(ranked).slice(0, k);
  let found = 0;
  for (const id of top) if (rel.has(id)) found++;
  return found / rel.size;
}

/**
 * Fraction of the returned page that is relevant. It measures NOISE: a ranker that returns the right
 * tool first and nine unrelated ones after still has a perfect reciprocal rank. An empty page, or an
 * empty relevant set, scores 0.
 */
export function precision(ranked: readonly string[], relevant: Iterable<string>): number {
  const rel = asSet(relevant);
  const page = dedupe(ranked);
  if (rel.size === 0 || page.length === 0) return 0;
  let found = 0;
  for (const id of page) if (rel.has(id)) found++;
  return found / page.length;
}

/** 1 when any relevant id is in the top `k`, else 0. */
export function hitAtK(ranked: readonly string[], relevant: Iterable<string>, k: number): number {
  const rel = asSet(relevant);
  if (rel.size === 0 || k <= 0) return 0;
  return dedupe(ranked)
    .slice(0, k)
    .some((id) => rel.has(id))
    ? 1
    : 0;
}

/** 1 / (1-based rank of the first relevant id), 0 when none is ranked. */
export function reciprocalRank(ranked: readonly string[], relevant: Iterable<string>): number {
  const rel = asSet(relevant);
  if (rel.size === 0) return 0;
  const list = dedupe(ranked);
  for (let i = 0; i < list.length; i++) if (rel.has(list[i] as string)) return 1 / (i + 1);
  return 0;
}

/** Arithmetic mean; an empty list is 0 (never NaN, which would poison a scoreboard). */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Mean reciprocal rank over `(ranked, relevant)` pairs. */
export function mrr(
  cases: ReadonlyArray<{ ranked: readonly string[]; relevant: Iterable<string> }>
): number {
  return mean(cases.map((c) => reciprocalRank(c.ranked, c.relevant)));
}

/**
 * Normalised discounted cumulative gain at `k` with GRADED relevance.
 *
 * `gains` maps id to a non-negative grade (absent = 0). Gain is `2^grade - 1` and the discount is
 * `log2(rank + 1)` (the common "exponential gain" form, which rewards a grade-2 hit well above a
 * grade-1 one); with grades in {0, 1} this is the binary nDCG. The ideal ordering is every graded id,
 * best first, cut at `k`. No relevant id at all scores 0.
 */
export function ndcgAtK(
  ranked: readonly string[],
  gains: Readonly<Record<string, number>>,
  k: number
): number {
  if (k <= 0) return 0;
  const gain = (id: string): number => 2 ** Math.max(0, gains[id] ?? 0) - 1;
  const discount = (i: number): number => Math.log2(i + 2);
  let dcg = 0;
  const top = dedupe(ranked).slice(0, k);
  for (let i = 0; i < top.length; i++) dcg += gain(top[i] as string) / discount(i);
  const ideal = Object.keys(gains)
    .map(gain)
    .sort((a, b) => b - a)
    .slice(0, k);
  let idcg = 0;
  for (let i = 0; i < ideal.length; i++) idcg += (ideal[i] as number) / discount(i);
  return idcg === 0 ? 0 : dcg / idcg;
}
