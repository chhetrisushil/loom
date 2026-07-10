import * as fs from "node:fs";
import * as path from "node:path";
import {
  type DeploymentVersions,
  checkCompatibility,
  kernelManifest,
  renderCompatibilityMatrix,
  renderManifestText,
  renderMaturityTable,
} from "@loom/spec";

/**
 * `loom kernel-manifest [--json] [--emit-docs <dir>]` — the machine-readable kernel manifest
 * (version constants + capability maturity). `--json` prints the aggregate; `--emit-docs`
 * regenerates the compatibility-matrix + maturity docs from it (single source of truth).
 */
export function cmdKernelManifest(opts: { json?: boolean; emitDocs?: string }): string {
  if (opts.emitDocs !== undefined) {
    const dir = opts.emitDocs;
    fs.mkdirSync(dir, { recursive: true });
    const matrix = path.join(dir, "compatibility-matrix.md");
    const maturity = path.join(dir, "maturity.md");
    fs.writeFileSync(matrix, renderCompatibilityMatrix());
    fs.writeFileSync(maturity, renderMaturityTable());
    return `wrote ${matrix} and ${maturity}`;
  }
  if (opts.json) return JSON.stringify(kernelManifest(), null, 2);
  return renderManifestText();
}

/**
 * `loom compat --abi <v> --event-schema <v> [...]` — validate a deployment's declared contract
 * versions against this kernel's manifest. Exits non-zero on a major-version mismatch (a
 * deployment gate). Omitted contracts are not checked.
 */
export function cmdCompat(flags: Record<string, string>): { text: string; ok: boolean } {
  const actual: DeploymentVersions = {
    ...(flags.abi !== undefined && { kernelAbi: flags.abi }),
    ...(flags["event-schema"] !== undefined && { eventSchema: flags["event-schema"] }),
    ...(flags.wire !== undefined && { wireAbi: flags.wire }),
    ...(flags["event-store-spi"] !== undefined && { eventStoreSpi: flags["event-store-spi"] }),
    ...(flags["snapshot-store-spi"] !== undefined && {
      snapshotStoreSpi: flags["snapshot-store-spi"],
    }),
    ...(flags["branch-registry-spi"] !== undefined && {
      branchRegistrySpi: flags["branch-registry-spi"],
    }),
    ...(flags["dispatcher-spi"] !== undefined && { dispatcherSpi: flags["dispatcher-spi"] }),
    ...(flags["compiler-manifest"] !== undefined && {
      compilerManifest: flags["compiler-manifest"],
    }),
  };
  const report = checkCompatibility(actual);
  const text = report.ok
    ? "compatible ✓ — all declared versions share the kernel's major line"
    : `incompatible — ${report.issues.length} mismatch(es):\n${report.issues
        .map((i) => `  ✗ ${i.component}: ${i.reason}`)
        .join("\n")}`;
  return { text, ok: report.ok };
}
