import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope, ExecutionState } from "@loom/core";
import { SqliteEventStore, SqliteSnapshotStore } from "@loom/plugin-sqlite";
import { zstdAvailable } from "@loom/snapshot-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./cli";

// `loom snapshot show` (ADR 0141): prints a stored snapshot DECODED, whichever format holds it.

function state(tag: string): ExecutionState {
  return {
    executionId: "x",
    workflowId: "wf",
    status: "running",
    frames: {},
    variables: { tag, secret: "hunter2-secret", text: "the same words again ".repeat(300) },
  } as unknown as ExecutionState;
}

describe("loom snapshot show", () => {
  let dir: string;
  let db: string;
  let snap: string;
  let out: string[];
  let err: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "loom-snapshow-"));
    db = join(dir, "events.db");
    snap = join(dir, "snap.db");
    const events = new SqliteEventStore(db);
    await events.append({
      id: "x-0",
      executionId: "x",
      workflowId: "wf",
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: 1,
      payload: { input: {} },
    } as EventEnvelope);
    await events.close();
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      err.push(a.join(" "));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  async function seed(codec: "none" | "zstd"): Promise<void> {
    const s = new SqliteSnapshotStore(snap, { codec });
    await s.save({
      id: "a",
      executionId: "x",
      workflowId: "wf",
      sequence: 1,
      state: state("one"),
      createdAt: 10,
    });
    await s.save({
      id: "b",
      executionId: "x",
      workflowId: "wf",
      sequence: 5,
      state: state("five"),
      createdAt: 50,
    });
    await s.close();
  }

  for (const codec of zstdAvailable() ? (["none", "zstd"] as const) : (["none"] as const)) {
    it(`prints the latest snapshot decoded (${codec} at rest)`, async () => {
      await seed(codec);
      expect(await run(["snapshot", "show", "--db", db, "--snap", snap, "x"])).toBe(0);
      const printed = JSON.parse(out.join("\n"));
      expect(printed).toMatchObject({ id: "b", executionId: "x", workflowId: "wf", sequence: 5 });
      expect(printed.state).toEqual(state("five"));
    });

    it(`--at SEQ prints exactly that snapshot (${codec} at rest)`, async () => {
      await seed(codec);
      expect(await run(["snapshot", "show", "--db", db, "--snap", snap, "x", "--at", "1"])).toBe(0);
      expect(JSON.parse(out.join("\n")).state.variables.tag).toBe("one");
    });
  }

  it("--at a sequence with no snapshot is exit 1 and does not substitute a neighbour", async () => {
    await seed("none");
    expect(await run(["snapshot", "show", "--db", db, "--snap", snap, "x", "--at", "3"])).toBe(1);
    expect(out.join("")).toBe("");
    expect(err.join("\n")).toMatch(/no snapshot for execution x at sequence 3/);
  });

  it("an execution with no snapshot is exit 1", async () => {
    await seed("none");
    expect(await run(["snapshot", "show", "--db", db, "--snap", snap, "nope"])).toBe(1);
  });

  it("--redact masks output paths", async () => {
    await seed("none");
    expect(
      await run([
        "snapshot",
        "show",
        "--db",
        db,
        "--snap",
        snap,
        "x",
        "--redact",
        "variables.secret",
      ])
    ).toBe(0);
    const text = out.join("\n");
    expect(text).not.toContain("hunter2-secret");
    expect(JSON.parse(text).state.variables.tag).toBe("five");
  });

  it("--db without --snap is a refusal (exit 2) naming the fix", async () => {
    expect(await run(["snapshot", "show", "--db", db, "x"])).toBe(2);
    expect(err.join("\n")).toMatch(/--snap/);
  });

  it("an unknown subcommand and a missing id are usage errors (exit 2)", async () => {
    expect(await run(["snapshot", "dump", "--db", db, "x"])).toBe(2);
    expect(await run(["snapshot", "show", "--db", db, "--snap", snap])).toBe(2);
  });
});
