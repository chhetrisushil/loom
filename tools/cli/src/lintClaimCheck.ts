import * as fs from "node:fs";
import * as path from "node:path";

// ── CC-5 (ADR 0054) — claim-check reach-through lint ──────────────────────────
//
// The claim-check contract: the log records `{ ref, size, digest }` AS the step
// output; orchestration may branch on the recorded envelope (in practice the
// digest — the tool's declared deterministic projection) but must never resolve
// the ref back into payload content INSIDE the determinism boundary — replay
// never resolves, so flow control fed by resolved content diverges. Resolution
// belongs outside flows (UI evidence rendering, exports). Per ADR 0044/0047
// this is dev tooling over source conventions, not a compiler plugin.

export type ClaimCheckLintRule = "resolve-inside-flow" | "forged-envelope";

export interface ClaimCheckLintFinding {
  file: string;
  line: number;
  rule: ClaimCheckLintRule;
  message: string;
}

/** A module is inside the determinism boundary iff it defines flows/steps/handlers. */
const FLOW_MARKERS = ["flow$(", "step$(", "handler$("];

/**
 * Lint one module. Pure. Only flow-defining modules are checked:
 *  - `resolve-inside-flow`: `resolveClaimCheck` referenced where flows are
 *    defined — resolved payload content feeding flow control reintroduces
 *    nondeterminism. (Branching on the envelope itself — `isClaimCheck`, the
 *    digest, `size` — is the sanctioned pattern and is NOT flagged.)
 *  - `forged-envelope`: a `__loomClaimCheck:` literal — envelopes are minted by
 *    the middleware from stored bytes; a hand-built one cites content that may
 *    not exist and breaks hash verifiability.
 */
export function lintClaimCheckSource(file: string, source: string): ClaimCheckLintFinding[] {
  if (!FLOW_MARKERS.some((marker) => source.includes(marker))) return [];
  const findings: ClaimCheckLintFinding[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    if (text.includes("resolveClaimCheck")) {
      findings.push({
        file,
        line: i + 1,
        rule: "resolve-inside-flow",
        message:
          "resolveClaimCheck inside a flow-defining module: replay never resolves refs, so flow control fed by resolved content diverges — branch on the recorded digest instead, and resolve only outside the determinism boundary (UI/export)",
      });
    }
    if (text.includes("__loomClaimCheck:")) {
      findings.push({
        file,
        line: i + 1,
        rule: "forged-envelope",
        message:
          "hand-built claim-check envelope (__loomClaimCheck literal) in a flow-defining module: envelopes are minted by claimCheckMiddleware from stored bytes — a forged one cites content that may not exist and defeats hash verifiability",
      });
    }
  }
  return findings;
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".loom"]);

function walkTsFiles(dir: string, into: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue; // never follow links (loops / tree escape)
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkTsFiles(full, into);
      continue;
    }
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) continue;
    into.push(full);
  }
}

/** `loom lint claim-check [--dir .]` — scan a source tree; exit non-zero on findings. */
export function cmdLintClaimCheck(dir: string): {
  text: string;
  findings: ClaimCheckLintFinding[];
} {
  const files: string[] = [];
  walkTsFiles(dir, files);
  const findings = files.flatMap((file) =>
    lintClaimCheckSource(file, fs.readFileSync(file, "utf-8"))
  );
  const text =
    findings.length === 0
      ? `✓ no claim-check reach-through (${files.length} file(s) scanned)`
      : `${findings
          .map((f) => `  ✗ ${f.file}:${f.line} [${f.rule}] ${f.message}`)
          .join("\n")}\n\n${findings.length} finding(s) in ${files.length} file(s)`;
  return { text, findings };
}
