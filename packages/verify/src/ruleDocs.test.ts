import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RULE_ORDER } from "./rules";

// ── Fitness function: a rule cannot ship undocumented ────────────────────────
//
// `RULE_ORDER` is the executable list; two documents describe it — this
// package's README (what each rule catches) and ADR 0028 (why each rule
// exists). Both have now gone stale twice in the same way: `effect-class`
// landed and ADR 0028's list stayed at six, then `classification-reachability`
// AND `effect-class` were both absent from the README's table while the ADR
// amendment that added the eighth rule still called it "a seventh rule".
//
// That is the fourth instance of the same class — an enumerating document left
// behind by a registry that grew — and it is mechanizable exactly the way
// `SEAM_KEYS` ↔ the SPI map is (`tools/scaffold/src/seamDocs.test.ts`), so it
// is mechanized here rather than re-audited a fifth time.
//
// Design notes carried over from that guard:
//   - Derive from the registry (`RULE_ORDER`), never from a hand-kept list
//     beside the check — a second list is a second thing to forget.
//   - Assert a TABLE ROW / LIST ITEM, not `toContain`. Every rule name appears
//     somewhere in both files as prose; matching that would pass vacuously.
//   - Most of the tests exist to make the check FAIL. A guard nobody has
//     watched fail is indistinguishable from a comment.

const REPO_ROOT = resolve(__dirname, "../../..");
const doc = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

const README = "packages/verify/README.md";
const ADR = "docs/adr/0028-runtime-verification.md";

/** Rules with no table row whose first cell is the rule name. */
function rulesMissingFromReadmeTable(text: string): string[] {
  const rows = text.split("\n").filter((l) => l.startsWith("|"));
  return RULE_ORDER.filter((rule) => !rows.some((r) => r.startsWith(`| \`${rule}\``)));
}

/** Rules with no `- **rule**` bullet in the ADR's V1 rule list. */
function rulesMissingFromAdrList(text: string): string[] {
  const bullets = text.split("\n").filter((l) => l.startsWith("- **"));
  return RULE_ORDER.filter((rule) => !bullets.some((b) => b.startsWith(`- **${rule}**`)));
}

describe("rule/doc coverage (fitness)", () => {
  it("every rule has a row in the README's rules table", () => {
    expect(rulesMissingFromReadmeTable(doc(README))).toEqual([]);
  });

  it("every rule has a bullet in ADR 0028's rule list", () => {
    // `effect-class` is described in an amendment rather than the V1 list, so it
    // is exempt from the bullet form — but it must still be named in the ADR.
    const missing = rulesMissingFromAdrList(doc(ADR)).filter((r) => r !== "effect-class");
    expect(missing).toEqual([]);
    expect(doc(ADR)).toContain("`effect-class`");
  });

  it("the ADR's stated rule count matches the registry", () => {
    // The count was wrong ("a seventh rule") the whole time there were eight.
    const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
    expect(doc(ADR).toLowerCase()).toContain(`stands at **${WORDS[RULE_ORDER.length]}**`);
  });

  // ── The checks must be able to FAIL ────────────────────────────────────────

  it("fails when a rule's row is removed from the README", () => {
    const without = doc(README)
      .split("\n")
      .filter((l) => !l.startsWith("| `effect-class`"))
      .join("\n");
    expect(rulesMissingFromReadmeTable(without)).toEqual(["effect-class"]);
  });

  it("is not satisfied by a passing mention outside the table", () => {
    // The exact failure a `toContain` check would have had: the name is in the
    // file, the row is not.
    const prose = `${doc(README)
      .split("\n")
      .filter((l) => !l.startsWith("| `classification-reachability`"))
      .join("\n")}\n\nSee \`classification-reachability\` for the egress-mark check.\n`;
    expect(rulesMissingFromReadmeTable(prose)).toEqual(["classification-reachability"]);
  });

  it("fails when a rule is dropped from the ADR's list", () => {
    const without = doc(ADR).replace("- **replay-safety**", "- **replay-saftey**");
    expect(rulesMissingFromAdrList(without)).toContain("replay-safety");
  });

  it("reports every rule when a document has no enumeration at all", () => {
    expect(rulesMissingFromReadmeTable("no table here")).toEqual([...RULE_ORDER]);
    expect(rulesMissingFromAdrList("no list here")).toEqual([...RULE_ORDER]);
  });
});
