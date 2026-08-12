import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SEAM_KEYS, SEAM_SPI } from "./plugin";

// ── Fitness function: a seam cannot ship undocumented ─────────────────────────
//
// Adding a seam touches five code sites that are easy to find (the registry, the
// scaffold, the conformance kit, SPI_PACKAGES, an example) and several doc sites
// that are not, because none of them sit next to the code. Both `policy` and
// `llm` shipped scaffoldable and conformance-kitted while absent from the
// canonical SPI map — the one document an implementer opens to find out what
// seams exist. `llm` had been missing for far longer than `policy`.
//
// This is the same shape as the ADR-coverage guard in `@loom/spec`: convert "we
// forgot" into a failing test, in a reviewable diff. It only covers what is
// mechanically checkable **inside this repo** — the sibling `loom-plugins`
// README and the multi-checkout setup diagrams are deliberately left to review,
// because a check that appeared to cover them and could not would be worse than
// knowing they are manual.

const REPO_ROOT = resolve(__dirname, "../../..");
const doc = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

const SPI_MAP = "docs/loom-2.0/12-extension-seams.md";
const PLUGIN_GUIDE = "docs/plugins.md";

/**
 * Seams with no ROW naming their SPI in the map. Structural on purpose: matching
 * the interface name anywhere in the file would pass on a passing mention in
 * prose — including the "policy is the exception" paragraph in the plugin guide —
 * which is exactly the vacuous check this is meant not to be.
 */
function seamsMissingFromSpiMap(mapText: string): string[] {
  const rows = mapText.split("\n").filter((l) => l.startsWith("|"));
  return SEAM_KEYS.filter((key) => {
    const spi = SEAM_SPI[key] as string;
    return !rows.some((r) => r.includes(`\`${spi}`));
  });
}

/** Seams absent from the plugin guide's `Seams:` enumeration. */
function seamsMissingFromGuide(guideText: string): string[] {
  const start = guideText.indexOf("Seams: ");
  if (start === -1) return [...SEAM_KEYS];
  // The enumeration wraps across lines and ends at the sentence's period.
  const list = guideText.slice(start, guideText.indexOf(".", start));
  return SEAM_KEYS.filter((key) => !list.includes(`\`${key}\``));
}

describe("seam/doc coverage (fitness)", () => {
  it("every seam has a row naming its SPI in the extension-seams map", () => {
    expect(seamsMissingFromSpiMap(doc(SPI_MAP))).toEqual([]);
  });

  it("every seam appears in the plugin guide's seam list", () => {
    expect(seamsMissingFromGuide(doc(PLUGIN_GUIDE))).toEqual([]);
  });

  // ── The checks must be able to FAIL ────────────────────────────────────────
  // A guard nobody has watched fail is indistinguishable from a comment.

  it("fails when a seam's row is removed from the map", () => {
    const withoutPolicy = doc(SPI_MAP)
      .split("\n")
      .filter((l) => !(l.startsWith("|") && l.includes("`Policy<A>`")))
      .join("\n");
    expect(seamsMissingFromSpiMap(withoutPolicy)).toEqual(["policy"]);
  });

  it("is not satisfied by a passing mention outside the table", () => {
    // The failure mode a `toContain` check would have: the word is in the file,
    // the row is not.
    const prose = `${doc(SPI_MAP)
      .split("\n")
      .filter((l) => !(l.startsWith("|") && l.includes("`LlmProvider`")))
      .join("\n")}\n\nSee \`LlmProvider\` for the model backend.\n`;
    expect(seamsMissingFromSpiMap(prose)).toEqual(["llm"]);
  });

  it("fails when a seam is dropped from the guide's list", () => {
    expect(seamsMissingFromGuide(doc(PLUGIN_GUIDE).replace("`policy`", "`polciy`"))).toEqual([
      "policy",
    ]);
  });

  it("reports every seam when the guide has no seam list at all", () => {
    expect(seamsMissingFromGuide("no enumeration here")).toEqual([...SEAM_KEYS]);
  });
});
