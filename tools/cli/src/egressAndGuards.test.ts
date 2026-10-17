import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@loom/core";
import { SqliteEventStore } from "@loom/plugin-sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./cli";
import { commandHelp, completionScript, wantsHelp } from "./help";

// ── --redact reaches EVERY echo of a value, in every output mode ──────────────

const SECRET = "sk_live_TOPSECRET_9f8e7d";

describe("--redact is complete (logs/debug, text and --json)", () => {
  let dir: string;
  let db: string;
  let stdout: string[];
  let stderr: string[];

  const ev = (executionId: string, sequence: number, eventType: string, payload: unknown) =>
    ({
      id: `${executionId}-${sequence}`,
      executionId,
      workflowId: "wf",
      eventType,
      sequence,
      timestamp: 1_700_000_000_000 + sequence,
      payload,
    }) as EventEnvelope;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "loom-redact-"));
    db = join(dir, "events.db");
    const store = new SqliteEventStore(db);
    const s = { token: SECRET, who: "me" };
    await store.append(ev("ok", 0, "EXECUTION_STARTED", { input: s, principal: s }));
    await store.append(ev("ok", 1, "STEP_STARTED", { stepId: "a", input: s }));
    await store.append(ev("ok", 2, "STEP_COMPLETED", { stepId: "a", output: [s, { x: [s] }] }));
    await store.append(ev("ok", 3, "EXECUTION_SUSPENDED", { on: "gate" }));
    await store.append(ev("ok", 4, "EXECUTION_RESUMED", { payload: s, resume: { data: s } }));
    await store.append(ev("ok", 5, "EXECUTION_COMPLETED", { output: [s], result: s }));
    await store.append(ev("bad", 0, "EXECUTION_STARTED", { input: s }));
    await store.append(
      ev("bad", 1, "EXECUTION_FAILED", { error: `denied for ${SECRET}`, detail: { error: s } })
    );
    await store.close();
    stdout = [];
    stderr = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      stdout.push(a.join(" "));
    });
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      stderr.push(a.join(" "));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const cases: [string, string[]][] = [
    ["logs --json", ["logs", "--json"]],
    ["logs", ["logs"]],
    ["debug --json", ["debug", "--json"]],
    ["debug", ["debug"]],
  ];

  for (const [label, base] of cases) {
    for (const id of ["ok", "bad"]) {
      it(`${label} ${id}: the secret value appears nowhere in stdout`, async () => {
        const code = await run([
          base[0] as string,
          "--db",
          db,
          ...base.slice(1),
          "--redact",
          "token",
          id,
        ]);
        expect(code).toBe(0);
        const text = stdout.join("\n");
        expect(text.length).toBeGreaterThan(20);
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain("TOPSECRET");
      });
    }
  }

  it("without --redact the same data IS printed (the assertions above are not vacuous)", async () => {
    expect(await run(["logs", "--db", db, "--json", "ok"])).toBe(0);
    expect(stdout.join("\n")).toContain(SECRET);
  });

  it("--json keeps non-secret siblings", async () => {
    expect(await run(["logs", "--db", db, "--json", "--redact", "token", "ok"])).toBe(0);
    const lines = stdout.join("").trimEnd().split("\n");
    const started = JSON.parse(lines[0] as string) as EventEnvelope;
    expect(started.payload).toMatchObject({ input: { token: "[redacted]", who: "me" } });
  });
});

// ── stdout carries ONLY the JSON, whatever the config wrote ───────────────────

describe("--json stdout purity through the real entry point", () => {
  const cli = join(__dirname, "..", "dist", "cli.js");

  it.skipIf(!existsSync(cli))(
    "console.debug/table/dir and process.stdout.write in a config never reach stdout",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "loom-pure-"));
      try {
        const root = join(__dirname, "..", "..", "..");
        const dist = (p: string) => JSON.stringify(join(root, p));
        writeFileSync(
          join(dir, "cfg.cjs"),
          `console.debug("DBG"); console.table([{a:1}]); console.dir({b:2});
         process.stdout.write("RAW\\n"); console.log("LOG"); console.info("INFO");
         const { defineConfig } = require(${dist("packages/app/dist/index.js")});
         const { SqliteEventStore, SqliteSnapshotStore } = require(${dist("plugins/sqlite/dist/index.js")});
         module.exports = defineConfig({ storage: { kind: "custom",
           eventStore: new SqliteEventStore("./e.db"), snapshotStore: new SqliteSnapshotStore("./s.db") } });`
        );
        const r = spawnSync(
          process.execPath,
          [cli, "census", "--config", join(dir, "cfg.cjs"), "--json"],
          {
            encoding: "utf8",
            cwd: dir,
          }
        );
        expect(r.error).toBeUndefined();
        expect(() => JSON.parse(r.stdout), r.stdout).not.toThrow();
        expect(r.stdout).not.toContain("RAW");
        expect(r.stderr).toContain("RAW");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});

