import { describe, expect, it } from "vitest";
import { canonicalJson, contentHash, modelVersion, promptVersion, refMatches } from "./versions";

describe("content-addressed versions (R18)", () => {
  it("the version IS the content: equal content shares it, a one-character edit changes it", () => {
    const a = promptVersion("triage", "You are a router.");
    expect(promptVersion("triage", "You are a router.")).toEqual(a);
    expect(promptVersion("triage", "You are a router!").version).not.toBe(a.version);
    expect(a.version).toMatch(/^sha256:[0-9a-f]{64}$/);
    // a prompt and a model config with the same bytes are still different kinds
    expect(modelVersion("m", { x: 1 }).version).not.toBe(promptVersion("m", { x: 1 }).version);
  });

  it("key order does not matter; a changed parameter does", () => {
    const m = modelVersion("claude", { model: "x", temperature: 0, tools: ["a", "b"] });
    expect(modelVersion("claude", { tools: ["a", "b"], temperature: 0, model: "x" })).toEqual(m);
    expect(
      modelVersion("claude", { model: "x", temperature: 0.2, tools: ["a", "b"] }).version
    ).not.toBe(m.version);
    expect(canonicalJson({ b: 1, a: { d: undefined, c: 2 } })).toBe('{"a":{"c":2},"b":1}');
  });

  it("refMatches verifies a ref against content, and refuses forged ones", () => {
    const ref = promptVersion("p", "hello");
    expect(refMatches(ref, "prompt", "hello")).toBe(true);
    expect(refMatches(ref, "prompt", "hullo")).toBe(false);
    expect(refMatches(ref, "model", "hello")).toBe(false);
  });

  it("rejects unusable ids and non-canonical numbers", () => {
    expect(() => promptVersion("has space", "x")).toThrow(/id must match/);
    expect(() => promptVersion("", "x")).toThrow();
    expect(() => contentHash({ n: Number.NaN })).toThrow(/non-finite/);
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) deep = [deep];
    expect(() => contentHash(deep)).toThrow(/too deeply/);
  });
});
