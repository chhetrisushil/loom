import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { SqliteEventStore, SqliteLeaseStore } from "@loom/plugin-sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./cli";
import { cmdLogsFollow } from "./commands";
import { serveInspector } from "./inspector";
import { scanExecutions } from "./ls";
import { loadLoomApp } from "./stores";

// ── W4a: ls, logs --follow / -v / --type / --from / --to, debug --at bound, config loading ──
//
// Waits are on CONDITIONS (vi.waitFor over what the command printed), never a fixed sleep.

const T0 = 1_700_000_000_000;

function ev(
  executionId: string,
  sequence: number,
  eventType: string,
  payload: unknown = {},
  extra: Partial<EventEnvelope> = {}
): EventEnvelope {
  return {
    id: `${executionId}-${sequence}`,
    executionId,
    workflowId: "wf",
    eventType,
    sequence,
    timestamp: T0 + sequence * 1000,
    payload,
    ...extra,
  } as EventEnvelope;
}

async function seed(store: {
  append(e: EventEnvelope): Promise<void>;
}): Promise<void> {
  const log = async (id: string, wf: string, events: Array<[string, unknown]>) => {
    let seq = 0;
    for (const [type, payload] of events) {
      await store.append(ev(id, seq++, type, payload, { workflowId: wf }));
    }
  };
  await log("run-1", "alpha", [
    ["EXECUTION_STARTED", { input: {} }],
    ["STEP_STARTED", { stepId: "a" }],
  ]);
  await log("wait-gate", "alpha", [
    ["EXECUTION_STARTED", { input: {} }],
    ["EXECUTION_SUSPENDED", { condition: { on: "ApprovalGranted" } }],
  ]);
  await log("wait-timer", "beta", [
    ["EXECUTION_STARTED", { input: {} }],
    ["EXECUTION_SUSPENDED", { condition: { on: "timer", wakeAt: T0 + 3_600_000 } }],
  ]);
  await log("done", "alpha", [
    ["EXECUTION_STARTED", { input: {} }],
    ["EXECUTION_COMPLETED", { output: 1 }],
  ]);
  await log("broke", "beta", [
    ["EXECUTION_STARTED", { input: {} }],
    ["EXECUTION_FAILED", { error: "boom" }],
  ]);
}

