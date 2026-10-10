import { assertReachMatches, readReachDeclaration, recordReach } from "@loom/verify";
import { describe, expect, it } from "vitest";
import { decideWithPolicy } from "./decideWithPolicy";
import { decideWithRollout } from "./rollout";

// L34 - claim vs reality (ADR 0086): the decision hand-offs run no tool.

function fakeCtx() {
  return {
    run: async () => undefined,
    execute: async () => undefined,
    parallel: async () => [],
    decide: async (_id: string, decider: (scope: object) => unknown) =>
      decider({ invokeTransient: async () => undefined }),
  };
}

describe("declared reach (L34)", () => {
  it("decideWithPolicy declares an empty reach and runs no tool", async () => {
    const decl = readReachDeclaration(decideWithPolicy);
    expect(decl).toEqual({ run: [], transient: [] });
    const rec = recordReach();
    const policy = {
      id: "p",
      version: "1",
      select: (_c: unknown, actions: readonly string[]) => ({ action: actions[0] as string }),
    };
    const out = await decideWithPolicy(rec.ctx(fakeCtx()) as never, "d", policy as never, {}, [
      "a",
      "b",
    ]);
    expect(out).toBe("a");
    assertReachMatches(decl as never, rec.recorded, { exact: true });
  });

  it("decideWithRollout declares an empty reach", () => {
    expect(readReachDeclaration(decideWithRollout)).toEqual({ run: [], transient: [] });
  });
});
