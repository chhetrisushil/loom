import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ── Fitness function: the examples catalogue lists every example ──────────────
//
// `docs/examples.md` is the index of the runnable apps in the sibling `loom-examples` repo, and
// it had drifted: ten examples existed there that the catalogue never named, so a reader picking
// a pattern could not find the example that teaches it (and could not tell "undocumented" from
// "does not exist").
//
// Enumerate the REGISTRY (the sibling checkout's `examples/*` directories) and assert each
// appears as a backticked name in the catalogue. A plain-substring match would let
// `db-command-center` vouch for `db-command-center-wc`, so the match is on the whole
// backticked token.
//
// The sibling checkout is absent in CI (and for anyone who has not cloned it), so the sweep is
// SKIPPED there, loudly, rather than passing vacuously. The matcher itself is also exercised
// against a planted fixture so the guard is proven able to fail without the sibling.

const REPO_ROOT = resolve(__dirname, "../../..");
const DOC = join(REPO_ROOT, "docs/examples.md");
const SIBLING = resolve(REPO_ROOT, "../loom-examples/examples");

/** Example names (backticked tokens) the catalogue mentions. */
function namedIn(doc: string): Set<string> {
  return new Set([...doc.matchAll(/`([a-z0-9][a-z0-9-]*)`/g)].map((m) => m[1] as string));
}

/** The examples in `names` that `doc` never names. */
function missingFrom(doc: string, names: readonly string[]): string[] {
  const named = namedIn(doc);
  return names.filter((n) => !named.has(n));
}

describe("examples catalogue coverage (fitness)", () => {
  const doc = readFileSync(DOC, "utf8");

  it("the matcher reports a name the catalogue lacks (the guard can fail)", () => {
    expect(missingFrom(doc, ["loom-starter", "zz-planted-missing-example"])).toEqual([
      "zz-planted-missing-example",
    ]);
    // a prefix is not a mention: `db-command-center` must not vouch for a longer name
    expect(missingFrom("- **`db-command-center`**", ["db-command-center-wc"])).toEqual([
      "db-command-center-wc",
    ]);
  });

  const present = existsSync(SIBLING);
  (present ? it : it.skip)(
    "every ../loom-examples/examples/* appears in docs/examples.md (skipped: no sibling checkout)",
    () => {
      const names = readdirSync(SIBLING)
        .filter((e) => !e.startsWith(".") && e !== "node_modules")
        .filter((e) => statSync(join(SIBLING, e)).isDirectory())
        .sort();
      expect(names.length, "the sweep can't silently match nothing").toBeGreaterThan(10);
      expect(missingFrom(doc, names), "add an entry to docs/examples.md").toEqual([]);
    }
  );
});
