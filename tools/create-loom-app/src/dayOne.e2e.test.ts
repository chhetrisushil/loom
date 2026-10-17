import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    // (`loom new` runs `gen` itself now; the explicit `pnpm gen` stays idempotent.)
    const created = sh("pnpm", ["exec", "loom", "new", "flow", "order-check"], app);
    expect(created).toMatch(/wrote .*loom\.gen\.ts \(2 flows,/);
    sh("pnpm", ["gen"], app);
    expect(existsSync(join(app, "app/flows/order-check/flow.test.ts"))).toBe(true);
    expect(sh("pnpm", ["test"], app)).toContain("2 passed");
    expect(sh("pnpm", ["start"], app)).toContain("output: 'world'");

    // The non-agentic templates: each scaffolds a flow whose own test (time travel included)
    // passes on a fresh app. `saga` imports a package the scaffold does not declare - the hint
    // `loom new` prints is the line we add, which proves the hint is right.
    const manifestPath = join(app, "package.json");
    let expected = 2;
    for (const [template, tests] of [
      ["approval", 2],
      ["timer", 1],
      ["saga", 2],
    ] as const) {
      const name = `${template}-flow`;
      const printed = sh(
        "pnpm",
        ["exec", "loom", "new", "flow", name, "--template", template],
        app
      );
      expect(existsSync(join(app, `app/flows/${name}/flow.test.ts`))).toBe(true);
      const hint = /"(@loom\/saga)": "([^"]+)"/.exec(printed);
      if (template === "saga") {
        expect(hint, "loom new must say @loom/saga is missing").not.toBeNull();
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          dependencies: Record<string, string>;
        };
        manifest.dependencies["@loom/saga"] = (hint as RegExpExecArray)[2] as string;
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        sh("pnpm", ["install", "--prefer-offline"], app);
        // The scaffold is `security.strict`: the saga's tool steps need grants, as the note says.
        expect(printed).toContain("SagaFlowGrants");
        const sec = join(app, "app/security.ts");
        const text = readFileSync(sec, "utf8");
        const patched = text
          .replace(
            "import { createHash }",
            'import { SagaFlowGrants } from "./flows/saga-flow/flow";\nimport { createHash }'
          )
          .replace('greet: ["greet-step"],', 'greet: ["greet-step"],\n  ...SagaFlowGrants,');
        expect(patched).not.toBe(text);
        writeFileSync(sec, patched);
      } else {
        expect(hint).toBeNull();
      }
      expected += tests;
      expect(sh("pnpm", ["test"], app)).toContain(`${expected} passed`);
    }
    expect(sh("pnpm", ["start"], app)).toContain("output: 'world'");
  }, 600_000);
});
