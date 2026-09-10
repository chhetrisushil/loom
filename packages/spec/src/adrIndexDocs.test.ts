import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ── Fitness function: a doc that CLAIMS the whole decision history must have it ──
//
// Two documents advertise the ADR corpus by RANGE — "the full decision history (0001–NNNN)" —
// and `architecture.md` then walks it record by record. A range is a claim about
// completeness, so it is wrong the moment a record lands after it, and wrong in the way that
// is hardest to notice: the sentence still reads as authoritative, and a reader who trusts it
// never looks for the four records it silently excludes.
//
// It has now drifted exactly that way. Both files stopped at 0091 while 0092–0095 existed,
// and the enumeration's last clause described a corpus four records short.
//
// This is the THIRD surface of one class. The CHANGELOG has a guard (`changelogCoverage`),
// the capability registry has a guard (`spec.test.ts`), and the same failure — a list that
// enumerates a growing registry and is maintained by remembering — went unguarded here.
// Both halves are asserted, because they fail independently: the RANGE can be bumped without
// extending the prose, and the prose can be extended without the range being bumped.

const REPO_ROOT = resolve(__dirname, "../../..");

/** Documents that advertise the corpus as a range. Add one ⇒ it is checked. */
const INDEX_DOCS: readonly string[] = ["docs/architecture.md", "docs/README.md"];

/** `(0001–0095` or `(0001-0095` — the upper bound is what rots. */
const RANGE_CLAIM = /\(0001[–-](\d{4})/g;

function adrNumbers(): number[] {
  return readdirSync(resolve(REPO_ROOT, "docs/adr"))
    .filter((f) => /^\d{4}-.*\.md$/.test(f))
    .map((f) => Number(f.slice(0, 4)));
}

describe("ADR index docs (fitness)", () => {
  const highest = Math.max(...adrNumbers());
  const padded = String(highest).padStart(4, "0");

  it("finds the corpus and the claims (the sweep can't silently match nothing)", () => {
    expect(adrNumbers().length).toBeGreaterThan(70);
    for (const doc of INDEX_DOCS) {
      const body = readFileSync(join(REPO_ROOT, doc), "utf8");
      expect([...body.matchAll(RANGE_CLAIM)].length, `${doc} states no ADR range`).toBeGreaterThan(
        0
      );
    }
  });

  it("every range claim ends at the newest ADR", () => {
    const stale: string[] = [];
    for (const doc of INDEX_DOCS) {
      const body = readFileSync(join(REPO_ROOT, doc), "utf8");
      for (const match of body.matchAll(RANGE_CLAIM)) {
        if (match[1] !== padded) stale.push(`${doc}: claims 0001–${match[1]}, newest is ${padded}`);
      }
    }
    expect(stale, "update the ADR range — a range claim is a completeness claim").toEqual([]);
  });

  it("the enumeration reaches the newest ADR", () => {
    // The range alone is satisfiable by editing one number. `architecture.md` walks the
    // corpus record by record, and a walk that stops early is the drift the range hides.
    const body = readFileSync(join(REPO_ROOT, "docs/architecture.md"), "utf8");
    expect(
      new RegExp(`\\b${padded}\\b`).test(body),
      `docs/architecture.md never mentions ADR ${padded} — extend the decision-history paragraph`
    ).toBe(true);
  });
});