// ── Object.prototype names are not commands ───────────────────────────────────

describe("prototype-chain names", () => {
  let err: string[];
  beforeEach(() => {
    err = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      err.push(a.join(" "));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    it(`loom ${name} is an unknown command, exit 2`, async () => {
      expect(await run([name])).toBe(2);
      expect(await run([name, "--json"])).toBe(2);
      expect(await run([name, "--help"])).toBe(2);
      expect(err.join("\n")).toContain(`unknown command "${name}"`);
      expect(() => commandHelp(name)).toThrow(/unknown command/);
    });
  }
  it("loom help <proto name> is exit 2 too", async () => {
    expect(await run(["help", "toString"])).toBe(2);
  });
});

// ── help scoping ─────────────────────────────────────────────────────────────

describe("help scoping", () => {
  let out: string[];
  beforeEach(() => {
    out = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("`loom help --help` prints help's own help, exit 0", async () => {
    expect(await run(["help", "--help"])).toBe(0);
    expect(out.join("\n")).toBe(commandHelp("help"));
    expect(out.join("\n")).toContain("loom help [command]");
  });

  it("`loom branches retire --help` prints only that subcommand", async () => {
    expect(await run(["branches", "retire", "--help"])).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("loom branches retire <store>");
    expect(text).not.toContain("loom branches prune");
    expect(text).toContain("--parent");
    expect(text).not.toContain("--protect");
    // an unknown word falls back to the whole section
    expect(commandHelp("branches", "nope")).toContain("loom branches prune");
  });

  it("a literal -h in free text is not a help request; flag position still is", () => {
    expect(wantsHelp(["make", "a", "cli", "with", "-h", "flag"], "appgen")).toBe(false);
    expect(wantsHelp(["--help"], "appgen")).toBe(true);
    expect(wantsHelp(["--dir", "x", "-h"], "appgen")).toBe(true);
    expect(wantsHelp(["--db", "x", "--help"], "logs")).toBe(true);
    expect(wantsHelp(["--db", "x", "id", "--help"], "logs")).toBe(true);
    expect(wantsHelp(["search", "-h"], "knowledge")).toBe(true);
    expect(wantsHelp(["search", "q", "-h"], "knowledge")).toBe(false);
    expect(wantsHelp(["a", "--", "-h"], "logs")).toBe(false);
  });
});

// ── completion: value flags take a value ─────────────────────────────────────

describe("completion value flags", () => {
  it("fish: value flags carry -r, path flags also force files, subcommands only right after", () => {
    const s = completionScript("fish");
    expect(s).toMatch(/-l db -r -F/);
    expect(s).toMatch(/-l redact -r\n/);
    expect(s).toMatch(/-l json\n/); // a boolean takes no value
    expect(s).toContain("test (count (commandline -opc)) -eq 2' -a retire");
  });
  it("zsh: value flags use the --flag=[desc]:action form", () => {
    const s = completionScript("zsh");
    expect(s).toContain("'--db=[db]:file:_files'");
    expect(s).toContain("'--limit=[limit]:int: '");
    expect(s).toContain("'--json[json]'");
  });
  it("bash: the word after a value flag completes files (path) or nothing", () => {
    const s = completionScript("bash");
    expect(s).toMatch(/--db\|[^)]*\) COMPREPLY=\( \$\(compgen -f/);
    expect(s).toMatch(/--limit\|[^)]*\) COMPREPLY=\(\)/);
  });
  it("the scripts still parse", () => {
    for (const shell of ["bash", "zsh"]) {
      const probe = spawnSync(shell, ["-n", "-c", "true"]);
      expect(probe.error, `${shell} not installed`).toBeUndefined();
      const r = spawnSync(shell, ["-n"], { input: completionScript(shell) });
      expect(r.status, `${shell} -n: ${r.stderr}`).toBe(0);
    }
  });
});
