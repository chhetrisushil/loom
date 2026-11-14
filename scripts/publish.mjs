#!/usr/bin/env node
// Publishes every public workspace package to npm under the `next` dist-tag. Afterwards, once the release
// is verified, `node scripts/promote-latest.mjs --yes` moves `latest` to it (ADR 0148 amendment).
//
//   node scripts/publish.mjs          # DRY RUN: packs each package and reports what would ship
//   node scripts/publish.mjs --yes    # really publish (needs `npm login` with publish rights on @loomwork)
//   node scripts/publish.mjs --yes --otp=123456   # with a 2FA code; without one, npm asks in the browser
//
// A 2FA code expires in about 30 s: if it lapses mid-run, run again with a fresh one. Versions already on the
// registry are skipped, so a re-run resumes where the last one stopped.
//
// Preconditions (refused otherwise): a clean git tree, publish metadata current
// (`node scripts/publish-metadata.mjs --check`), and every public package built (`dist/` present).
// The root LICENSE and NOTICE are copied into each package for the duration of the pack and removed
// afterwards (they are git-ignored there, so an interrupted run leaves no tracked change).
// `pnpm -r publish` publishes in dependency order, skips private packages and versions already on the
// registry, and rewrites `workspace:^` to `^<version>`.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DIST_TAG, plan } from "./publish-metadata.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const really = process.argv.includes("--yes");
const otp = process.argv.find((a) => a.startsWith("--otp="))?.slice("--otp=".length);
if (otp !== undefined && !/^\d{6,8}$/.test(otp)) {
  console.error("publish: --otp takes the 6-8 digit code from your authenticator");
  process.exit(1);
}

function fail(msg) {
  console.error(`publish: ${msg}`);
  process.exit(1);
}

const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (dirty.trim()) fail("the git tree is not clean");

const { entries, errors } = plan(root);
if (errors.length) fail(errors.join("\n"));
const stale = entries.filter((e) => e.state === "stale");
if (stale.length) fail(`stale publish metadata: ${stale.map((e) => e.rel).join(", ")}`);
const unbuilt = entries.filter((e) => !existsSync(join(root, e.rel, "dist")));
if (unbuilt.length) fail(`not built (run pnpm build): ${unbuilt.map((e) => e.rel).join(", ")}`);

const copied = [];
try {
  for (const e of entries) {
    for (const f of ["LICENSE", "NOTICE"]) {
      const to = join(root, e.rel, f);
      copyFileSync(join(root, f), to);
      copied.push(to);
    }
  }
  const args = ["-r", "publish", "--tag", DIST_TAG, "--access", "public", "--no-git-checks"];
  if (!really) args.push("--dry-run");
  if (otp) args.push(`--otp=${otp}`);
  console.log(`${really ? "PUBLISHING" : "dry run:"} ${entries.length} packages (tag ${DIST_TAG})`);
  execFileSync("pnpm", args, { cwd: root, stdio: "inherit" });
} finally {
  for (const f of copied) rmSync(f, { force: true });
}
if (!really) console.log("dry run only; re-run with --yes to publish");
