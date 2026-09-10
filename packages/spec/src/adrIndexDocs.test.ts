import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ── Fitness function: a doc that CLAIMS the whole decision history must have it ──
//
// Documents advertise the ADR corpus by RANGE — "the full decision history (0001–NNNN)" — and
// `architecture.md` then walks it record by record. A range is a claim about COMPLETENESS, so
// it is wrong the moment a record lands after it, and wrong in the way that is hardest to
// notice: the sentence still reads as authoritative, and a reader who trusts it never goes
// looking for the records it silently excludes.
//
// This is the THIRD surface of one class. The CHANGELOG has a guard (`changelogCoverage`), the
// capability registry has a guard (`spec.test.ts`), and the same failure — a list that
// enumerates a growing registry and is maintained by remembering — went unguarded here. Both
// halves are asserted, because they fail independently: the RANGE can be bumped without
// extending the prose, and the prose can be extended without the range being bumped.
//
// The claiming documents are DISCOVERED rather than listed. The first version of this guard
// carried a hand-written pair of paths and missed `README.org` — the repo's own front page,
// making the same claim in the same shape, nine records out of date — because a hand-kept list
// beside a check is a second thing to forget. The only hand-written list left is the exemption
// map, where an entry must state its reason.

const REPO_ROOT = resolve(__dirname, "../../..");

/** `(0001–0095` or `(0001-0095` — the upper bound is what rots. */
const RANGE_CLAIM = /\(0001[–-](\d{4})/g;
/** The same pattern for a boolean test. Separate, because `.test()` on a `/g` regex is
 *  STATEFUL — sharing one would make every other call answer from a stale `lastIndex`. */
const HAS_RANGE_CLAIM = /\(0001[–-]\d{4}/;

/** Documents whose range is a SCOPED citation rather than a claim about the whole corpus. */
const SCOPED_CLAIMS: ReadonlyMap<string, string> = new Map([
  [
    "docs/presentation/loom-deck.md",
    "cites the pre-2.0 decisions specifically (0001–0015) as further reading, not the corpus",
  ],
]);

/** Every tracked `.md`/`.org` stating an ADR range, minus the scoped citations. */
function indexDocs(): string[] {
  return execFileSync("git", ["ls-files", "*.md", "*.org"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.length > 0)
    .filter((f) => !SCOPED_CLAIMS.has(f))
    .filter((f) => HAS_RANGE_CLAIM.test(readFileSync(join(REPO_ROOT, f), "utf8")));
}

function adrNumbers(): number[] {
  return readdirSync(resolve(REPO_ROOT, "docs/adr"))
    .filter((f) => /^\d{4}-.*\.md$/.test(f))
    .map((f) => Number(f.slice(0, 4)));
}

describe("ADR index docs (fitness)", () => {
  const highest = Math.max(...adrNumbers());
  const padded = String(highest).padStart(4, "0");

  it("finds the corpus and the claims (the sweep itself can't silently match nothing)", () => {
    expect(adrNumbers().length).toBeGreaterThan(70);
    // The architecture map and both front pages state one; a sweep that discovered none would
    // pass every assertion below while checking nothing.
    expect(indexDocs().length).toBeGreaterThanOrEqual(3);
  });

  it("every scoped-claim exemption names a document that still makes one", () => {
    // An exemption for a renamed or rewritten file exempts nothing, and would hide the next
    // real omission behind a stale path.
    for (const [doc] of SCOPED_CLAIMS) {
      const full = join(REPO_ROOT, doc);
      expect(existsSync(full), doc).toBe(true);
      expect(HAS_RANGE_CLAIM.test(readFileSync(full, "utf8")), `${doc}`).toBe(true);
    }
  });

  it("every range claim ends at the newest ADR", () => {
    const stale: string[] = [];
    for (const doc of indexDocs()) {
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
