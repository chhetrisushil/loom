import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ── Fitness function: a context call cannot ship without its durability ───────
//
// `docs/usage.md` carries the canonical table of what a runner body may call. Two
// drifts had accumulated in it, and neither is visible from the code side:
//
//  1. `ctx.stream` was described as "Stream token/deltas (e.g. LLM output)" while
//     `docs/user-guide.md` showed the idiom PER TOKEN. Every call is an `emit`, so
//     the documented shape produces one permanently load-bearing event per token —
//     precisely the fold economics ST-R rejected when it was proposed as a kernel
//     feature. The doc was the only place that cost was decidable, and it omitted it.
//  2. `execute`, `decide` and `negotiateBudget` — the generalized durable primitive
//     and the P9 decision seam — appeared NOWHERE in the file. The table documented
//     the Loom 1.x surface.
//
// So the guard runs both directions. One-directional doc checks are what let the
// published compatibility matrix drift in the first place: a check that only asks
// "is every documented thing real" never notices the thing nobody documented.
//
// Deliberately NOT checked, because a check that appeared to cover it and could not
// would be worse than knowing it is manual: whether a row's durability claim is
// TRUE. Presence is mechanical; accuracy is review.

const REPO_ROOT = resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

const USAGE = "docs/usage.md";
const TYPES = "packages/workflow-runtime/src/types.ts";

/**
 * Identity fields rather than calls: nothing enters the log, so durability is not a
 * property they have. Asserted to be REAL members below, so a rename cannot quietly
 * widen the exemption into a hole.
 */
const NOT_CALLS = ["executionId", "workflowId"];

/** The vocabulary a row must use. Kept small so "documented" means one of these words. */
const DURABILITY_TERMS = ["durable", "durably", "recorded", "transient"];

/** Every member declared on the `ExecutionContext` interface. */
function contextMembers(typesSrc: string): string[] {
  const start = typesSrc.indexOf("export interface ExecutionContext");
  if (start === -1) return [];
  const body = typesSrc.slice(start, typesSrc.indexOf("\n}", start));
  const names = new Set<string>();
  for (const m of body.matchAll(/^ {2}(?:readonly )?([a-zA-Z]+)[<(:]/gm)) names.add(m[1] as string);
  return [...names];
}

interface TableRow {
  /** Every `ctx.<name>` named in the row's first cell — a row may cover two calls. */
  members: string[];
  purpose: string;
}

/**
 * Rows of the `| Call | Purpose |` table. Anchored on the header, not on the whole
 * file: `ctx.signal` is discussed in the effects prose further down and belongs to
 * `EffectContext`, so a file-wide scan would report it as a phantom member.
 */
function contextTable(usage: string): TableRow[] {
  const header = usage.indexOf("| Call | Purpose |");
  if (header === -1) return [];
  const rows: TableRow[] = [];
  for (const line of usage.slice(header).split("\n").slice(2)) {
    if (!line.startsWith("|")) break; // the table ends at the first non-row
    const cells = line.split("|").map((c) => c.trim());
    const members = [...(cells[1] ?? "").matchAll(/ctx\.([a-zA-Z]+)/g)].map((m) => m[1] as string);
    rows.push({ members, purpose: cells[2] ?? "" });
  }
  return rows;
}

/** Calls whose row says nothing about whether the call is durable. */
function callsMissingDurability(rows: TableRow[]): string[] {
  const lacks = (purpose: string) => {
    const text = purpose.toLowerCase();
    return !DURABILITY_TERMS.some((t) => text.includes(t));
  };
  return rows.filter((r) => lacks(r.purpose)).flatMap((r) => r.members);
}

/** Interface members with no row in the table. Prose elsewhere does not count. */
function membersMissingRow(members: string[], rows: TableRow[]): string[] {
  const documented = new Set(rows.flatMap((r) => r.members));
  return members.filter((m) => !NOT_CALLS.includes(m) && !documented.has(m));
}

/** Rows naming something the interface does not have (typo, rename, removal). */
function rowsNamingUnknownMember(members: string[], rows: TableRow[]): string[] {
  return rows.flatMap((r) => r.members).filter((m) => !members.includes(m));
}

describe("context/doc durability coverage (fitness)", () => {
  const members = contextMembers(read(TYPES));
  const rows = contextTable(read(USAGE));

  // ── The inputs must be populated ─────────────────────────────────────────────
  // Both checks below are set-differences, so an empty input passes vacuously. These
  // two assertions are what make the rest of the suite mean anything.

  it("parses the ExecutionContext surface", () => {
    expect(members).toContain("execute");
    expect(members).toContain("ui");
    expect(members.length).toBeGreaterThanOrEqual(10);
  });

  it("parses the usage table", () => {
    // Rows, not members: one row may cover two calls (`sleep` / `sleepUntil`), so
    // counting rows against the interface would be an accidental coverage check.
    // What this asserts is that parsing produced usable rows at all.
    expect(rows.length).toBeGreaterThanOrEqual(8);
    expect(rows.filter((r) => r.members.length === 0 || r.purpose === "")).toEqual([]);
  });

  it("exempts only fields that really exist", () => {
    expect(NOT_CALLS.filter((n) => !members.includes(n))).toEqual([]);
  });

  // ── The two directions ───────────────────────────────────────────────────────

  it("every documented call states its durability", () => {
    expect(callsMissingDurability(rows)).toEqual([]);
  });

  it("every context member has a row", () => {
    expect(membersMissingRow(members, rows)).toEqual([]);
  });

  it("every row names a real member", () => {
    expect(rowsNamingUnknownMember(members, rows)).toEqual([]);
  });

  // ── The checks must be able to FAIL ──────────────────────────────────────────
  // A guard nobody has watched fail is indistinguishable from a comment.

  const TABLE = [
    "| Call | Purpose |",
    "|---|---|",
    "| `ctx.emit(type, payload)` | Append a **durable** domain event |",
    "| `ctx.sleep(ms)` / `ctx.sleepUntil(at)` | **Durable** timer suspension |",
    "",
    "prose after the table mentions `ctx.decide` in passing",
  ].join("\n");

  it("reports a row that describes a call without naming durability", () => {
    const vague = TABLE.replace("Append a **durable** domain event", "Emit a domain event");
    expect(callsMissingDurability(contextTable(vague))).toEqual(["emit"]);
  });

  it("reports both calls when a two-call row omits durability", () => {
    const vague = TABLE.replace("**Durable** timer suspension", "Sleep for a while");
    expect(callsMissingDurability(contextTable(vague))).toEqual(["sleep", "sleepUntil"]);
  });

  it("is not satisfied by a mention outside the table", () => {
    // The failure mode a whole-file `toContain` check would have: the word is in
    // the file, the row is not.
    expect(membersMissingRow(["emit", "decide"], contextTable(TABLE))).toEqual(["decide"]);
  });

  it("reports every call when the table is gone", () => {
    const missing = membersMissingRow(members, contextTable("# usage\n\nno table here"));
    expect(missing).toEqual(members.filter((m) => !NOT_CALLS.includes(m)));
    expect(missing.length).toBeGreaterThan(0);
  });

  it("reports a renamed or misspelled member", () => {
    const typo = TABLE.replace("ctx.emit(type, payload)", "ctx.emitt(type, payload)");
    expect(rowsNamingUnknownMember(members, contextTable(typo))).toEqual(["emitt"]);
  });

  it("finds no members when the interface is renamed, which the input check catches", () => {
    expect(contextMembers("export interface SomethingElse {\n  emit(): void;\n}")).toEqual([]);
  });
});
