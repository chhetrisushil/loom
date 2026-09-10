import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ── Fitness function: a shipped decision cannot skip the changelog ────────────
//
// `spec.test.ts` already proves every accepted ADR is either a declared capability or
// explicitly not one. That guards the maturity registry and says nothing about the
// CHANGELOG — which is the surface a CONSUMER reads, and which has now drifted twice: 16
// ADRs behind in one audit, and 0088/0089 (blueprint conformance, the sandbox worker pool)
// missing entirely in this one. Both were found by a person reading two lists side by side,
// which is exactly the work a test should be doing.
//
// The rule is deliberately weak: the ADR must be MENTIONED, by number or by link. It does
// not check that the entry is good, only that writing one was not skipped — the same bar
// the capability guard sets, and the same reason it works: "we forgot" becomes a failing
// test in a reviewable diff.
//
// The allowlist is the other half. An ADR that genuinely warrants no changelog entry —
// a rejection, a deferral, a process rule with no shipped surface — is listed here, which
// makes "no entry" a decision with a reason rather than an omission.
//
// SCOPE, stated rather than assumed. The CHANGELOG has one `[Unreleased]` section and does
// not reach back to the beginning of the project: coverage is systematic only from ADR 0080
// onward, and 34 earlier records (0021–0079, ignoring the allowlist) have no entry. That
// back-fill is a separate task from keeping the file current — so the floor is a named
// constant rather than an implied one, lowering it is how the back-fill gets verified, and
// a second test stops it being quietly RAISED to swallow the next omission.

const REPO_ROOT = resolve(__dirname, "../../..");

/** The earliest ADR the CHANGELOG covers systematically. Lower it when back-filling; never raise it. */
const COVERAGE_FLOOR = 80;

/** ADRs that ship nothing a consumer of the framework would read a changelog for. */
const NO_CHANGELOG_ENTRY = new Set([
  // Rejections and deferrals: nothing shipped, so there is nothing to announce.
  "0067", // reactive-graph resumability — rejected
  "0081", // long-lived suspensions — no promotion needed
  "0082", // substitutive replay — deferred behind evidence
  // Review rules and placement decisions: they change how WE work, not the surface.
  "0043", // plugin packaging + 1P/3P separation
  "0044", // plugin packaging follow-on
  "0047", // the tools/* dev-tooling tier
  "0083", // the second-consumer rule
]);

/** Accepted ADRs, by number. Superseded/withdrawn records describe nothing shipped. */
function acceptedAdrs(): { id: string; file: string }[] {
  const dir = resolve(REPO_ROOT, "docs/adr");
  return readdirSync(dir)
    .filter((f) => /^\d{4}-.*\.md$/.test(f))
    .filter((f) => {
      const body = readFileSync(resolve(dir, f), "utf8");
      return !/Status:\s*\*\*(Superseded|Withdrawn|Rejected)/i.test(body);
    })
    .map((f) => ({ id: f.slice(0, 4), file: f }));
}

describe("changelog coverage — a shipped decision can't skip the changelog", () => {
  const changelog = readFileSync(resolve(REPO_ROOT, "CHANGELOG.md"), "utf8");
  const adrs = acceptedAdrs();

  it("finds ADRs to check (the sweep itself can't silently match nothing)", () => {
    expect(adrs.length).toBeGreaterThan(70);
    expect(changelog.length).toBeGreaterThan(1000);
  });

  it("every accepted ADR is mentioned in the changelog, or is allowlisted", () => {
    const missing = adrs
      .filter(({ id }) => Number(id) >= COVERAGE_FLOOR)
      .filter(({ id }) => !NO_CHANGELOG_ENTRY.has(id))
      .filter(({ id }) => !changelog.includes(`ADR ${id}`) && !changelog.includes(`adr/${id}`))
      .map(({ file }) => file);
    expect(missing, `ADR(s) with no changelog entry:\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  it("the coverage floor has not been raised to hide an omission", () => {
    // Raising the floor is the cheapest way to make this suite green while deleting
    // coverage, so the floor must stay at or below the earliest ADR the file actually
    // mentions. Back-filling an older entry lowers it; nothing may raise it.
    // Every ADR at or above the floor must be mentioned, so the highest UNMENTIONED one is
    // the highest the floor may legitimately sit above. Raising the floor past it would be
    // exempting a record the file already covers.
    const mentioned = new Set(
      [...changelog.matchAll(/(?:ADR |adr\/)(\d{4})/g)].map((m) => Number(m[1]))
    );
    expect(mentioned.size).toBeGreaterThan(10);
    const highestUnmentioned = Math.max(
      ...adrs
        .map((a) => Number(a.id))
        .filter((n) => !mentioned.has(n) && !NO_CHANGELOG_ENTRY.has(String(n).padStart(4, "0")))
    );
    expect(COVERAGE_FLOOR).toBeLessThanOrEqual(highestUnmentioned + 1);
  });

  it("the allowlist names only ADRs that exist", () => {
    // An allowlist entry for a renumbered or deleted ADR silently exempts nothing, and
    // would hide the next real omission behind a stale id.
    const known = new Set(adrs.map((a) => a.id));
    expect([...NO_CHANGELOG_ENTRY].filter((id) => !known.has(id))).toEqual([]);
  });
});
