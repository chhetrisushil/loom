import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ── The built binary is a different program from the test harness ────────────
//
// Every other test here imports TypeScript through vitest's ESM pipeline, where `import()`
// stays `import()`. The shipped CLI compiles to CommonJS, where tsc downlevels it to
// `require()` — which cannot load an ESM module, or a file:// URL, at all. `--config` passed
// its whole unit suite and then failed on the first line of the real binary.
//
// So this test runs the artifact. It is the only thing here that would have caught it.

const PKG = resolve(__dirname, "..");
const CLI = join(PKG, "dist", "cli.js");
const SCRATCH = join(PKG, ".tmp-built-cli");

function run(args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: SCRATCH });
}

describe("the built CLI loads a config module", () => {
  beforeAll(() => {
    // `test` dependsOn ^build (dependencies), not this package's own build — so dist may not
    // be here yet. Build it rather than skipping: a skipped check reads as a passing one.
    if (!existsSync(CLI)) {
      execFileSync("npx", ["tsc", "--build", join(PKG, "tsconfig.json")], { stdio: "inherit" });
    }
    rmSync(SCRATCH, { recursive: true, force: true });
    mkdirSync(SCRATCH, { recursive: true });

    const dist = (p: string) => JSON.stringify(join(PKG, "..", "..", p));
    writeFileSync(
      join(SCRATCH, "seed.cjs"),
      `const { SqliteEventStore } = require(${dist("plugins/sqlite/dist/index.js")});
       const s = new SqliteEventStore("./events.db");
       const e = (id, age) => ({ id: id + "-0", executionId: id, workflowId: "wf",
         eventType: "EXECUTION_STARTED", sequence: 0, timestamp: Date.now() - age, payload: { input: {} } });
       (async () => { await s.append(e("stuck-1", 7 * 3600000)); s.close(); })();`
    );
    execFileSync(process.execPath, [join(SCRATCH, "seed.cjs")], { cwd: SCRATCH });

    // ESM **with top-level await** — the shape `require()` refuses even on Node 22+, and the
    // one a real app hits the moment it awaits anything at composition time.
    writeFileSync(
      join(SCRATCH, "app.mjs"),
      `import { defineConfig } from ${dist("packages/app/dist/index.js")};
       import { SqliteEventStore, SqliteSnapshotStore } from ${dist("plugins/sqlite/dist/index.js")};
       const eventStore = new SqliteEventStore("./events.db");
       await Promise.resolve();
       export default defineConfig({
         storage: { kind: "custom", eventStore, snapshotStore: new SqliteSnapshotStore("./snap.db") },
       });`
    );

    // ...and the CommonJS shape `loom verify` has always assumed.
    writeFileSync(
      join(SCRATCH, "app.cjs"),
      `const { defineConfig } = require(${dist("packages/app/dist/index.js")});
       const { SqliteEventStore, SqliteSnapshotStore } = require(${dist("plugins/sqlite/dist/index.js")});
       module.exports = defineConfig({
         storage: { kind: "custom", eventStore: new SqliteEventStore("./events.db"),
                    snapshotStore: new SqliteSnapshotStore("./snap.db") },
       });`
    );
  }, 120_000);

  afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

  it("reads an ESM config with top-level await", () => {
    const out = run(["census", "--config", "./app.mjs"]);
    expect(out).toContain("1 execution(s) scanned, 1 in flight");
  });

  it("reads a CommonJS config", () => {
    const out = run(["census", "--config", "./app.cjs"]);
    expect(out).toContain("1 execution(s) scanned, 1 in flight");
  });

  it("still reads the SQLite shorthand", () => {
    const out = run(["census", "--db", "./events.db"]);
    expect(out).toContain("1 execution(s) scanned, 1 in flight");
    expect(out).toContain("not asked");
  });
});