describe("W4a — CLI over a SQLite store", () => {
  let dir: string;
  let db: string;
  let stdout: string[];
  let err: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "loom-w4a-"));
    db = join(dir, "events.db");
    const store = new SqliteEventStore(db);
    await seed(store);
    await store.close();
    stdout = [];
    err = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      stdout.push(`${a.join(" ")}\n`);
    });
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      err.push(a.join(" "));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });
  const printed = () => stdout.join("");

  describe("loom ls", () => {
    it("lists every execution with status, sequence and what a suspended one waits on", async () => {
      expect(await run(["ls", "--db", db, "--json"])).toBe(0);
      const doc = JSON.parse(printed()) as {
        executions: Array<{
          executionId: string;
          status: string;
          sequence: number;
          waiting?: { on: string; wakeAt?: number };
        }>;
        scanned: number;
        truncated?: string;
      };
      const by = Object.fromEntries(doc.executions.map((e) => [e.executionId, e]));
      expect(Object.keys(by).sort()).toEqual(["broke", "done", "run-1", "wait-gate", "wait-timer"]);
      expect(by["run-1"]).toMatchObject({ status: "running", sequence: 1 });
      expect(by.done?.status).toBe("completed");
      expect(by.broke?.status).toBe("failed");
      expect(by["wait-gate"]?.waiting).toEqual({ on: "ApprovalGranted" });
      expect(by["wait-timer"]?.waiting).toMatchObject({ wakeAt: T0 + 3_600_000 });
      expect(doc.truncated).toBeUndefined();
    });

    it("text form shows the gate event and the timer wakeAt", async () => {
      expect(await run(["ls", "--db", db, "--status", "suspended"])).toBe(0);
      const text = printed();
      expect(text).toContain("event ApprovalGranted");
      expect(text).toContain(`timer wakeAt ${new Date(T0 + 3_600_000).toISOString()}`);
      expect(text).not.toContain("run-1");
    });

    it("--workflow and --since filter; --since is relative to now", async () => {
      expect(await run(["ls", "--db", db, "--workflow", "beta", "--json"])).toBe(0);
      const ids = (
        JSON.parse(printed()) as { executions: Array<{ executionId: string }> }
      ).executions
        .map((e) => e.executionId)
        .sort();
      expect(ids).toEqual(["broke", "wait-timer"]);
      stdout.length = 0;
      // Every seeded event is from 2023: nothing happened in the last hour.
      expect(await run(["ls", "--db", db, "--since", "1h", "--json"])).toBe(0);
      expect((JSON.parse(printed()) as { executions: unknown[] }).executions).toEqual([]);
    });

    it("--limit truncates AND says so (a partial list is never printed as complete)", async () => {
      expect(await run(["ls", "--db", db, "--limit", "2", "--json"])).toBe(0);
      const doc = JSON.parse(printed()) as { executions: unknown[]; truncated?: string };
      expect(doc.executions).toHaveLength(2);
      expect(doc.truncated).toBe("limit");
      stdout.length = 0;
      expect(await run(["ls", "--db", db, "--limit", "2"])).toBe(0);
      expect(printed()).toContain("truncated at --limit 2");
    });

    it("the scan cap is reported, and bounds a filter that matches nothing", async () => {
      const store = new InMemoryAsyncEventStore();
      await seed(store);
      const r = await scanExecutions(store, { status: "cancelled", maxScan: 3 });
      expect(r.rows).toEqual([]);
      expect(r.scanned).toBe(3);
      expect(r.truncated).toBe("scan-cap");
    });

    it("an unknown --status is a refusal (exit 2), listing the valid ones", async () => {
      expect(await run(["ls", "--db", db, "--status", "sleeping"])).toBe(2);
      expect(err.join("\n")).toContain("running|suspended");
    });

    it("a store that cannot enumerate is refused (exit 2) in census's wording", async () => {
      const store = new InMemoryAsyncEventStore();
      Object.defineProperty(store, "listExecutions", { value: undefined });
      Object.defineProperty(store, "listExecutionsPage", { value: undefined });
      await expect(scanExecutions(store, {})).rejects.toMatchObject({
        exitCode: 2,
        message: expect.stringContaining(
          "implements neither listExecutions nor listExecutionsPage"
        ),
      });
    });

    it("shows the lease owner when a lease store is given", async () => {
      const leases = join(dir, "leases.db");
      const l = new SqliteLeaseStore(leases);
      await l.acquire("run-1", "node-7", 60_000);
      await l.close();
      expect(await run(["ls", "--db", db, "--leases", leases, "--json"])).toBe(0);
      const rows = (
        JSON.parse(printed()) as {
          executions: Array<{ executionId: string; lease?: { owner: string } }>;
        }
      ).executions;
      expect(rows.find((r) => r.executionId === "run-1")?.lease?.owner).toBe("node-7");
      expect(rows.find((r) => r.executionId === "done")?.lease).toBeUndefined();
    });

    it("writes nothing: the log is byte-for-byte what it was", async () => {
      expect(await run(["ls", "--db", db])).toBe(0);
      const store = new SqliteEventStore(db);
      expect((await store.read("run-1")).map((e) => e.sequence)).toEqual([0, 1]);
      await store.close();
    });
  });

  describe("census", () => {
    it("reports parked executions and a timer whose wakeAt already passed", async () => {
      expect(await run(["census", "--db", db, "--json"])).toBe(0);
      const doc = JSON.parse(printed()) as {
        suspended: { count: number; onTimer: number; overdue: number; overdueSample: unknown[] };
      };
      // wakeAt is T0 + 1h (2023): long past, and nothing woke it.
      expect(doc.suspended).toMatchObject({ count: 2, onTimer: 1, overdue: 1 });
      stdout.length = 0;
      expect(await run(["census", "--db", db])).toBe(0);
      expect(printed()).toContain("timer wakeAt already passed");
      expect(printed()).toContain("wait-timer");
    });
  });

  describe("logs filters and -v", () => {
    it("--type keeps only those event types", async () => {
      expect(await run(["logs", "--db", db, "run-1", "--type", "STEP_STARTED"])).toBe(0);
      expect(printed()).toContain("STEP_STARTED");
      expect(printed()).not.toContain("EXECUTION_STARTED");
    });

    it("--from/--to bound the sequence window (json too); from > to is exit 2", async () => {
      expect(await run(["logs", "--db", db, "run-1", "--from", "1", "--json"])).toBe(0);
      const seqs = printed()
        .trimEnd()
        .split("\n")
        .map((l) => (JSON.parse(l) as EventEnvelope).sequence);
      expect(seqs).toEqual([1]);
      expect(await run(["logs", "--db", db, "run-1", "--from", "5", "--to", "2"])).toBe(2);
    });

    it("an empty window on a real execution says so; a missing execution is still exit 1", async () => {
      expect(await run(["logs", "--db", db, "run-1", "--type", "NOPE"])).toBe(0);
      expect(printed()).toContain("no events match --type NOPE");
      expect(await run(["logs", "--db", db, "ghost", "--from", "3"])).toBe(1);
    });

    it("-v shows timestamps, gaps, step duration, and a truncated, REDACTED payload", async () => {
      const store = new SqliteEventStore(db);
      await store.append(
        ev("vx", 0, "EXECUTION_STARTED", {
          input: { token: "hunter2-secret" },
          principal: { actor: "alice" },
        })
      );
      await store.append(ev("vx", 1, "STEP_STARTED", { stepId: "s" }));
      await store.append(ev("vx", 2, "STEP_COMPLETED", { stepId: "s", output: "x".repeat(500) }));
      await store.close();
      expect(await run(["logs", "--db", db, "vx", "-v", "--redact", "token"])).toBe(0);
      const text = printed();
      expect(text).toContain(new Date(T0).toISOString());
      expect(text).toContain("+1000ms");
      expect(text).toContain("step 1000ms");
      expect(text).toContain("actor=alice");
      expect(text).not.toContain("hunter2-secret");
      expect(text).toContain("…");
      expect(text).not.toContain("x".repeat(300));
    });
  });

  describe("debug --at", () => {
    it("past the last sequence is refused (exit 2) and names both numbers", async () => {
      expect(await run(["debug", "--db", db, "run-1", "--at", "9"])).toBe(2);
      expect(err.join("\n")).toContain("sequence 9 > last (1)");
      expect(printed()).toBe("");
      expect(await run(["debug", "--db", db, "run-1", "--at", "9", "--json"])).toBe(2);
      expect(printed()).toBe("");
    });
    it("at the last sequence still works", async () => {
      expect(await run(["debug", "--db", db, "run-1", "--at", "1"])).toBe(0);
      expect(printed()).toContain("sequence: 1");
    });
  });

  describe("logs --follow", () => {
    it("prints existing events, then new ones as they land, and exits 0 on the terminal event", async () => {
      const writer = new SqliteEventStore(db);
      const done = run(["logs", "--db", db, "run-1", "--follow", "--interval", "10"]);
      await vi.waitFor(() => expect(printed()).toContain("STEP_STARTED"));
      await writer.append(ev("run-1", 2, "STEP_COMPLETED", { stepId: "a" }));
      await vi.waitFor(() => expect(printed()).toContain("STEP_COMPLETED"));
      expect(printed()).not.toContain("EXECUTION_COMPLETED");
      await writer.append(ev("run-1", 3, "EXECUTION_COMPLETED", { output: 1 }));
      expect(await done).toBe(0);
      expect(printed()).toContain("EXECUTION_COMPLETED");
      expect(printed()).toContain("-- execution run-1 completed (seq 3) --");
      // Each event printed once: following never re-prints what it already showed.
      expect(printed().match(/STEP_STARTED/g)).toHaveLength(1);
      await writer.close();
    });

    it("--json is pure ndjson on stdout; the finished note goes to stderr", async () => {
      const writer = new SqliteEventStore(db);
      const done = run(["logs", "--db", db, "run-1", "--follow", "--json", "--interval", "10"]);
      await vi.waitFor(() => expect(printed()).toContain("STEP_STARTED"));
      await writer.append(ev("run-1", 2, "EXECUTION_FAILED", { error: "x" }));
      expect(await done).toBe(0);
      const lines = printed().trimEnd().split("\n");
      expect(lines.map((l) => (JSON.parse(l) as EventEnvelope).sequence)).toEqual([0, 1, 2]);
      expect(err.join("\n")).toContain("failed");
      await writer.close();
    });

    it("a suspended execution is NOT terminal: it keeps following until the resume finishes it", async () => {
      const writer = new SqliteEventStore(db);
      const done = run(["logs", "--db", db, "wait-gate", "--follow", "--interval", "10"]);
      await vi.waitFor(() => expect(printed()).toContain("EXECUTION_SUSPENDED"));
      let settled = false;
      void done.then(() => {
        settled = true;
      });
      await writer.append(ev("wait-gate", 2, "EXECUTION_RESUMED", {}));
      await vi.waitFor(() => expect(printed()).toContain("EXECUTION_RESUMED"));
      expect(settled).toBe(false);
      await writer.append(ev("wait-gate", 3, "EXECUTION_COMPLETED", { output: 1 }));
      expect(await done).toBe(0);
      await writer.close();
    });

    it("already-finished execution: prints it all and exits 0 without waiting", async () => {
      expect(await run(["logs", "--db", db, "done", "--follow", "--interval", "10"])).toBe(0);
      expect(printed()).toContain("EXECUTION_COMPLETED");
    });

    it("--redact masks followed events", async () => {
      const writer = new SqliteEventStore(db);
      const done = run([
        "logs",
        "--db",
        db,
        "run-1",
        "--follow",
        "--redact",
        "pw",
        "--interval",
        "10",
      ]);
      await vi.waitFor(() => expect(printed()).toContain("STEP_STARTED"));
      await writer.append(ev("run-1", 2, "STEP_COMPLETED", { stepId: "a", pw: "topsecret-value" }));
      await writer.append(ev("run-1", 3, "EXECUTION_COMPLETED", { output: "topsecret-value" }));
      expect(await done).toBe(0);
      expect(printed()).not.toContain("topsecret-value");
      await writer.close();
    });

    it("an unknown execution id fails (exit 1) instead of waiting forever", async () => {
      expect(await run(["logs", "--db", db, "ghost", "--follow", "--interval", "10"])).toBe(1);
    });
  });
});

