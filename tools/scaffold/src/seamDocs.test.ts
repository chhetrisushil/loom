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

/**
 * Conformance kits absent from the SPI map, DELIBERATELY and for now.
 *
 * The map's "Conformance kit" column is how an implementer learns a backend can be
 * proved rather than argued about, and it had drifted in both directions: the Timers
 * row said "— (future)" while `runTimerStoreConformance` had shipped and SQLite was
 * running it, and the compute section said a dispatcher kit "is a natural follow-up"
 * with `runExecutionDispatcherConformance` already exported.
 *
 * These six have kits and no row at all, because the seams themselves are not in the
 * map yet — writing those rows means describing each seam's required surface, which is
 * a research job and not a rename. Listed rather than silent: the allowlist converts
 * "we forgot" into "we decided", in a reviewable diff, the way @loom/spec's
 * NOT_A_CAPABILITY does for ADRs.
 */
const KIT_WITHOUT_A_MAP_ROW = new Set([
  "runContentStoreConformance", // content-store seam (ADR 0046)
  "runDurableStateStoreConformance", // durable carry state (ADR 0051 D2)
  "runReadModelStoreConformance", // cross-execution read models (RM)
  "runKeyStoreConformance", // K10 envelope encryption
  "runProjectionRuntimeConformance", // listed in the map's Observability table, no kit column
  "runCapabilityAuthorizerConformance", // listed in the Effect & policy table, no kit column
]);

/** Every `run*Conformance` @loom/conformance exports. Read as text — no dependency on it. */
function exportedKits(): string[] {
  const source = readFileSync(resolve(REPO_ROOT, "packages/conformance/src/index.ts"), "utf8");
  return [...source.matchAll(/export function (run\w*Conformance)/g)].map((m) => m[1] as string);
}

describe("conformance-kit/doc coverage (fitness)", () => {
  it("finds the kits (the sweep itself can't silently match nothing)", () => {
    expect(exportedKits().length).toBeGreaterThan(10);
  });

  it("every conformance kit is named in the SPI map, or listed as not-yet-mapped", () => {
    const mapText = doc(SPI_MAP);
    const undocumented = exportedKits().filter(
      (kit) => !mapText.includes(kit) && !KIT_WITHOUT_A_MAP_ROW.has(kit)
    );
    expect(
      undocumented,
      `these kits exist and the map does not mention them, so a backend author cannot find them:\n${undocumented.join("\n")}`
    ).toEqual([]);
  });

  it("the map names no kit that does not exist", () => {
    const kits = new Set(exportedKits());
    const named = [...doc(SPI_MAP).matchAll(/`(run\w*Conformance)`/g)].map((m) => m[1] as string);
    expect(named.length).toBeGreaterThan(3);
    expect(named.filter((kit) => !kits.has(kit))).toEqual([]);
  });

  it("the allowlist is live — no entry for a kit that is now mapped", () => {
    // Otherwise it rots into a list of things that ARE documented, and the next
    // undocumented kit hides behind a stale exemption.
    const mapText = doc(SPI_MAP);
    expect([...KIT_WITHOUT_A_MAP_ROW].filter((kit) => mapText.includes(kit))).toEqual([]);
  });
});

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
