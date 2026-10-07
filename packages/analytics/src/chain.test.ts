import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { chainLineage } from "./chain";

const ev = (
  executionId: string,
  sequence: number,
  eventType: string,
  payload: unknown = {},
  metadata?: Record<string, unknown>
): EventEnvelope => ({
  id: `${executionId}-${sequence}`,
  workflowId: "w",
  executionId,
  eventType,
  sequence,
  timestamp: 1000 + sequence,
  payload,
  ...(metadata !== undefined && { metadata }),
});

const started = (id: string, extra: Record<string, unknown> = {}) =>
  ev(id, 0, "EXECUTION_STARTED", { input: {}, ...extra });
const continued = (id: string, seq: number, to: string, generation: number, chainId: string) =>
  ev(id, seq, "EXECUTION_CONTINUED", { successorId: to, chainId, generation }, { kernel: true });

describe("chainLineage (ADR 0109 D6)", () => {
  const log = [
    started("c"),
    continued("c", 3, "c~1", 1, "c"),
    started("c~1", { chainId: "c", generation: 1, continuedFrom: { executionId: "c" } }),
    continued("c~1", 2, "c~2", 2, "c"),
    started("c~2", { chainId: "c", generation: 2, continuedFrom: { executionId: "c~1" } }),
    ev("c~2", 1, "EXECUTION_SUSPENDED", { condition: { on: "x" } }),
    started("other"),
  ];

  it("orders the generations and names the head, from any member", () => {
    for (const anchor of ["c", "c~1", "c~2"]) {
      const l = chainLineage(log, anchor);
      expect(l?.chainId).toBe("c");
      expect(l?.generations.map((g) => [g.executionId, g.generation, g.status])).toEqual([
        ["c", 0, "continued"],
        ["c~1", 1, "continued"],
        ["c~2", 2, "suspended"],
      ]);
      expect(l?.head).toBe("c~2");
      expect(l?.complete).toBe(true);
    }
    expect(chainLineage(log, "c~1")?.generations[1]?.continuedFrom).toBe("c");
  });

  it("is a lower bound, not a lie, when a generation's log is missing", () => {
    const l = chainLineage(
      log.filter((e) => e.executionId !== "c~1"),
      "c~2"
    );
    expect(l?.generations.map((g) => g.executionId)).toEqual(["c", "c~2"]);
    expect(l?.complete).toBe(false);
  });

  it("ignores an unstamped EXECUTION_CONTINUED (an app event of that name is not a fact)", () => {
    const forged = [
      started("f"),
      ev("f", 1, "EXECUTION_CONTINUED", { successorId: "f~1", chainId: "f", generation: 1 }),
    ];
    const l = chainLineage(forged, "f");
    expect(l?.generations[0]?.status).toBe("running");
    expect(l?.generations[0]?.continuedTo).toBeUndefined();
  });

  it("reads identity through the fold: a fork of a chain member is its own chain", () => {
    const fork = [
      ...log,
      // a fork of c~2 copies sequence 0 verbatim and stamps forkChain on every envelope
      ev(
        "fork",
        0,
        "EXECUTION_STARTED",
        { input: {}, chainId: "c", generation: 2, continuedFrom: { executionId: "c~1" } },
        { forkedFrom: "c~2", forkChain: { chainId: "fork", generation: 0 } }
      ),
    ];
    const l = chainLineage(fork, "fork");
    expect(l?.chainId).toBe("fork");
    expect(l?.generations.map((g) => g.executionId)).toEqual(["fork"]);
    expect(l?.generations[0]?.continuedFrom).toBeUndefined();
    // and the original chain does not list the fork
    expect(chainLineage(fork, "c~2")?.generations.map((g) => g.executionId)).toEqual([
      "c",
      "c~1",
      "c~2",
    ]);
  });

  it("an execution that never continued is a one-generation chain of itself", () => {
    const l = chainLineage(log, "other");
    expect(l).toMatchObject({ chainId: "other", head: "other", complete: true });
    expect(l?.generations).toHaveLength(1);
  });

  it("returns undefined for an unknown execution", () => {
    expect(chainLineage(log, "nope")).toBeUndefined();
  });
});
