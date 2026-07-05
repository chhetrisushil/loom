import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionState } from "@loom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteSnapshotStore } from "./SqliteSnapshotStore";

function makeState(executionId: string, sequence: number): ExecutionState {
  return {
    executionId,
    workflowId: "test-flow",
    workflowVersion: "1.0.0",
    status: "running",
    frames: {
      "step-1": { stepId: "step-1", status: "completed", attempts: 1, output: { result: "ok" } },
    },
    variables: { _input: { id: "abc" } },
    sequence,
    startedAt: 1000,
    updatedAt: 2000,
  };
}

let store: SqliteSnapshotStore;
let dbDir: string;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "loom-snap-test-"));
  store = new SqliteSnapshotStore(join(dbDir, "snapshots.db"));
});

afterEach(() => {
  store.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("SqliteSnapshotStore", () => {
  it("saves and loads the latest snapshot", () => {
    const state = makeState("exec-1", 5);
    store.save({
      id: "snap-1",
      executionId: "exec-1",
      workflowId: "test-flow",
      sequence: 5,
      state,
      createdAt: Date.now(),
    });
    const loaded = store.loadLatest("exec-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.sequence).toBe(5);
    expect(loaded!.state).toEqual(state);
  });

  it("returns null for unknown executionId", () => {
    expect(store.loadLatest("unknown")).toBeNull();
  });

  it("loadLatest returns the highest sequence snapshot", () => {
    store.save({
      id: "s1",
      executionId: "exec-2",
      workflowId: "f",
      sequence: 2,
      state: makeState("exec-2", 2),
      createdAt: 1,
    });
    store.save({
      id: "s2",
      executionId: "exec-2",
      workflowId: "f",
      sequence: 10,
      state: makeState("exec-2", 10),
      createdAt: 2,
    });
    store.save({
      id: "s3",
      executionId: "exec-2",
      workflowId: "f",
      sequence: 7,
      state: makeState("exec-2", 7),
      createdAt: 3,
    });
    const latest = store.loadLatest("exec-2");
    expect(latest!.sequence).toBe(10);
  });

  it("loadAt returns snapshot at the exact sequence", () => {
    store.save({
      id: "s4",
      executionId: "exec-3",
      workflowId: "f",
      sequence: 5,
      state: makeState("exec-3", 5),
      createdAt: 1,
    });
    store.save({
      id: "s5",
      executionId: "exec-3",
      workflowId: "f",
      sequence: 9,
      state: makeState("exec-3", 9),
      createdAt: 2,
    });
    const snap = store.loadAt("exec-3", 5);
    expect(snap!.sequence).toBe(5);
    expect(store.loadAt("exec-3", 99)).toBeNull();
  });

  it("round-trips ExecutionState through JSON without data loss", () => {
    const state = makeState("exec-4", 3);
    state.suspendedOn = { on: "ApprovalGranted", correlationKey: "my-key", timeout: 86400000 };
    store.save({
      id: "s6",
      executionId: "exec-4",
      workflowId: "f",
      sequence: 3,
      state,
      createdAt: 1,
    });
    const loaded = store.loadLatest("exec-4");
    expect(loaded!.state).toEqual(state);
    expect(loaded!.state.suspendedOn?.on).toBe("ApprovalGranted");
  });
});
