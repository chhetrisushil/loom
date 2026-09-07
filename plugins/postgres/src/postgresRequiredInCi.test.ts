import { describe, expect, it } from "vitest";

// ── The guard on the gate ────────────────────────────────────────────────────
//
// Every Postgres suite in this package is gated on LOOM_TEST_POSTGRES_URL and
// skips cleanly without it, which is right for a laptop and was wrong for CI:
// the suites had never run there, and a skipped suite renders identically to a
// passing one. The workflow now provisions a service container — but a workflow
// is one file away from dropping that env line, and nothing would go red.
//
// So the requirement lives HERE, next to the suites it protects, where it
// survives any edit to the workflow. `CI` is set by GitHub Actions (and by every
// other runner worth the name); on a developer machine it is unset and the skip
// stays a skip.
describe("Postgres coverage in CI", () => {
  it("has a database to test against whenever CI is set", () => {
    if (process.env.CI === undefined) return; // a laptop may legitimately have none
    expect(
      process.env.LOOM_TEST_POSTGRES_URL,
      "LOOM_TEST_POSTGRES_URL is unset in CI, so every Postgres suite in this package " +
        "would SKIP and the run would still be green. Provision the service container " +
        "in .github/workflows/ci.yml (and keep the var declared in turbo.json's `test` " +
        "env, or a cached database-less run gets replayed over it)."
    ).toBeDefined();
  });
});