describe("W4a — follow abort", () => {
  it("returns 0 on abort without any terminal event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-w4a-abort-"));
    try {
      const db = join(dir, "e.db");
      const s = new SqliteEventStore(db);
      await s.append(ev("live", 0, "EXECUTION_STARTED", { input: {} }));
      await s.close();
      const ac = new AbortController();
      const lines: string[] = [];
      const done = cmdLogsFollow({ db }, "live", {
        write: (l) => lines.push(l),
        note: () => {},
        signal: ac.signal,
        intervalMs: 5,
      });
      await vi.waitFor(() => expect(lines.join("\n")).toContain("EXECUTION_STARTED"));
      ac.abort();
      expect(await done).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("W4a — inspector executions list", () => {
  it("serves the scan read-only, filters by status, and escapes in the page", async () => {
    const store = new InMemoryAsyncEventStore();
    await seed(store);
    const server = serveInspector(store);
    await server.start();
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const all = (await (await fetch(`${base}/api/executions`)).json()) as {
        executions: Array<{ executionId: string }>;
        statuses: string[];
      };
      expect(all.executions).toHaveLength(5);
      expect(all.statuses).toContain("suspended");
      const susp = (await (await fetch(`${base}/api/executions?status=suspended`)).json()) as {
        executions: Array<{ executionId: string }>;
      };
      expect(susp.executions.map((e) => e.executionId).sort()).toEqual(["wait-gate", "wait-timer"]);
      expect((await fetch(`${base}/api/executions?status=bogus`)).status).toBe(400);
      // Read-only: a POST is not a route.
      expect((await fetch(`${base}/api/executions`, { method: "POST" })).status).toBe(200);
      expect((await store.read("run-1")).length).toBe(2);
    } finally {
      await server.stop();
    }
  });

  it("501 when the store cannot enumerate", async () => {
    const store = new InMemoryAsyncEventStore();
    Object.defineProperty(store, "listExecutions", { value: undefined });
    Object.defineProperty(store, "listExecutionsPage", { value: undefined });
    const server = serveInspector(store);
    await server.start();
    try {
      const r = await fetch(`http://127.0.0.1:${server.port}/api/executions`);
      expect(r.status).toBe(501);
    } finally {
      await server.stop();
    }
  });
});

describe("W4a — config loading", () => {
  let dir: string;
  let err: string[];
  const saved = { quiet: process.env.LOOM_QUIET, debug: process.env.LOOM_DEBUG };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-cfg-"));
    err = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      err.push(a.join(" "));
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    Reflect.deleteProperty(process.env, "LOOM_QUIET");
    Reflect.deleteProperty(process.env, "LOOM_DEBUG");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    if (saved.quiet === undefined) Reflect.deleteProperty(process.env, "LOOM_QUIET");
    else process.env.LOOM_QUIET = saved.quiet;
    if (saved.debug === undefined) Reflect.deleteProperty(process.env, "LOOM_DEBUG");
    else process.env.LOOM_DEBUG = saved.debug;
  });

  // The refusal (no tsx beside the config) is pinned in builtCli.test.ts: under vitest NODE_PATH
  // exposes the workspace's hoisted tsx, so only a child process with a clean env sees it absent.

  it("a .ts config registers tsx from the CONFIG's directory, then loads it", async () => {
    const tsx = join(dir, "node_modules", "tsx", "cjs");
    mkdirSync(tsx, { recursive: true });
    writeFileSync(
      join(dir, "node_modules", "tsx", "package.json"),
      JSON.stringify({ name: "tsx", version: "0.0.0" })
    );
    writeFileSync(
      join(tsx, "api.js"),
      "globalThis.__tsxRegistered = (globalThis.__tsxRegistered || 0) + 1;" +
        "exports.register = () => () => { globalThis.__tsxUnregistered = (globalThis.__tsxUnregistered || 0) + 1; };"
    );
    // Rewrite tsx/cjs/api resolution: the package has no exports map, so the path resolves.
    const file = join(dir, "app.config.ts");
    writeFileSync(file, "module.exports = { stores: { eventStore: {} } };\n");
    const g = globalThis as { __tsxRegistered?: number; __tsxUnregistered?: number };
    const app = await loadLoomApp(file);
    expect(app.stores).toBeDefined();
    expect(g.__tsxRegistered).toBe(1);
    expect(g.__tsxUnregistered).toBe(1);
  });

  it("an import error is wrapped with the absolute file; --verbose adds the stack, default does not", async () => {
    const file = join(dir, "bad.config.js");
    writeFileSync(file, 'throw new Error("kaboom at import");\n');
    expect(await run(["ls", "--config", file])).toBe(1);
    const plain = err.join("\n");
    expect(plain).toContain(`while loading ${file}: kaboom at import`);
    expect(plain).toContain("hint:");
    expect(plain).not.toMatch(/\n\s+at /);
    err.length = 0;
    expect(await run(["ls", "--config", file, "--verbose"])).toBe(1);
    expect(err.join("\n")).toMatch(/\n\s+at /);
    err.length = 0;
    process.env.LOOM_DEBUG = "1";
    expect(await run(["ls", "--config", file])).toBe(1);
    expect(err.join("\n")).toMatch(/\n\s+at /);
  });

  it("a missing config names the file and the compiled-js hint", async () => {
    const file = join(dir, "nope.js");
    expect(await run(["ls", "--config", file])).toBe(1);
    expect(err.join("\n")).toContain(`while loading ${file}`);
    expect(err.join("\n")).toContain("built? point --config at the compiled .js");
  });

  it("LOOM_QUIET is set only while the config imports, then restored", async () => {
    const file = join(dir, "q.config.js");
    writeFileSync(file, "globalThis.__quietSeen = process.env.LOOM_QUIET;\nmodule.exports = {};\n");
    await loadLoomApp(file);
    expect((globalThis as { __quietSeen?: string }).__quietSeen).toBe("1");
    expect(process.env.LOOM_QUIET).toBeUndefined();
    // LOOM_DEBUG=1 leaves the notices on. (A fresh file: require caches the first.)
    const second = join(dir, "q2.config.js");
    writeFileSync(
      second,
      "globalThis.__quietSeen = process.env.LOOM_QUIET;\nmodule.exports = {};\n"
    );
    process.env.LOOM_DEBUG = "1";
    await loadLoomApp(second);
    expect((globalThis as { __quietSeen?: string }).__quietSeen).toBeUndefined();
  });

  it("with neither --config nor --db, ./loom.config.js is used and announced; none → refusal", async () => {
    const cwd = process.cwd();
    const file = join(dir, "loom.config.js");
    writeFileSync(file, "module.exports = { stores: { eventStore: {} } };\n");
    process.chdir(dir);
    try {
      // The stub store cannot enumerate, so `ls` refuses (2) — AFTER proving the config was found.
      expect(await run(["ls"])).toBe(2);
      expect(err.join("\n")).toContain("using ./loom.config.js");
      expect(err.join("\n")).toContain("implements neither listExecutions");
      err.length = 0;
      // --apply never guesses a store.
      expect(await run(["retention", "run", "--ttl", "1d", "--apply"])).toBe(2);
      expect(err.join("\n")).not.toContain("using ./loom.config.js");
      rmSync(file);
      err.length = 0;
      expect(await run(["ls"])).toBe(2);
      expect(err.join("\n")).toContain("--config <module>");
    } finally {
      process.chdir(cwd);
    }
  });
});
