import { KERNEL_EVENT_KINDS } from "@loom/core";
import { describe, expect, it } from "vitest";
import { EVENT_KIND_CLASS, isAnsweringKind } from "./eventKindClass";

describe("answering / ignorable classification (ADR 0118 D1)", () => {
  it("classifies every kernel kind, and nothing else", () => {
    expect(Object.keys(EVENT_KIND_CLASS).sort()).toEqual([...KERNEL_EVENT_KINDS].sort());
  });

  it("the answering set is exactly the resume, the park and the terminal kinds", () => {
    const answering = KERNEL_EVENT_KINDS.filter((k) => EVENT_KIND_CLASS[k] === "answering");
    expect(answering.sort()).toEqual([
      "EXECUTION_CANCELLED",
      "EXECUTION_COMPLETED",
      "EXECUTION_CONTINUED",
      "EXECUTION_FAILED",
      "EXECUTION_RESUMED",
      "EXECUTION_SUSPENDED",
    ]);
  });

  it("audit appends that follow a park never answer it", () => {
    for (const k of ["EXECUTION_DENIED", "OUTCOME_RECORDED", "STEP_FAILED", "MESSAGE_CONSUMED"]) {
      expect(isAnsweringKind(k)).toBe(false);
    }
  });

  it("a kind absent from the map is answering (fail-closed), including prototype names", () => {
    for (const k of ["SOME_FUTURE_KIND", "__proto__", "constructor", "toString", ""]) {
      expect(isAnsweringKind(k)).toBe(true);
    }
  });
});
