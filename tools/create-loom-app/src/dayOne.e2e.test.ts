import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ── The day-one path, for real ───────────────────────────────────────────────
//
// The check that never existed: scaffold an app OUTSIDE the loom workspace with `--loom-path`, then
// `pnpm install`, `pnpm test`, `pnpm start` and `loom new flow` + its generated test — the exact
// commands the docs tell a newcomer to run. Every unit test of the scaffolder was green while
// `pnpm install` failed for everybody outside the monorepo.
//
// Not in the default suite: it runs a real `pnpm install` (network / store dependent, tens of
// seconds) against a BUILT checkout. Run it with `pnpm test:e2e` (LOOM_TEST_E2E=1) after `pnpm build`.
// When the flag is off the suite is reported as skipped, never as passed.

const ENABLED = process.env.LOOM_TEST_E2E === "1";
const LOOM_ROOT = resolve(__dirname, "../../..");
const BIN = resolve(__dirname, "..", "dist", "index.js");

describe.skipIf(!ENABLED)("create-loom-app day one (real install)", () => {
  let base = "";
  let work = "";
  let app = "";
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "cla-e2e-"));
    work = join(base, "work");
    app = join(work, "my-app");
    mkdirSync(work);
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const sh = (cmd: string, args: string[], cwd: string): string =>
    execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  it("scaffolds with --loom-path, installs, tests, starts, and `loom new flow` passes its test", () => {
    expect(existsSync(join(LOOM_ROOT, "packages/core/dist")), "run `pnpm build` first").toBe(true);

    const out = sh(process.execPath, [BIN, "my-app", "--loom-path", LOOM_ROOT], work);
    expect(out).toContain("Next: cd my-app && pnpm install && pnpm test && pnpm start");

    sh("pnpm", ["install", "--prefer-offline"], app);
    expect(sh("pnpm", ["test"], app)).toContain("1 passed");
    expect(sh("pnpm", ["start"], app)).toContain("output: 'world'");

    // The generated test for a new flow must pass on a fresh scaffold, too.
    sh("pnpm", ["exec", "loom", "new", "flow", "order-check"], app);
    sh("pnpm", ["gen"], app);
    expect(existsSync(join(app, "app/flows/order-check/flow.test.ts"))).toBe(true);
    expect(sh("pnpm", ["test"], app)).toContain("2 passed");
    expect(sh("pnpm", ["start"], app)).toContain("output: 'world'");
  }, 300_000);
});
