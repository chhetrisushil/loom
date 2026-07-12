import * as fs from "node:fs";
import * as path from "node:path";
import { listSeams, pluginFiles } from "@loom/scaffold";
import { KERNEL_PACKAGES, SPI_PACKAGES } from "@loom/spec";

/**
 * `loom plugin new <seam> <name> [--first-party] [--dir .]` — scaffold a plugin
 * package for a seam. Writes a package.json, tsconfig, a preset/SPI stub, a
 * conformance-wired test, and a README. Never overwrites an existing file.
 */
export function cmdPluginNew(
  seam: string,
  name: string,
  opts: { firstParty: boolean; dir: string }
): { dir: string; written: string[]; skipped: string[] } {
  const files = pluginFiles(seam, name, { firstParty: opts.firstParty });
  const written: string[] = [];
  const skipped: string[] = [];
  let root = "";
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(opts.dir, rel);
    if (root === "")
      root = path.join(
        opts.dir,
        rel
          .split("/")
          .slice(0, opts.firstParty ? 2 : 1)
          .join("/")
      );
    if (fs.existsSync(dest)) {
      skipped.push(dest);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
    written.push(dest);
  }
  return { dir: root, written, skipped };
}

/** `loom plugin seams` — list the seams a plugin can target. */
export function cmdPluginSeams(): string {
  return listSeams();
}

export interface PluginFinding {
  level: "ok" | "warn" | "error";
  message: string;
}

interface PluginManifest {
  name?: string;
  keywords?: string[];
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** The replay fold engine — a plugin depending on it can extend the fold (forbidden). */
const FOLD_ENGINE = "@loom/replay-vm";
/** @loom/* SPI + kernel packages a third-party plugin should peer-depend on, not bundle. */
const SPI_KERNEL = new Set<string>([...KERNEL_PACKAGES, ...SPI_PACKAGES]);

/**
 * Static contract check for a plugin (ADR 0043 / docs/plugins.md). Pure over the
 * manifest + the text of its test files, so it is unit-testable without disk.
 */
export function checkPlugin(pkg: PluginManifest, testSources: string[]): PluginFinding[] {
  const findings: PluginFinding[] = [];
  const name = pkg.name ?? "";
  const firstParty = name.startsWith("@loom/plugin-");
  const thirdParty = /^loom-plugin-/.test(name) || /^@[^/]+\/loom-plugin-/.test(name);

  // Naming convention.
  if (firstParty || thirdParty) {
    findings.push({
      level: "ok",
      message: `name "${name}" follows the ${firstParty ? "first" : "third"}-party convention`,
    });
  } else {
    findings.push({
      level: "warn",
      message: `name "${name}" is neither @loom/plugin-* (1P) nor loom-plugin-* (3P)`,
    });
  }

  // Fold isolation — the load-bearing contract rule: no reducer into the replay fold.
  const runtimeDeps = { ...pkg.dependencies, ...pkg.peerDependencies };
  if (FOLD_ENGINE in runtimeDeps) {
    findings.push({
      level: "error",
      message: `depends on ${FOLD_ENGINE} — plugins must not extend the replay fold; emit app events and fold them in a projection instead (ADR 0043)`,
    });
  } else {
    findings.push({ level: "ok", message: "does not depend on the replay fold engine" });
  }

  // Third-party specifics: discovery keyword + SPI packages as peers (one kernel copy).
  if (thirdParty) {
    if ((pkg.keywords ?? []).includes("loom-plugin")) {
      findings.push({ level: "ok", message: 'has the "loom-plugin" keyword' });
    } else {
      findings.push({
        level: "warn",
        message: 'missing the "loom-plugin" npm keyword (discovery)',
      });
    }
    const spiInDeps = Object.keys(pkg.dependencies ?? {}).filter((d) => SPI_KERNEL.has(d));
    if (spiInDeps.length > 0) {
      findings.push({
        level: "warn",
        message: `SPI package(s) in dependencies (${spiInDeps.join(", ")}) — a 3P plugin should peer-depend on @loom/* SPI so the app supplies one kernel copy`,
      });
    } else {
      findings.push({
        level: "ok",
        message: "SPI packages are peer dependencies (no duplicate kernel)",
      });
    }
  }

  // Conformance wiring — is any SPI impl proven with the published kit?
  if (testSources.some((s) => s.includes("@loom/testing/conformance"))) {
    findings.push({ level: "ok", message: "a test wires @loom/testing/conformance" });
  } else {
    findings.push({
      level: "warn",
      message:
        "no test imports @loom/testing/conformance — prove your SPI impl with the conformance kit (if one exists for your seam)",
    });
  }

  return findings;
}

function readTestSources(dir: string): string[] {
  const srcDir = path.join(dir, "src");
  if (!fs.existsSync(srcDir)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".test.ts")) out.push(fs.readFileSync(p, "utf8"));
    }
  };
  walk(srcDir);
  return out;
}

/**
 * `loom plugin check [--dir .]` — validate a plugin package against the contract.
 * Reads its package.json + test files. Non-zero exit if any `error` finding.
 */
export function cmdPluginCheck(dir: string): { findings: PluginFinding[]; ok: boolean } {
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    return {
      findings: [
        { level: "error", message: `no package.json at ${pkgPath} — not a plugin package` },
      ],
      ok: false,
    };
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as PluginManifest;
  const findings = checkPlugin(pkg, readTestSources(dir));
  return { findings, ok: !findings.some((f) => f.level === "error") };
}
