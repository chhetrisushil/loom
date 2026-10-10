import { type Dirent, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ── Fitness function: a test server binds the address its client dials ───────
//
// `server.listen(0)` with no host binds the wildcard (`::`, dual-stack). On macOS the
// ephemeral-port counter is system-wide, and a wildcard bind does NOT collide with a
// 127.0.0.1-specific bind held by another process — so the kernel can hand the test
// server a port that Ollama, a throwaway Postgres, or another suite's 127.0.0.1 test
// server already owns. The client then dials `http://127.0.0.1:<port>`, the more
// specific listener wins, and the test talks to a stranger. That was the
// `plugins/mcp` uiDispatch flake: under `turbo test` the counter wraps through ports
// other processes hold; occupying the next ports on 127.0.0.1 reproduces it 17/20.
//
// The rule, for every `*.test.ts` under packages/plugins/tools: a `.listen(0…)` names
// a host. A string literal or a separate host argument both count; `listen(0)` and
// `listen(0, callback)` do not. It is a lint, not a parser, exercised below on
// content that MUST fail.

const REPO_ROOT = resolve(__dirname, "../../..");
const ROOTS = ["packages", "plugins", "tools"];
const SKIP = new Set(["node_modules", "dist", ".turbo", ".vite", "coverage", "build", ".git"]);

/** The argument list after `.listen(0`, up to the matching `)` on the same line. */
function listenArgsAfterPort(code: string, from: number): string {
  let depth = 1;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (depth === 0) return code.slice(from, i);
    }
  }
  return code.slice(from);
}

/** Top-level comma count in an argument tail (`, a, b` → 2). */
function topLevelCommas(args: string): number {
  let depth = 0;
  let n = 0;
  for (const c of args) {
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) n++;
  }
  return n;
}

function findWildcardListens(source: string): number[] {
  const out: number[] = [];
  source.split("\n").forEach((text, i) => {
    const code = text.replace(/\/\/.*$/, "");
    const re = /\.listen\(\s*0\b/g;
    for (let m = re.exec(code); m !== null; m = re.exec(code)) {
      const tail = listenArgsAfterPort(code, m.index + m[0].length).trim();
      if (tail === "") {
        out.push(i + 1); // listen(0)
        continue;
      }
      const second = tail.replace(/^,\s*/, "");
      if (/^["'`]/.test(second)) continue; // listen(0, "127.0.0.1", …)
      if (topLevelCommas(tail) >= 2) continue; // listen(0, host, cb)
      out.push(i + 1); // listen(0, cb)
    }
  });
  return out;
}

function walk(dir: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // vanished mid-walk (another package's scratch dir)
  }
  for (const e of entries) {
    if (SKIP.has(e.name) || e.name.startsWith(".tmp")) continue;
    const p = resolve(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".test.ts") && p !== __filename) out.push(p);
  }
}

describe("test servers bind the address their client dials (fitness)", () => {
  it("the detector fails on a wildcard listen and passes a named host", () => {
    const bad = [
      "server.listen(0);",
      "server.listen(0, () => {",
      "await new Promise<void>((r) => s.listen(0, r));",
      "server.listen(0, () => resolve(server.address()));",
    ];
    for (const s of bad) expect(findWildcardListens(s), s).toEqual([1]);
    const good = [
      'server.listen(0, "127.0.0.1", () => {',
      "await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));",
      "server.listen(0, host, () => resolve());",
      "server.listen(port, () => {",
      "// server.listen(0) in a comment",
    ];
    for (const s of good) expect(findWildcardListens(s), s).toEqual([]);
  });

  it("finds the test files (the sweep cannot silently match nothing)", () => {
    const files: string[] = [];
    for (const r of ROOTS) walk(resolve(REPO_ROOT, r), files);
    expect(files.length).toBeGreaterThan(200);
  });

  it("no test server listens on an ephemeral port without naming a host", () => {
    const files: string[] = [];
    for (const r of ROOTS) walk(resolve(REPO_ROOT, r), files);
    const offenders: string[] = [];
    for (const f of files) {
      let src: string;
      try {
        src = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      for (const line of findWildcardListens(src))
        offenders.push(`${relative(REPO_ROOT, f)}:${line}`);
    }
    expect(
      offenders,
      'bind the host the client dials: `server.listen(0, "127.0.0.1", cb)` — a wildcard bind can share a port with another process\'s 127.0.0.1 listener'
    ).toEqual([]);
  });
});
