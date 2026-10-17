import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@loom/core";
import { SqliteEventStore } from "@loom/plugin-sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMANDS } from "./args";
import { USAGE, run } from "./cli";
import { DOCTOR_CHECK_IDS } from "./doctor";
import { cliVersion, commandHelp, completionScript } from "./help";

// ── F10 help / F11 --json / F13 doctor --strict / F19a completion ─────────────

describe("per-command help comes from the command table", () => {
  it("every command in the table has a summary and a usage line", () => {
    for (const [name, spec] of Object.entries(COMMANDS)) {
      expect(spec.summary.length, `loom ${name} has no summary`).toBeGreaterThan(5);
      expect(spec.usage.length, `loom ${name} has no usage`).toBeGreaterThan(0);
      expect(spec.usage[0], `loom ${name} usage must start with its own name`).toMatch(
        new RegExp(`^loom (${name}|<)`)
      );
      expect(commandHelp(name)).toContain(spec.summary);
    }
  });

  it("every declared flag appears in the command's own usage lines", () => {
    // The shared store flags are selected by `--config` (or documented under `<store>`);
    // every other flag must be spelled in a usage line.
    const STORE_FLAGS = new Set(["config", "db", "snap", "branches", "leases", "verbose"]);
    const missing: string[] = [];
    for (const [name, spec] of Object.entries(COMMANDS)) {
      const text = spec.usage.join("\n");
      for (const flag of Object.keys(spec.flags)) {
        const store = STORE_FLAGS.has(flag) && /<store>|--config/.test(text);
        if (!store && !text.includes(`--${flag}`)) missing.push(`loom ${name} --${flag}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every command the table knows appears in the grouped top-level USAGE", () => {
    for (const name of Object.keys(COMMANDS)) {
      expect(USAGE, `USAGE never mentions loom ${name}`).toContain(`loom ${name}`);
    }
  });
});

describe("help, version, unknown command, completion", () => {
  let out: string[];
  let err: string[];
  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      err.push(a.join(" "));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("`loom <cmd> --help`, `-h` and `loom help <cmd>` print the same section, exit 0", async () => {
    for (const argv of [
      ["logs", "--help"],
      ["logs", "-h"],
      ["help", "logs"],
    ]) {
      out.length = 0;
      expect(await run(argv)).toBe(0);
      expect(out.join("\n")).toBe(commandHelp("logs"));
    }
    expect(commandHelp("logs")).toContain("--redact <string>");
    // a refusing command's help does not run it
    expect(await run(["retention", "run", "--help"])).toBe(0);
    expect(err).toEqual([]);
  });

  it("`loom --version` and `loom version` print the package version", async () => {
    expect(await run(["--version"])).toBe(0);
    expect(await run(["version"])).toBe(0);
    expect(out).toEqual([cliVersion(), cliVersion()]);
    expect(cliVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("an unknown command is ONE line with a did-you-mean, exit 2, no usage dump", async () => {
    expect(await run(["logz"])).toBe(2);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain('unknown command "logz" (did you mean "logs"?)');
    expect(err[0]).toContain("loom help");
    expect(out).toEqual([]);
    expect(await run(["help", "nope"])).toBe(2);
  });

  it("completion: every shell lists every command and flags; bash parses", async () => {
    for (const shell of ["zsh", "bash", "fish"]) {
      const script = completionScript(shell);
      for (const name of Object.keys(COMMANDS)) expect(script, `${shell}: ${name}`).toContain(name);
      for (const flag of ["--redact", "--strict", "--require", "--ttl", "--json"]) {
        if (shell === "fish") expect(script).toContain(`-l ${flag.slice(2)}`);
        else expect(script, `${shell}: ${flag}`).toContain(flag);
      }
      expect(script).toContain("retire"); // a subcommand
      out.length = 0;
      expect(await run(["completion", shell])).toBe(0);
      expect(out.join("\n")).toBe(script.trimEnd());
    }
    for (const shell of ["bash", "zsh"]) {
      const probe = spawnSync(shell, ["-n", "-c", "true"]);
      if (probe.error !== undefined) continue; // shell not installed
      const r = spawnSync(shell, ["-n"], { input: completionScript(shell) });
      expect(r.status, `${shell} -n: ${r.stderr}`).toBe(0);
    }
    expect(await run(["completion", "powershell"])).toBe(2);
    expect(await run(["completion"])).toBe(2);
  });
});

describe("--json", () => {
  let dir: string;
  let db: string;
  let stdout: string[];
  let err: string[];

  const ev = (sequence: number, eventType: string, payload: unknown): EventEnvelope =>
    ({
      id: `e-${sequence}`,
      executionId: "ex1",
      workflowId: "wf",
      eventType,
      sequence,
      timestamp: 1_700_000_000_000 + sequence,
      payload,
    }) as EventEnvelope;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "loom-json-"));
    db = join(dir, "events.db");
    const events = new SqliteEventStore(db);
    await events.append(ev(0, "EXECUTION_STARTED", { input: {}, workflowId: "wf" }));
    await events.append(ev(1, "EXECUTION_COMPLETED", { output: { secret: "s3", keep: "k" } }));
    await events.close();
    stdout = [];
    err = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      err.push(a.join(" "));
    });
    // A banner printed by an imported config must not reach stdout under --json.
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const doc = () => JSON.parse(stdout.join("")) as Record<string, unknown>;

  it("logs is ndjson, one event per line, and --redact still masks", async () => {
    expect(await run(["logs", "--db", db, "--json", "--redact", "secret", "ex1"])).toBe(0);
    const lines = stdout.join("").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    const events = lines.map((l) => JSON.parse(l) as EventEnvelope);
    expect(events.map((e) => e.sequence)).toEqual([0, 1]);
    const last = JSON.stringify(events[1]);
    expect(last).toContain('"keep":"k"');
    expect(last).not.toContain("s3");
  });

  it("debug / census / profile / introspect emit parseable JSON", async () => {
    expect(await run(["debug", "--db", db, "--json", "ex1"])).toBe(0);
    expect(doc()).toMatchObject({ ok: true, executionId: "ex1", eventCount: 2 });
    expect(doc().state).toBeTruthy();

    stdout.length = 0;
    expect(await run(["census", "--db", db, "--json"])).toBe(0);
    expect(doc()).toMatchObject({ ok: true, census: { scanned: 1 } });

    stdout.length = 0;
    expect(await run(["profile", "--db", db, "--json", "ex1"])).toBe(0);
    expect(doc().ok).toBe(true);
    expect(doc().profile).toBeTruthy();

    stdout.length = 0;
    expect(await run(["introspect", "--db", db, "--json", "--graph", "tasks", "ex1"])).toBe(0);
    expect(Object.keys(doc().introspection as object)).toEqual(["tasks"]);
  });

  it("check / lint / eval / compat: ok mirrors the exit code", async () => {
    const good = join(dir, "good.json");
    const bad = join(dir, "bad.json");
    writeFileSync(good, JSON.stringify({ flows: { f: {} } }));
    writeFileSync(bad, JSON.stringify({ flows: { f: { warnings: ["boom"] } } }));
    expect(await run(["check", "--manifest", good, "--json"])).toBe(0);
    expect(doc()).toEqual({ ok: true, issues: [] });
    stdout.length = 0;
    expect(await run(["check", "--manifest", bad, "--json"])).toBe(1);
    expect(doc()).toMatchObject({ ok: false, issues: [expect.stringContaining("boom")] });

    stdout.length = 0;
    const src = join(dir, "src");
    mkdirSync(src);
    expect(await run(["lint", "claim-check", "--dir", src, "--json"])).toBe(0);
    expect(doc()).toEqual({ ok: true, findings: [] });

    stdout.length = 0;
    const goldens = join(dir, "goldens");
    mkdirSync(goldens);
    expect(await run(["eval", "--dir", goldens, "--json"])).toBe(0);
    expect(doc()).toMatchObject({ ok: true, passed: 0, failed: 0 });

    stdout.length = 0;
    expect(await run(["compat", "--abi", "999.0.0", "--json"])).toBe(1);
    expect(doc()).toMatchObject({ ok: false });
    expect((doc().issues as unknown[]).length).toBeGreaterThan(0);
  });

  it("verify --json carries the report; doctor --json lists checks with ids", async () => {
    const cfg = join(dir, "cfg.js");
    writeFileSync(
      cfg,
      `console.log("[loom] banner on stdout");
       module.exports = { default: {
         verify: () => ({ ok: true, findings: [], checked: ["capability-compat"] }),
         close: async () => {},
       } };`
    );
    expect(await run(["verify", "--config", cfg, "--json"])).toBe(0);
    expect(doc()).toMatchObject({ ok: true, checked: ["capability-compat"] });
    expect(stdout.join("")).not.toContain("[loom] banner");

    stdout.length = 0;
    const empty = join(dir, "empty");
    mkdirSync(empty);
    expect(await run(["doctor", "--dir", empty, "--json"])).toBe(0);
    const checks = doc().checks as { id: string; status: string }[];
    expect(doc().ok).toBe(true);
    expect(checks.map((c) => c.id)).toEqual(
      expect.arrayContaining(["flow-graph", "verify", "claim-check"])
    );
    for (const c of checks) expect(DOCTOR_CHECK_IDS).toContain(c.id);
  });

  it("errors under --json are one JSON object on stderr; stdout stays empty", async () => {
    expect(await run(["logs", "--db", db, "--json", "nope"])).toBe(1);
    expect(stdout).toEqual([]);
    expect(JSON.parse(err.join("\n"))).toEqual({
      error: { code: 1, message: expect.stringContaining("no such execution") },
    });
    err.length = 0;
    expect(await run(["logs", "--json"])).toBe(2);
    expect(JSON.parse(err.join("\n")).error.code).toBe(2);
  });

  it("a command without --json REJECTS it (exit 2), it does not ignore it", async () => {
    for (const argv of [
      ["optimize", "--db", db, "--json", "ex1"],
      ["recover", "--db", db, "--json"],
      ["gen", "--json"],
      ["retention", "run", "--db", db, "--ttl", "1d", "--json"],
    ]) {
      err.length = 0;
      expect(await run(argv), argv.join(" ")).toBe(2);
      expect(err.join("\n")).toContain("unknown flag --json");
    }
    expect(stdout).toEqual([]);
  });
});

describe("loom doctor --strict / --require (F13)", () => {
  let dir: string;
  let out: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-strict-"));
    out = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("an empty project passes by default, but --strict fails on every skip", async () => {
    expect(await run(["doctor", "--dir", dir])).toBe(0);
    expect(out.join("\n")).toContain("could not run");
    out.length = 0;
    expect(await run(["doctor", "--dir", dir, "--strict"])).toBe(1);
    expect(out.join("\n")).toContain("could not run (--strict)");
  });

  it("--require fails only when a NAMED check did not run", async () => {
    expect(await run(["doctor", "--dir", dir, "--require", "verify,timers"])).toBe(1);
    expect(out.join("\n")).toContain("(--require)");
    out.length = 0;
    // claim-check always runs over the source tree, so requiring only it is satisfied
    expect(await run(["doctor", "--dir", dir, "--require", "claim-check"])).toBe(0);
  });

  it("--require with an unknown check id is a usage error naming the valid ids", async () => {
    const errs: string[] = [];
    vi.mocked(console.error).mockImplementation((...a: unknown[]) => {
      errs.push(a.join(" "));
    });
    expect(await run(["doctor", "--dir", dir, "--require", "bogus"])).toBe(2);
    expect(errs.join("\n")).toContain("heartbeat-leases");
  });
});

describe("the built binary", () => {
  const cli = join(__dirname, "..", "dist", "cli.js");
  // Skipped (visibly) only when dist is absent; a present binary that fails to spawn FAILS.
  it.skipIf(!existsSync(cli))(
    "--version and per-command help run through the real entry point",
    () => {
      const v = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
      expect(v.error).toBeUndefined();
      expect(v.status).toBe(0);
      expect(v.stdout.trim()).toBe(cliVersion());
      const h = spawnSync(process.execPath, [cli, "doctor", "--help"], { encoding: "utf8" });
      expect(h.status).toBe(0);
      expect(h.stdout).toContain("--strict");
      const j = spawnSync(
        process.execPath,
        [cli, "check", "--manifest", "/nonexistent", "--json"],
        {
          encoding: "utf8",
        }
      );
      expect(j.status).toBe(1);
      expect(j.stdout).toBe("");
      expect(JSON.parse(j.stderr).error.code).toBe(1);
    }
  );
});
