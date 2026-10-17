import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@loom/core";
import { SqliteEventStore, SqliteSnapshotStore } from "@loom/plugin-sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./cli";

// ── Exit codes are a contract: 0 ok · 1 verdict/runtime failure · 2 refusal or bad usage ──
//
// Each refusal below asserts the exit code AND that it changed nothing: a refusal that still
// wrote (or created a file) is the failure mode these guards exist to prevent, so the negative
// case must prove the guard fired, not merely that a message was printed.

const old = Date.now() - 90 * 86_400_000;

function ev(sequence: number, eventType: string, payload: unknown): EventEnvelope {
  return {
    id: `done-${sequence}`,
    executionId: "done",
    workflowId: "wf",
    eventType,
    sequence,
    timestamp: old + sequence,
    payload,
  } as EventEnvelope;
}

describe("CLI exit codes + nothing-written refusals", () => {
  let dir: string;
  let db: string;
  let snap: string;
  let err: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "loom-exit-"));
    db = join(dir, "events.db");
    snap = join(dir, "snap.db");
    const events = new SqliteEventStore(db);
    await events.append(ev(0, "EXECUTION_STARTED", { input: {} }));
    await events.append(ev(1, "EXECUTION_COMPLETED", { output: {} }));
    await events.close();
    await new SqliteSnapshotStore(snap).close();
    err = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      err.push(a.join(" "));
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const files = () => readdirSync(dir).sort();
  async function logLength(): Promise<number> {
    const events = new SqliteEventStore(db);
    const n = (await events.read("done")).length;
    await events.close();
    return n;
  }

  it("a missing --db is exit 1, names the absolute path, and is NOT created (F6)", async () => {
    const missing = join(dir, "nope.db");
    const before = files();
    expect(await run(["logs", "--db", missing, "done"])).toBe(1);
    expect(err.join("\n")).toContain(missing);
    expect(err.join("\n")).toContain("cwd");
    expect(existsSync(missing)).toBe(false);
    expect(files()).toEqual(before);
  });

  it("a missing --snap on a read verb is refused too, and not created", async () => {
    const missing = join(dir, "nosnap.db");
    expect(await run(["debug", "--db", db, "--snap", missing, "done"])).toBe(1);
    expect(existsSync(missing)).toBe(false);
  });

  it("an unknown execution id is exit 1 with the store's execution count", async () => {
    for (const cmd of ["logs", "debug", "profile", "introspect", "optimize"]) {
      err.length = 0;
      expect(await run([cmd, "--db", db, "ghost"]), cmd).toBe(1);
      expect(err.join("\n"), cmd).toMatch(/no such execution ghost \(1 execution in this store/);
      expect(err.join("\n"), cmd).toContain("loom census");
    }
    expect(await run(["logs", "--db", db, "done"])).toBe(0); // a real id still works
  });

  it("retention run without --ttl is refused (exit 2) and reclaims nothing", async () => {
    expect(await run(["retention", "run", "--db", db, "--snap", snap, "--apply"])).toBe(2);
    expect(err.join("\n")).toContain("--ttl");
    expect(await logLength()).toBe(2); // the aged terminal execution survived
  });

  it("retention run with a mistyped --ttl is exit 2, not 0ms", async () => {
    expect(
      await run(["retention", "run", "--db", db, "--snap", snap, "--ttl", "soon", "--apply"])
    ).toBe(2);
    expect(await logLength()).toBe(2);
  });

  it("an explicit --ttl still works (and --ttl 30d is a duration)", async () => {
    expect(await run(["retention", "run", "--db", db, "--snap", snap, "--ttl", "30d"])).toBe(0);
    expect(await run(["retention", "run", "--db", db, "--snap", snap, "--ttl", "0"])).toBe(0);
  });

  it("retention run without --snap is exit 2 (was 0)", async () => {
    expect(await run(["retention", "run", "--db", db, "--ttl", "1d", "--apply"])).toBe(2);
    expect(await logLength()).toBe(2);
  });

  it("recover without leases or --stale is exit 2 (was 0) and re-drives nothing", async () => {
    expect(await run(["recover", "--db", db])).toBe(2);
    expect(err.join("\n")).toContain("will not guess");
    expect(await logLength()).toBe(2);
  });

  it("recover --apply on the --db shorthand is exit 2", async () => {
    expect(await run(["recover", "--db", db, "--stale", "15m", "--apply"])).toBe(2);
    expect(await logLength()).toBe(2);
  });

  it("introspect --graph bogus is exit 2 (was 0)", async () => {
    expect(await run(["introspect", "--db", db, "done", "--graph", "bogus"])).toBe(2);
    expect(err.join("\n")).toContain('unknown graph "bogus"');
  });

  it("branches / repair / plugin / knowledge / learn unknown subcommands are exit 2", async () => {
    expect(await run(["branches", "bogus", "--db", db])).toBe(2);
    expect(await run(["repair", "bogus", "--db", db])).toBe(2);
    expect(await run(["learn", "bogus", "--db", db])).toBe(2);
    expect(await run(["plugin", "bogus"])).toBe(2);
  });

  it("an unknown command and missing store flags are exit 2", async () => {
    expect(await run(["logz"])).toBe(2);
    expect(await run(["logs", "done"])).toBe(2);
    expect(await run(["logs", "--db", db])).toBe(2); // missing <executionId>
  });

  it("a typo'd flag is exit 2 with a suggestion — never a silent dry run", async () => {
    expect(await run(["recover", "--db", db, "--stale", "15m", "--aply"])).toBe(2);
    expect(err.join("\n")).toContain("did you mean --apply");
  });

  it("a non-numeric --at / --limit is exit 2, not NaN", async () => {
    expect(await run(["debug", "--db", db, "--at", "abc", "done"])).toBe(2);
    expect(await run(["census", "--db", db, "--sample", "many"])).toBe(2);
  });

  it("a positional after a boolean flag is a positional", async () => {
    // `--json` was swallowed as the value of... nothing; `logs --json <id>` must resolve the id.
    expect(await run(["logs", "--db", db, "--json", "done"])).toBe(0);
    expect(err.join("\n")).toContain("--json is not implemented yet");
  });

  it("a failed verdict stays exit 1 (compat major mismatch)", async () => {
    expect(await run(["compat", "--abi", "999.0.0"])).toBe(1);
  });
});
