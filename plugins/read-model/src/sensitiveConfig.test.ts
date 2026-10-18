import { describe, expect, it } from "vitest";
import { effectiveFoldVersion, mergeSensitive, sensitiveMapFromCovers } from "./sensitiveConfig";

describe("sensitive map helpers (ADR 0132 D5, D11)", () => {
  it("derives the map from sealingCapability().covers", () => {
    expect(
      sensitiveMapFromCovers([
        "STEP_COMPLETED.output.ssn",
        "STEP_COMPLETED.output.dob",
        "OTHER.a",
        "BARE",
      ])
    ).toEqual({ STEP_COMPLETED: ["output.dob", "output.ssn"], OTHER: ["a"] });
  });

  it("unions maps and de-duplicates paths", () => {
    expect(mergeSensitive({ A: ["x"] }, undefined, { A: ["x", "y"], B: ["z"] })).toEqual({
      A: ["x", "y"],
      B: ["z"],
    });
  });

  it("leaves the declared version alone when nothing is declared", () => {
    expect(effectiveFoldVersion("1", {})).toBe("1");
    expect(effectiveFoldVersion("1", { A: [] })).toBe("1");
  });

  it("changes the version when the declared paths change, and not with key or path order", () => {
    const a = effectiveFoldVersion("1", { A: ["x", "y"], B: ["z"] });
    expect(a).toMatch(/^1\+sens\.[0-9a-f]{8}$/);
    expect(effectiveFoldVersion("1", { B: ["z"], A: ["y", "x"] })).toBe(a);
    expect(effectiveFoldVersion("1", { A: ["x"], B: ["z"] })).not.toBe(a);
  });

  it("rejects a badly shaped map instead of silently not masking", () => {
    expect(() => mergeSensitive({ A: "email" } as never)).toThrow(TypeError);
    expect(() => mergeSensitive({ A: ["ok", " "] })).toThrow(/non-blank/);
    expect(() => mergeSensitive([] as never)).toThrow(TypeError);
  });

  it("treats inherited names as ordinary event types", () => {
    expect(mergeSensitive({ constructor: ["x"] }, { constructor: ["y"] })).toEqual({
      constructor: ["x", "y"],
    });
    expect(sensitiveMapFromCovers(["toString.a"])).toEqual({ toString: ["a"] });
    expect(effectiveFoldVersion("1", {})).toBe("1");
  });
});
