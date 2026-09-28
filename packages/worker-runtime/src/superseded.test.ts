import { StorageWriteError } from "@loom/core";
import { describe, expect, it } from "vitest";
import { ExecutionSupersededError, isSupersededRefusal } from "./superseded";

function named(name: string, fields: Record<string, unknown> = {}): Error {
  const err = Object.assign(new Error(name), fields);
  err.name = name;
  return err;
}
const stale = (executionId: string) => named("StaleFenceError", { executionId });

describe("isSupersededRefusal (L20)", () => {
  it("accepts the three refusal shapes, for THIS execution only", () => {
    for (const err of [
      named("ExecutionAlreadyExistsError", { executionId: "e" }),
      new StorageWriteError(stale("e")),
      stale("e"),
      new ExecutionSupersededError("e"),
    ]) {
      expect(isSupersededRefusal(err, "e")).toBe(true);
      expect(isSupersededRefusal(err, "other")).toBe(false);
    }
  });

  it("rejects genuine failures, including every other storage error", () => {
    for (const err of [
      new StorageWriteError(new Error("disk full")),
      new StorageWriteError(named("DuplicateSequenceError", { executionId: "e" })),
      new StorageWriteError(undefined),
      new Error("transport blip"),
      named("ExecutionAlreadyExistsError"), // names no execution
      undefined,
      null,
      "StaleFenceError",
    ]) {
      expect(isSupersededRefusal(err, "e")).toBe(false);
    }
  });

  it("ExecutionSupersededError carries a stable name for the wire", () => {
    const err = new ExecutionSupersededError("e");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ExecutionSupersededError");
    expect(err.executionId).toBe("e");
  });
});
