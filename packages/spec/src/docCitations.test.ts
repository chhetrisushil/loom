import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ── Fitness function: reference docs don't cite line numbers ─────────────────
//
// `docs/loom-2.0/*` is presented as a description of the CURRENT system, and it
// used to cite source by line — `AgentRunner.ts:55`. Those rot on the next edit,
// silently and invisibly: an audit found 40 citations across the corpus landing
// on a blank line, a closing brace or a comment terminator, five of them made
// wrong by a single afternoon's refactor. A wrong line number is worse than
// none, because it looks authoritative and sends the reader somewhere unrelated.
//
// So: cite the FILE, and let the surrounding prose name the symbol. A path is
// stable under edits and a symbol is greppable; a line number is neither.
//
// ADRs and requirements docs are deliberately NOT covered. They are dated
// records of what was true when written — "correcting" their line numbers would
// falsify the record rather than maintain it.

const REPO_ROOT = resolve(__dirname, "../../..");
const REFERENCE_DOCS = join(REPO_ROOT, "docs/loom-2.0");

/** `path/File.ts:12` or `File.ts:12-40`, inside backticks. */
const LINE_CITATION = /`[\w./-]+\.ts:\d+(?:[,-]\d+)?`/g;

function citationsIn(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(LINE_CITATION)].map((m) => m[0]);
}

describe("reference-doc citations (fitness)", () => {
  const docs = readdirSync(REFERENCE_DOCS)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(REFERENCE_DOCS, f));

  it("finds the reference chapters (the sweep can't silently match nothing)", () => {
    expect(docs.length).toBeGreaterThanOrEqual(6);
  });

  it("no chapter cites source by line number", () => {
    const offenders = docs.flatMap((d) =>
      citationsIn(d).map((c) => `${d.slice(REPO_ROOT.length + 1)} → ${c}`)
    );
    expect(offenders, "cite the file; a line number rots on the next edit").toEqual([]);
  });

  it("every cited source file exists", () => {
    // The other half: a path left behind by a rename points at nothing at all.
    const missing: string[] = [];
    for (const doc of docs) {
      const body = readFileSync(doc, "utf8");
      for (const m of body.matchAll(/`((?:packages|plugins|tools)\/[\w./-]+\.ts)`/g)) {
        if (!existsSync(join(REPO_ROOT, m[1] as string))) {
          missing.push(`${doc.slice(REPO_ROOT.length + 1)} → ${m[1]}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("every relative link in every doc resolves", () => {
    // Unambiguous everywhere, including ADRs: a dead link in a historical record
    // is still dead. This caught a link written minutes earlier in the same
    // audit that added the test — `0043-plugin-packaging-and-placement.md`, a
    // plausible-looking name for a file actually called
    // `0043-plugin-packaging-and-1p-3p-separation.md`.
    const broken: string[] = [];
    for (const doc of allDocs(join(REPO_ROOT, "docs"))) {
      const dir = doc.slice(0, doc.lastIndexOf("/"));
      for (const m of readFileSync(doc, "utf8").matchAll(
        /\]\((?!https?:|#|mailto:)([^)#\s]+)(?:#[^)\s]*)?\)/g
      )) {
        if (!existsSync(resolve(dir, m[1] as string))) {
          broken.push(`${doc.slice(REPO_ROOT.length + 1)} → ${m[1]}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});

/** Every markdown file under a directory, recursively. */
function allDocs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allDocs(p));
    else if (entry.name.endsWith(".md")) out.push(p);
  }
  return out;
}
