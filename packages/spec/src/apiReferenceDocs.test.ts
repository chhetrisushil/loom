import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ── Fitness function: every workspace package has a section in the API reference ──
//
// `docs/api-reference.org` opens by promising every workspace package a section, which is a claim
// about the whole workspace and therefore wrong the moment a package ships without one. It had been
// wrong for a while, when the document still called itself exhaustive: SIXTEEN of 61 packages had no section at all —
// `@loomwork/knowledge` (a package, not a helper), `@loomwork/classify`, `@loomwork/compliance`,
// `@loomwork/orchestration`, `@loomwork/saga`, `@loomwork/live-query`, `@loomwork/plugin-read-model`,
// `@loomwork/plugin-sandbox` and eight more. A reader looking one of them up found nothing and had
// no way to tell "undocumented" from "does not exist".
//
// Same shape as `seamDocs` and `ruleDocs`: enumerate the REGISTRY (here, the workspace itself),
// and assert a HEADING rather than a mention, because a passing reference in someone else's
// section is exactly the vacuous match this is meant not to accept.

const REPO_ROOT = resolve(__dirname, "../../..");
const DOC = "docs/api-reference.org";

/** Packages deliberately absent, each with the reason it is not part of the public surface. */
const NOT_IN_REFERENCE: ReadonlyMap<string, string> = new Map([
  [
    "@loomwork/dst",
    "deterministic-simulation harness — a test tool, imported by no runtime package",
  ],
  ["@loomwork/bench-throughput", "the throughput bench; not published surface"],
  ["@loomwork/create-loom-app", "an npm initializer, driven by `npm create`, not imported"],
]);

/** Every workspace package that ships built typings — i.e. that a consumer can import. */
function publishedPackages(): { name: string; dir: string }[] {
  const out: { name: string; dir: string }[] = [];
  for (const base of ["packages", "plugins", "tools"]) {
    const root = resolve(REPO_ROOT, base);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const pkgJson = join(root, entry, "package.json");
      if (!existsSync(pkgJson)) continue;
      const name = JSON.parse(readFileSync(pkgJson, "utf8")).name as string;
      if (!name?.startsWith("@loomwork/")) continue;
      out.push({ name, dir: join(root, entry) });
    }
  }
  return out;
}

describe("api-reference coverage (fitness)", () => {
  const doc = readFileSync(join(REPO_ROOT, DOC), "utf8");
  // Org headings only: `** ~@loomwork/x~ — …`. A mention inside another package's prose is not a
  // section, and treating it as one is how the document came to claim 61 and carry 45.
  const headed = new Set(
    doc
      .split("\n")
      .filter((line) => /^\*+\s/.test(line))
      // ALL names on the line, not the first: several sections cover a family
      // (`@loomwork/capability~ / ~@loomwork/intent~ / ~@loomwork/planner~`) and capturing one would
      // report the others missing while they are documented right there.
      .flatMap((line) => [...line.matchAll(/~(@loomwork\/[\w-]+)~/g)].map((m) => m[1] as string))
  );

  it("finds the reference and its headings (the sweep can't silently match nothing)", () => {
    expect(doc.length).toBeGreaterThan(10_000);
    expect(headed.size).toBeGreaterThan(30);
    expect(publishedPackages().length).toBeGreaterThan(50);
  });

  it("every package with published typings has a section, or is listed as not public surface", () => {
    const missing = publishedPackages()
      .filter(({ name }) => !NOT_IN_REFERENCE.has(name))
      .filter(({ name }) => !headed.has(name))
      .map(({ name }) => name);
    expect(
      missing,
      `add a section to ${DOC} (or an entry to NOT_IN_REFERENCE with its reason) — the document promises every package a section`
    ).toEqual([]);
  });

  it("the exemption list names only packages that exist", () => {
    const known = new Set(publishedPackages().map((p) => p.name));
    expect([...NOT_IN_REFERENCE.keys()].filter((n) => !known.has(n))).toEqual([]);
  });
});
