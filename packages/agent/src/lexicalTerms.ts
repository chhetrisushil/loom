/**
 * Terms of a free-text question for the keyword scorers (`CapabilityCatalog.find`,
 * and a byte-identical copy in `@loom/agent`'s `SkillRegistry`; a test pins the two together).
 *
 * - NFKC first, then lowercase: width / compatibility / decomposed forms fold together.
 * - Split on anything that is not a letter, a number, a combining mark or `_` (the underscore
 *   keeps the old `\W` meaning, so an ASCII question tokenizes exactly as it did).
 * - A token is kept when longer than 2 UTF-16 units (the old rule, unchanged for ASCII).
 * - Scripts written WITHOUT word separators (Han, Hiragana, Katakana, Thai, Lao, Khmer, Myanmar)
 *   cannot be word-split, so each run of them becomes overlapping character BIGRAMS (a one-character
 *   run is itself). The scorer matches terms by substring, so a bigram finds the same two characters
 *   anywhere in the haystack. No dictionary, no segmentation library: deterministic and dependency-free.
 */
const UNSPACED =
  "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}";
const SEPARATOR = /[^\p{L}\p{N}\p{M}_]+/u;
const RUNS = new RegExp(`[${UNSPACED}]+|[^${UNSPACED}]+`, "gu");
const HAS_UNSPACED = new RegExp(`[${UNSPACED}]`, "u");
const IS_UNSPACED = new RegExp(`^[${UNSPACED}]`, "u");

export function lexicalTerms(text: string): string[] {
  const out: string[] = [];
  for (const token of text.normalize("NFKC").toLowerCase().split(SEPARATOR)) {
    if (token.length === 0) continue;
    if (!HAS_UNSPACED.test(token)) {
      if (token.length > 2) out.push(token);
      continue;
    }
    for (const run of token.match(RUNS) ?? []) {
      if (!IS_UNSPACED.test(run)) {
        if (run.length > 2) out.push(run);
        continue;
      }
      const chars = [...run];
      if (chars.length === 1) out.push(run);
      else for (let i = 0; i + 1 < chars.length; i++) out.push(`${chars[i]}${chars[i + 1]}`);
    }
  }
  return out;
}
