import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ── Fitness function: no raw control bytes in tracked text files ─────────────
//
// A literal NUL byte in a source file makes git classify the WHOLE file as
// binary. `git diff`, `blame` and `log -p` then report `-` / `-` and show no
// content at all — every review of that file flies blind, and nothing announces
// it. `packages/learning/src/trajectories.ts` was in that state from the day it
// was written: it used NUL as a composite-key separator (correctly — NUL cannot
// occur in an id, so no pair of ids can spell another pair's key) but wrote the
// character rather than the `\u0000` ESCAPE, which produces the identical string
// with none of the damage.
//
// It is mechanized here rather than left to review because the symptom is
// SILENCE. A stale document eventually reads wrong to somebody; an undiffable
// file just quietly shows nothing, and the one tool that would tell you is the
// tool that has been disabled. Two instances inside a day — the one above, and
// one introduced while fixing #306 and caught only because the diff went binary
// in review — is enough for a class that no reviewer can be expected to spot.
//
// Design notes, carried from the guards in `@loom/verify` and `@loom/scaffold`:
//   - Walk the tree; never keep a list of files to check beside the check.
//   - The detector is exercised on synthetic content that MUST fail, below. A
//     guard nobody has watched fail is indistinguishable from a comment.
//   - Report `path:line` and the offending code point, because "some file
//     contains a control byte" is not an actionable failure.

const REPO_ROOT = resolve(__dirname, "../../..");
const ROOTS = ["packages", "plugins", "tools", "docs"];
const SKIP = new Set(["node_modules", "dist", ".turbo", ".vite", "coverage", "build", ".git"]);
const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".org", ".yml", ".yaml"];

/**
 * Control characters that must never appear RAW in a text file. Tab, newline and
 * carriage return are the three that legitimately do; everything else below 0x20
 * (plus DEL) belongs in source only as an escape. NUL is the one that actually
 * breaks git, but the rest — ESC in particular, which is easy to paste in from
 * terminal output — are the same mistake with a quieter blast radius.
 */
function findControlBytes(content: Buffer): Array<{ line: number; codePoint: number }> {
  const found: Array<{ line: number; codePoint: number }> = [];
  let line = 1;
  for (const byte of content) {
    if (byte === 0x0a) {
      line++;
      continue;
    }
    if (byte === 0x09 || byte === 0x0d) continue;
    if (byte < 0x20 || byte === 0x7f) found.push({ line, codePoint: byte });
  }
  return found;
}

function textFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) walk(resolve(dir, entry.name));
      } else if (EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        out.push(resolve(dir, entry.name));
      }
    }
  };
  for (const root of ROOTS) walk(resolve(REPO_ROOT, root));
  return out;
}

const hex = (codePoint: number): string => `\\u${codePoint.toString(16).padStart(4, "0")}`;

describe("source hygiene: no raw control bytes", () => {
  it("detects a raw NUL, and the escape spelling of the same key is clean", () => {
    // The failing case the whole guard rests on. `\u0000` in a template literal is
    // the CORRECT way to write the separator `trajectories.ts` needed; the raw byte
    // is what turns the file binary. The detector must tell them apart.
    const raw = Buffer.from(`const key = \`\${a}${String.fromCharCode(0)}\${b}\`;\n`, "utf8");
    const escaped = Buffer.from("const key = `${a}\\u0000${b}`;\n", "utf8");

    expect(findControlBytes(raw)).toEqual([{ line: 1, codePoint: 0 }]);
    expect(findControlBytes(escaped)).toEqual([]);
  });

  it("reports the line, and counts tab/newline/CR as legitimate", () => {
    const content = Buffer.from(`a\tb\r\nsecond\nthird${String.fromCharCode(27)}\n`, "utf8");
    expect(findControlBytes(content)).toEqual([{ line: 3, codePoint: 27 }]);
  });

  it("finds no raw control byte anywhere in the repo's text files", () => {
    const offenders = textFiles().flatMap((file) => {
      const hits = findControlBytes(readFileSync(file));
      return hits.map((h) => `${relative(REPO_ROOT, file)}:${h.line} contains ${hex(h.codePoint)}`);
    });
    // Named, not counted: a bare "expected 3 to be 0" sends the reader hunting for a
    // file git will refuse to show them.
    expect(offenders).toEqual([]);
  });

  it("actually looked at the tree it claims to cover", () => {
    // The vacuous-check guard: a walk that silently found nothing would make the
    // assertion above pass forever. This is the input the real check depends on.
    const files = textFiles();
    expect(files.length).toBeGreaterThan(500);
    expect(files.some((f) => f.endsWith("packages/learning/src/trajectories.ts"))).toBe(true);
  });
});
