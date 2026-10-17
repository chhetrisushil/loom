import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCS } from "./retrieval/corpus";
import { QUERIES as RETRIEVAL_QUERIES } from "./retrieval/queries";
import { INTENTS } from "./skills/intents";
import { SKILLS } from "./skills/skills";
import { ANNOTATIONS, TOOLS } from "./toolSearch/catalogue";
import { QUERIES as TOOL_QUERIES } from "./toolSearch/queries";

// ADR 0131 verification (d) and D4.6: the sweep DISCOVERS the datasets by walking the directory (so an empty or
// missing one cannot pass by never being looked at), and holds each to the dataset rules.

const SRC = __dirname;

/** A dataset directory is any directory under `src/` that holds a `thresholds.ts` (every eval area does). */
function datasetDirs(): string[] {
  return readdirSync(SRC)
    .map((n) => join(SRC, n))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, "thresholds.ts")))
    .sort();
}

/** Dataset content files: everything in the directory except tests, the measure code and the thresholds. */
function contentFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => !/\.test\.ts$|^measure\.ts$|^thresholds\.ts$/.test(f))
    .map((f) => join(dir, f));
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/;
const KNOWN_TOKEN =
  /\b(?:sk|pk|rk)[-_][A-Za-z0-9]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{12,}|\bxox[abpr]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
/** A long unbroken run mixing letters and digits (or base64/hex-looking): not prose, not a skill id. */
const OPAQUE_RUN = /(?=[A-Za-z0-9+/_=-]*[0-9])(?=[A-Za-z0-9+/_=-]*[A-Za-z])[A-Za-z0-9+/_=-]{32,}/;

const looksLikeRealData = (text: string): string | undefined =>
  EMAIL.test(text)
    ? "email address"
    : KNOWN_TOKEN.test(text) || OPAQUE_RUN.test(text)
      ? "token-shaped string"
      : undefined;

describe("dataset sweep", () => {
  const dirs = datasetDirs();

  it("discovers every eval area (a non-zero, expected count - an empty walk cannot pass)", () => {
    expect(dirs.length).toBeGreaterThanOrEqual(3);
    expect(dirs.map((d) => d.split("/").pop())).toEqual(
      expect.arrayContaining(["retrieval", "skills", "toolSearch"])
    );
  });

  it("every dataset has a PROVENANCE.md with labeller, source, date and label rules", () => {
    for (const d of dirs) {
      const p = join(d, "PROVENANCE.md");
      expect(existsSync(p), `${d} has no PROVENANCE.md`).toBe(true);
      const text = readFileSync(p, "utf8");
      for (const need of [
        "Labeller",
        "Source",
        "Date",
        "Label rules",
        "Label edits after measurement",
      ]) {
        expect(text, `${p} lacks "${need}"`).toContain(need);
      }
    }
  });

  it("no dataset file contains an email address or a token-shaped string", () => {
    let scanned = 0;
    for (const d of dirs) {
      for (const f of contentFiles(d)) {
        scanned++;
        expect(
          looksLikeRealData(readFileSync(f, "utf8")),
          `${f} looks like it holds real data`
        ).toBeUndefined();
      }
    }
    expect(scanned).toBeGreaterThanOrEqual(9); // 3 areas x (2 data files + PROVENANCE.md)
  });

  it("the real-data detector fires on what it is meant to catch (and not on prose)", () => {
    expect(looksLikeRealData("write to dana@example.com")).toBe("email address");
    expect(looksLikeRealData("key sk-live4f9a8b7c6d5e4f3a2b1c0d9e")).toBe("token-shaped string");
    expect(looksLikeRealData("ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe("token-shaped string");
    expect(looksLikeRealData("token 3f2a9c1b7d4e8f0a5b6c3d2e1f0a9b8c7d6e5f4a")).toBe(
      "token-shaped string"
    );
    expect(looksLikeRealData("refund the customer's card, then post an update")).toBeUndefined();
    expect(looksLikeRealData("customer-refund-handling")).toBeUndefined();
  });

  it("tool search: sizes, unique ids, and every label resolves", () => {
    expect(TOOLS.length).toBeGreaterThanOrEqual(60);
    expect(TOOL_QUERIES.length).toBeGreaterThanOrEqual(40);
    const ids = new Set(TOOLS.map((t) => t.id));
    expect(ids.size).toBe(TOOLS.length);
    expect(new Set(TOOL_QUERIES.map((q) => q.id)).size).toBe(TOOL_QUERIES.length);
    for (const q of TOOL_QUERIES) {
      expect(q.relevant.length, q.id).toBeGreaterThan(0);
      for (const r of q.relevant) expect(ids.has(r), `${q.id} -> ${r}`).toBe(true);
    }
    for (const id of Object.keys(ANNOTATIONS)) expect(ids.has(id), `annotation ${id}`).toBe(true);
    for (const kind of ["plain", "stoplist", "annotation"] as const) {
      expect(TOOL_QUERIES.filter((q) => q.kind === kind).length, kind).toBeGreaterThanOrEqual(8);
    }
  });

  it("retrieval: sizes, unique ids, every query has a graded document and every grade resolves", () => {
    expect(DOCS.length).toBeGreaterThanOrEqual(40);
    expect(RETRIEVAL_QUERIES.length).toBeGreaterThanOrEqual(30);
    const ids = new Set(DOCS.map((d) => d.id));
    expect(ids.size).toBe(DOCS.length);
    expect(new Set(RETRIEVAL_QUERIES.map((q) => q.id)).size).toBe(RETRIEVAL_QUERIES.length);
    for (const q of RETRIEVAL_QUERIES) {
      const graded = Object.entries(q.grades);
      expect(graded.length, q.id).toBeGreaterThan(0);
      expect(
        graded.some(([, g]) => g === 2),
        `${q.id} has no grade-2 document`
      ).toBe(true);
      for (const [id] of graded) expect(ids.has(id), `${q.id} -> ${id}`).toBe(true);
    }
  });

  it("skills: sizes, unique ids, and expected is always inside acceptable", () => {
    expect(SKILLS.length).toBeGreaterThanOrEqual(15);
    expect(INTENTS.length).toBeGreaterThanOrEqual(30);
    const ids = new Set(SKILLS.map((s) => s.id));
    expect(ids.size).toBe(SKILLS.length);
    expect(new Set(INTENTS.map((i) => i.id)).size).toBe(INTENTS.length);
    for (const i of INTENTS) {
      expect(i.acceptable, i.id).toContain(i.expected);
      for (const a of i.acceptable) expect(ids.has(a), `${i.id} -> ${a}`).toBe(true);
    }
  });
});
