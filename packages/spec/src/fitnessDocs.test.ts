import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ── Fitness function: a fitness function cannot ship undocumented ────────────
//
// `docs/spec/fitness-functions.md` is NORMATIVE — it is the list of invariants
// the architecture claims to enforce. It had drifted twice: once historically,
// and again when two guards were added in one session and neither reached the
// table. A list of enforced invariants that omits enforced invariants is worse
// than no list, because it reads as complete.
//
// Same shape as `ruleDocs` (RULE_ORDER → docs) and `seamDocs` (SEAM_KEYS →
// docs): an explicit registry, asserted to exist as files AND to appear in the
// document. The registry is the point — it converts "we forgot" into "we
// decided", in a reviewable diff.

const REPO_ROOT = resolve(__dirname, "../../..");
const DOC = "docs/spec/fitness-functions.md";

/**
 * Every executable architectural invariant, by the file that enforces it.
 *
 * Add a guard ⇒ add it here ⇒ the test tells you to document it. A guard that
 * is deliberately not an architectural invariant (an ordinary unit test) simply
 * does not belong in this list.
 */
const FITNESS_TESTS: readonly string[] = [
  "packages/workflow-runtime/src/abi.test.ts",
  "packages/replay-vm/src/eventSchema.test.ts",
  "packages/verify/src/g2ratio.test.ts",
  "packages/verify/src/ruleDocs.test.ts",
  "packages/spec/src/spec.test.ts",
  "packages/spec/src/layering.test.ts",
  "packages/spec/src/sourceHygiene.test.ts",
  "packages/spec/src/projectGraph.test.ts",
  "packages/spec/src/docCitations.test.ts",
  "packages/spec/src/adrIndexDocs.test.ts",
  "packages/spec/src/apiReferenceDocs.test.ts",
  "packages/spec/src/fitnessDocs.test.ts",
  "packages/workflow-runtime/src/contextDocs.test.ts",
  "tools/scaffold/src/seamDocs.test.ts",
];

describe("fitness-function coverage (fitness)", () => {
  const doc = readFileSync(join(REPO_ROOT, DOC), "utf8");

  it("every registered fitness test exists", () => {
    expect(FITNESS_TESTS.filter((f) => !existsSync(join(REPO_ROOT, f)))).toEqual([]);
  });

  it("every registered fitness test is named in the normative doc", () => {
    // By FILE, not by prose: a passing mention of the concept elsewhere in the
    // page is exactly the vacuous match this is meant not to accept.
    const undocumented = FITNESS_TESTS.filter(
      (f) => !doc.includes(f) && !doc.includes(basename(f))
    );
    expect(
      undocumented,
      `add a row to ${DOC} — the list of enforced invariants must not omit one`
    ).toEqual([]);
  });

  it("the sweep can't silently match nothing", () => {
    expect(FITNESS_TESTS.length).toBeGreaterThanOrEqual(10);
  });
});

function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}
