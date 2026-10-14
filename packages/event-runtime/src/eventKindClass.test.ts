import { KERNEL_EVENT_KINDS } from "@loom/core";
import { describe, expect, it } from "vitest";
import { EVENT_KIND_CLASS, isAnsweringKind } from "./eventKindClass";

const env = (eventType: string, metadata?: Record<string, unknown>) => ({
  eventType,
  ...(metadata !== undefined && { metadata }),
});

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
      expect(isAnsweringKind(env(k))).toBe(false);
    }
  });

  it("the ADR 0130 residual kinds (1.25.0, reserved) are ignorable, like MESSAGE_CONSUMED: they land under the park's conditional fence and leave it unanswered", () => {
    for (const k of ["INBOX_QUARANTINED", "INBOX_RELEASED"] as const) {
      expect(EVENT_KIND_CLASS[k]).toBe(EVENT_KIND_CLASS.MESSAGE_CONSUMED);
      expect(isAnsweringKind(env(k, { kernel: true }))).toBe(false);
      expect(isAnsweringKind(env(k))).toBe(false);
    }
  });

  it("a kernel kind is classified by its entry, stamped or not", () => {
    expect(isAnsweringKind(env("EXECUTION_RESUMED"))).toBe(true);
    expect(isAnsweringKind(env("EXECUTION_RESUMED", { kernel: true }))).toBe(true);
    expect(isAnsweringKind(env("STEP_STARTED", { kernel: true }))).toBe(false);
  });

  it("an APPLICATION kind never answers, so a parallel sibling's emit after the park cannot stale the acquire", () => {
    // ctx.emit stamps `flowEmit`; ctx.stream deltas and app events carry no kernel stamp.
    for (const e of [
      env("app.sibling.emitted", { flowEmit: true }),
      env("stream.delta"),
      env("SOME_APP_KIND"),
      env("__proto__"),
      env("constructor"),
      env("toString"),
      env(""),
    ]) {
      expect(isAnsweringKind(e), JSON.stringify(e)).toBe(false);
    }
    // a stamp that is not literally `true` is not a kernel claim
    expect(isAnsweringKind(env("SOME_APP_KIND", { kernel: "true" }))).toBe(false);
    expect(isAnsweringKind(env("SOME_APP_KIND", { kernel: 1 }))).toBe(false);
  });

  it("an unknown KERNEL kind (a newer node in a mixed fleet, stamped) is answering: fail-closed", () => {
    expect(isAnsweringKind(env("EXECUTION_REWOUND", { kernel: true }))).toBe(true);
    expect(isAnsweringKind(env("__proto__", { kernel: true }))).toBe(true);
  });
});
