#!/usr/bin/env node
// Writes the npm publish metadata into every PUBLIC workspace package's package.json (packages/*,
// plugins/*, tools/*; a package with `"private": true` is never published and is left alone).
// One source of truth for: the shared release `version`, `license`, `repository` (with the
// package's `directory`), the `files` allowlist (built output + sources for the sourcemaps, never
// tests, fixtures, tsconfig or build caches), `publishConfig` (public access, the `next` dist-tag; promote-latest.mjs moves `latest` after a release),
// `engines`, and `workspace:^` for every sibling dependency (pnpm publish rewrites it to `^<version>`,
// so consumers dedupe one copy instead of pinning an exact one).
//
//   node scripts/publish-metadata.mjs          # apply
//   node scripts/publish-metadata.mjs --check  # exit 1 if any package.json drifted
//
// The spec guard `packages/spec/src/publishMetadata.test.ts` runs the same check in-process, and
// also refuses a public package that depends on a private one (it could never install).
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { workspacePackages } from "./package-readmes.mjs";

/** The release version every public package carries. Bump here, re-run, commit. */
export const RELEASE_VERSION = "0.1.2";
export const DIST_TAG = "next";
export const REPOSITORY_URL = "git+https://github.com/chhetrisushil/loom.git";

/** Never published from `src/`: tests and their data. */
const SRC_EXCLUDES = [
  "!src/**/*.test.ts",
  "!src/**/*.test.tsx",
  "!src/**/__tests__",
  "!src/**/__fixtures__",
  "!src/**/__snapshots__",
  "!src/**/__golden__",
];

/** A file at a package's root that ships: subpath stubs (`memory.js` + `.d.ts`) and ops docs. */
function isShippedRootFile(name) {
  if (name === "README.md" || name === "package.json" || name === "vitest.config.ts") return false;
  if (name.startsWith("tsconfig")) return false;
  return /\.(js|cjs|mjs|d\.ts|md)$/.test(name) || name === "Dockerfile";
}

/** The `files` allowlist for the package at `dir`. */
export function filesFor(dir) {
  const roots = readdirSync(dir)
    .filter((n) => isShippedRootFile(n))
    .sort();
  return ["dist", "src", ...roots, ...SRC_EXCLUDES, "LICENSE", "NOTICE"];
}

function withWorkspaceCaret(deps) {
  if (!deps) return deps;
  const out = {};
  for (const [k, v] of Object.entries(deps)) out[k] = v === "workspace:*" ? "workspace:^" : v;
  return out;
}

/** The package.json the generator would write for one public package (key order preserved). */
export function expectedPackageJson({ dir, rel, pkg }) {
  const next = { ...pkg };
  next.version = RELEASE_VERSION;
  next.license = "Apache-2.0";
  next.repository = { type: "git", url: REPOSITORY_URL, directory: rel };
  next.files = filesFor(dir);
  next.publishConfig = { access: "public", tag: DIST_TAG };
  next.engines = { node: ">=20.0.0" };
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    if (next[field]) next[field] = withWorkspaceCaret(next[field]);
  }
  return next;
}

/**
 * @returns {{ rel: string, file: string, state: "ok" | "stale", next: object }[]} one entry per
 * public package, plus `errors` for a public package that depends on a private sibling.
 */
export function plan(root) {
  const pkgs = workspacePackages(root);
  const privateNames = new Set(pkgs.filter((p) => p.pkg.private).map((p) => p.pkg.name));
  const entries = [];
  const errors = [];
  for (const p of pkgs) {
    if (p.pkg.private) continue;
    const file = join(p.dir, "package.json");
    const next = expectedPackageJson(p);
    const state = JSON.stringify(next) === JSON.stringify(p.pkg) ? "ok" : "stale";
    entries.push({ rel: p.rel, file, state, next });
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const dep of Object.keys(p.pkg[field] ?? {})) {
        if (privateNames.has(dep))
          errors.push(`${p.rel}: public package depends on private ${dep}`);
      }
    }
  }
  return { entries, errors };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const check = process.argv.includes("--check");
  const { entries, errors } = plan(root);
  for (const e of errors) console.error(e);
  const stale = entries.filter((e) => e.state === "stale");
  if (check) {
    for (const e of stale) console.error(`${e.rel}: publish metadata is stale`);
    if (stale.length) console.error("run: node scripts/publish-metadata.mjs");
    process.exit(stale.length || errors.length ? 1 : 0);
  }
  for (const e of stale) {
    if (!existsSync(e.file)) continue;
    writeFileSync(e.file, `${JSON.stringify(e.next, null, 2)}\n`);
    console.log(`updated ${e.rel}`);
  }
  console.log(`${entries.length} public packages, ${stale.length} updated`);
  process.exit(errors.length ? 1 : 0);
}
