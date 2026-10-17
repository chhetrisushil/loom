import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

  it("runs when invoked through a SYMLINK, the way a global install does", () => {
    // The defect this pins: the entry guard used to be `argv[1].endsWith("cli.js")`, so a
    // global install — which puts a symlink named `loom` on PATH — ran nothing and exited 0.
    // `pnpm link --global` hid it by writing a shim that execs cli.js by name; `npm i -g`
    // creates a plain symlink and the binary went silent.
    const link = join(SCRATCH, "loom");
    rmSync(link, { force: true });
    symlinkSync(CLI, link);
    const out = execFileSync(process.execPath, [link, "--help"], {
      encoding: "utf8",
      cwd: SCRATCH,
    });
    expect(out).toContain("project-local commands for a Loom app");
  });

  it("still reads the SQLite shorthand", () => {
    const out = run(["census", "--db", "./events.db"]);
    expect(out).toContain("1 execution(s) scanned, 1 in flight");
    expect(out).toContain("not asked");
  });

  it("lists executions from the SQLite shorthand (loom ls)", () => {
    const out = run(["ls", "--db", "./events.db"]);
    expect(out).toContain("stuck-1");
    expect(out).toContain("running");
  });

  it("discovers ./loom.config.js, says which on stderr, and prints no [loom] banner", () => {
    copyFileSync(join(SCRATCH, "app.cjs"), join(SCRATCH, "loom.config.js"));
    try {
      const r = spawnSync(process.execPath, [CLI, "ls"], { encoding: "utf8", cwd: SCRATCH });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("stuck-1");
      expect(r.stderr).toContain("using ./loom.config.js");
      expect(r.stderr).not.toContain("[loom]");
    } finally {
      rmSync(join(SCRATCH, "loom.config.js"), { force: true });
    }
  });

  describe("TypeScript configs", () => {
    const tsConfig = () => {
      const dist = (p: string) => JSON.stringify(join(PKG, "..", "..", p));
      return `import { defineConfig } from ${dist("packages/app/dist/index.js")};
       import { SqliteEventStore, SqliteSnapshotStore } from ${dist("plugins/sqlite/dist/index.js")};
       const events: string = "./events.db";
       export default defineConfig({
         storage: { kind: "custom", eventStore: new SqliteEventStore(events),
                    snapshotStore: new SqliteSnapshotStore("./snap.db") },
       });`;
    };
    // NODE_PATH is how vitest finds the hoisted tsx; a user's shell does not have it.
    const cleanEnv = () => {
      const env = { ...process.env };
      Reflect.deleteProperty(env, "NODE_PATH");
      return env;
    };

    it("refuses a .ts config when tsx does not resolve from its directory (exit 2)", () => {
      writeFileSync(join(SCRATCH, "app.ts"), tsConfig());
      const r = spawnSync(process.execPath, [CLI, "ls", "--config", "./app.ts"], {
        encoding: "utf8",
        cwd: SCRATCH,
        env: cleanEnv(),
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("built? point --config at the compiled .js, or install tsx");
    });

    const pnpmDir = join(PKG, "..", "..", "node_modules", ".pnpm");
    const tsxDir = readdirSync(pnpmDir).find((d) => d.startsWith("tsx@"));
    it.skipIf(tsxDir === undefined)("loads a .ts config through the project's own tsx", () => {
      mkdirSync(join(SCRATCH, "node_modules"), { recursive: true });
      const link = join(SCRATCH, "node_modules", "tsx");
      rmSync(link, { force: true });
      symlinkSync(join(pnpmDir, tsxDir as string, "node_modules", "tsx"), link);
      writeFileSync(join(SCRATCH, "app2.ts"), tsConfig());
      const r = spawnSync(process.execPath, [CLI, "ls", "--config", "./app2.ts"], {
        encoding: "utf8",
        cwd: SCRATCH,
        env: cleanEnv(),
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("stuck-1");
    });
  });
});
