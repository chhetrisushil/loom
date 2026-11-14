#!/usr/bin/env node
// Points npm's `latest` dist-tag at the released version of every PUBLIC package in the pnpm
// workspace it is run from (loom, or a sibling such as loom-ui: `node ../loom/scripts/promote-latest.mjs`).
//
// Why this step exists (ADR 0148, amended): `publish.mjs` publishes under `next`, but npm also set
// `latest` on each package's FIRST publish, and every sibling dependency is a `^0.1.x` range. npm and
// pnpm resolve a range to the `latest` version whenever it satisfies it, so until `latest` moves a
// consumer of the new release still installs the previous one transitively.
//
//   node scripts/promote-latest.mjs          # DRY RUN: lists the packages whose `latest` would move
//   node scripts/promote-latest.mjs --yes    # moves them; npm asks for 2FA once PER package
//   NPM_TOKEN=<token> node scripts/promote-latest.mjs --yes
//                                            # with a granular token allowed to bypass 2FA: no prompts
//
// Run it from a real terminal (npm's browser 2FA needs one). A package whose `latest` is already the
// workspace version is skipped, so a re-run resumes where the last one stopped.
import { execFileSync } from "node:child_process";

const really = process.argv.includes("--yes");
const token = process.env.NPM_TOKEN;
const auth = token ? [`--//registry.npmjs.org/:_authToken=${token}`] : [];

const listed = JSON.parse(
  execFileSync("pnpm", ["ls", "-r", "--depth", "-1", "--json"], { encoding: "utf8" })
);
const pkgs = listed.filter((p) => !p.private && p.name && p.version);
if (pkgs.length === 0) {
  console.error("promote-latest: no public packages found (run it from a pnpm workspace root)");
  process.exit(1);
}

function view(spec, field) {
  try {
    return execFileSync("npm", ["view", spec, field, "--prefer-online", ...auth], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

let failed = 0;
for (const { name, version } of pkgs) {
  const latest = view(name, "dist-tags.latest");
  if (latest === version) {
    console.log(`skip ${name} (latest is ${version})`);
    continue;
  }
  if (view(`${name}@${version}`, "version") !== version) {
    console.error(`FAILED ${name}: ${version} is not on the registry (publish it first)`);
    failed++;
    continue;
  }
  console.log(
    `${really ? "move" : "would move"} ${name}: latest ${latest || "(none)"} -> ${version}`
  );
  if (!really) continue;
  try {
    // stdin is the terminal: npm's browser 2FA prompt reads it.
    execFileSync("npm", ["dist-tag", "add", `${name}@${version}`, "latest", ...auth], {
      stdio: "inherit",
    });
  } catch {
    console.error(`FAILED ${name}`);
    failed++;
  }
}
if (!really) console.log("dry run only; re-run with --yes to move the tags");
process.exit(failed ? 1 : 0);
