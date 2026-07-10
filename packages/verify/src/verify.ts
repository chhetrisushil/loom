import { RULES, RULE_ORDER } from "./rules";
import type { VerificationReport, VerifyInput, VerifyMode, VerifyOptions } from "./types";

/** Thrown by `runVerification` in `"error"` mode when the report is not `ok`. */
export class VerificationError extends Error {
  readonly report: VerificationReport;
  constructor(report: VerificationReport) {
    super(formatReport(report));
    this.name = "VerificationError";
    this.report = report;
  }
}

/**
 * Run the pre-flight rules over a structural config projection. Pure, read-only,
 * off-log: emits no events, starts no execution, touches no store.
 */
export function verify(input: VerifyInput, options?: VerifyOptions): VerificationReport {
  const checked = options?.rules ?? RULE_ORDER;
  const findings = checked.flatMap((name) => RULES[name](input));
  const ok = !findings.some((f) => f.severity === "error");
  return { ok, findings, checked };
}

/**
 * Mode gate wired at startup / in the CLI.
 *
 * - `"off"` (default): returns `null` **without calling `buildInput`** — the config
 *   projection is never even built, so this path is byte-identical to not wiring verify
 *   (G2, benchmark-provable in `verify.bench.ts`).
 * - `"warn"`: builds + verifies, logs the report if there are any findings, returns it.
 * - `"error"`: builds + verifies, throws `VerificationError` before the first execution
 *   if the report is not `ok`.
 */
export function runVerification(
  mode: VerifyMode,
  buildInput: () => VerifyInput,
  options?: VerifyOptions,
  log: (message: string) => void = defaultLog
): VerificationReport | null {
  if (mode === "off") return null;
  const report = verify(buildInput(), options);
  if (mode === "error" && !report.ok) {
    throw new VerificationError(report);
  }
  if (report.findings.length > 0) {
    log(formatReport(report));
  }
  return report;
}

/** Default logger — routes to `console.error` when available, without depending on ambient globals. */
function defaultLog(message: string): void {
  const c = (globalThis as { console?: { error?: (m: string) => void } }).console;
  c?.error?.(message);
}

/** Human-readable one-block rendering of a report (used by the CLI and error message). */
export function formatReport(report: VerificationReport): string {
  if (report.findings.length === 0) {
    return `loom verify: ${report.checked.length} rule(s) passed, no findings.`;
  }
  const errors = report.findings.filter((f) => f.severity === "error").length;
  const warnings = report.findings.filter((f) => f.severity === "warn").length;
  const lines = report.findings.map(
    (f) => `  [${f.severity}] ${f.rule}${f.location ? ` (${f.location})` : ""}: ${f.message}`
  );
  return `loom verify: ${report.findings.length} finding(s) — ${errors} error(s), ${warnings} warning(s)\n${lines.join("\n")}`;
}
