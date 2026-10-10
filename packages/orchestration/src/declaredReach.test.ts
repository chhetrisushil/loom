import { step$ } from "@loom/core";
import { assertReachMatches, readReachDeclaration, recordReach } from "@loom/verify";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fanout$ } from "./fanout";
import { awaitAll, awaitChild, awaitChildren, boundOrchestration } from "./orchestration";

// L34 - claim vs reality for the hand-offs this package ships (ADR 0086): run each against a
// recording ctx and compare what it RAN with what it DECLARED.

function fakeCtx() {
  return {
    executionId: "x",
    run: async () => undefined,
    execute: async () => undefined,
    parallel: async (pairs: unknown[]) => pairs.map(() => 1),
    decide: async (_id: string, decider: (scope: object) => unknown) =>
      decider({
        invokeTransient: async () => undefined,
      }),
    suspend: async () => ({ output: 1, results: [], settled: [] }),
  };
}

const hydrate = step$({
  id: "hydrate",
  toolId: "hydrate.tool",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
});

describe("declared reach (L34)", () => {
  it("fanout$ declares a pass-through of argument 1, and the tool it ran is the caller's step", async () => {
    const decl = readReachDeclaration(fanout$);
    expect(decl).toEqual({ run: [], transient: [], stepArgs: [1] });
    const rec = recordReach();
    await fanout$(rec.ctx(fakeCtx()) as never, hydrate, ["a", "b"]);
    expect(rec.recorded.run).toEqual(["hydrate.tool"]);
    // Covered only because the test PASSED that step: the declaration claims no tool of its own.
    assertReachMatches(decl as never, rec.recorded, { passedSteps: ["hydrate.tool"] });
    expect(() => assertReachMatches(decl as never, rec.recorded)).toThrow(/hydrate\.tool/);
    expect(() =>
      assertReachMatches(decl as never, rec.recorded, { passedSteps: ["something.else"] })
    ).toThrow(/hydrate\.tool/);
  });

  it.each([
    ["awaitChild", awaitChild, { key: "k", flowId: "f", input: 1 }],
    ["awaitChildren", awaitChildren, { key: "k", children: [{ flowId: "f", input: 1 }] }],
    ["awaitAll", awaitAll, { key: "k", children: [{ flowId: "f", input: 1 }] }],
  ] as const)("%s declares it reaches no tool, and ran none", async (_n, fn, arg) => {
    const decl = readReachDeclaration(fn);
    expect(decl).toEqual({ run: [], transient: [] });
    const rec = recordReach();
    const ctx = fakeCtx();
    ctx.suspend = async () =>
      ({ output: 1, results: [{ status: "completed", output: 1 }] }) as never;
    await (fn as (c: unknown, a: unknown) => Promise<unknown>)(rec.ctx(ctx), arg).catch(() => {});
    assertReachMatches(decl as never, rec.recorded, { exact: true });
    expect(rec.recorded).toEqual({ run: [], transient: [] });
  });

  it("the bound variants carry the same declaration", () => {
    const b = boundOrchestration({ maxDepth: 3 } as never);
    for (const f of [b.awaitChild, b.awaitChildren, b.awaitAll]) {
      expect(readReachDeclaration(f)).toEqual({ run: [], transient: [] });
    }
  });
});
