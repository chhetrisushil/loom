import { assertReachMatches, readReachDeclaration, recordReach } from "@loom/verify";
import { describe, expect, it } from "vitest";
import { recordOutcome } from "./outcomes";

// L34 - claim vs reality (ADR 0086): `recordOutcome(ctx, …)` emits a fact and runs no tool.
describe("declared reach (L34)", () => {
  it("recordOutcome declares an empty reach and runs no tool", () => {
    const decl = readReachDeclaration(recordOutcome);
    expect(decl).toEqual({ run: [], transient: [] });
    const rec = recordReach();
    const emitted: string[] = [];
    const ctx = rec.ctx({
      emit: (type: string) => emitted.push(type),
      run: async () => undefined,
      execute: async () => undefined,
      parallel: async () => [],
    });
    recordOutcome(ctx, { key: "k", success: true });
    expect(emitted).toEqual(["OUTCOME_RECORDED"]);
    assertReachMatches(decl as never, rec.recorded, { exact: true });
  });
});
