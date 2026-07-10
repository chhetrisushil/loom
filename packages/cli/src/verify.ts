import * as path from "node:path";
import type { LoomApp } from "@loom/app";
import { type VerificationReport, formatReport } from "@loom/verify";

/**
 * `loom verify --config <module>` — pre-flight verification over a built app.
 *
 * The config module must export a `LoomApp` (the result of `defineConfig({...})`) as its
 * default export (or as `app`). We call `app.verify()` — read-only, off-log — print the
 * report, and exit non-zero on any error-severity finding. Build the config to JS first
 * or run under tsx.
 *
 * Note: if the module's own `defineConfig` sets `verify: "error"`, requiring it throws at
 * boot; `main` catches and prints that. This command is for on-demand verification
 * independent of the config's own mode.
 */
export async function cmdVerify(
  configPath: string
): Promise<{ text: string; result: VerificationReport }> {
  const mod = require(path.resolve(configPath)) as { default?: unknown; app?: unknown } & Record<
    string,
    unknown
  >;
  const app = (mod.default ?? mod.app ?? mod) as Partial<LoomApp>;
  if (typeof app.verify !== "function") {
    throw new Error(
      "config module must default-export a LoomApp from defineConfig(...) (no verify() found)"
    );
  }
  const report = app.verify();
  const text = formatReport(report);
  await app.close?.();
  return { text, result: report };
}
