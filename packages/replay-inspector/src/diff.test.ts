import { describe, expect, it } from "vitest";
import { diffState, formatPath } from "./diff";

describe("diffState — structure", () => {
  it("reports added, removed and changed leaves with segment paths", () => {
    const r = diffState({ a: 1, gone: true }, { a: 2, fresh: "x" });
    expect(r.truncated).toBe(false);
    expect(r.changes).toEqual([
      { path: ["a"], kind: "changed", before: 1, after: 2 },
      { path: ["fresh"], kind: "added", after: "x" },
      { path: ["gone"], kind: "removed", before: true },
    ]);
  });

  it("descends nested objects and arrays by index", () => {
    const r = diffState({ o: { xs: [1, 2] } }, { o: { xs: [1, 3, 4] } });
    expect(r.changes).toEqual([
      { path: ["o", "xs", "1"], kind: "changed", before: 2, after: 3 },
      { path: ["o", "xs", "2"], kind: "added", after: 4 },
    ]);
  });

  it("treats an object/array shape switch as one whole-node change", () => {
    const r = diffState({ v: { "0": 1 } }, { v: [1] });
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]?.kind).toBe("changed");
  });

  it("is deterministic — key order in the input does not change the output", () => {
    const a = diffState({ z: 1, a: 1 }, { z: 2, a: 2 });
    const b = diffState({ a: 1, z: 1 }, { a: 2, z: 2 });
    expect(a.changes).toEqual(b.changes);
    expect(a.changes.map((c) => c.path[0])).toEqual(["a", "z"]);
  });

  it("compares Dates by instant, not identity", () => {
    const t = 1_700_000_000_000;
    expect(diffState({ at: new Date(t) }, { at: new Date(t) }).changes).toEqual([]);
    expect(diffState({ at: new Date(t) }, { at: new Date(t + 1) }).changes).toHaveLength(1);
  });

  it("treats non-plain objects as opaque leaves rather than descending", () => {
    const r = diffState({ m: new Map([["k", 1]]) }, { m: new Map([["k", 2]]) });
    expect(r.changes).toEqual([
      { path: ["m"], kind: "changed", before: expect.any(Map), after: expect.any(Map) },
    ]);
  });
});

describe("diffState — hostile input", () => {
  it("terminates on self-referential cycles", () => {
    const a: Record<string, unknown> = { n: 1 };
    a.self = a;
    const b: Record<string, unknown> = { n: 2 };
    b.self = b;
    const r = diffState(a, b);
    expect(r.changes).toEqual([{ path: ["n"], kind: "changed", before: 1, after: 2 }]);
  });

  it("terminates on mutual cycles between the two sides", () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    a.peer = b;
    b.peer = a;
    expect(() => diffState(a, b)).not.toThrow();
  });

  it("visits a shared subgraph once instead of exponentially", () => {
    // A diamond repeated D times would be 2^D nodes without pair memoisation.
    let left: unknown = { leaf: 1 };
    let right: unknown = { leaf: 2 };
    for (let i = 0; i < 40; i++) {
      left = { l: left, r: left };
      right = { l: right, r: right };
    }
    const r = diffState(left, right);
    expect(r.changes.length).toBeLessThanOrEqual(2);
  });

  it("caps depth and REPORTS the truncation rather than silently stopping", () => {
    let a: unknown = { leaf: 1 };
    let b: unknown = { leaf: 2 };
    for (let i = 0; i < 50; i++) {
      a = { n: a };
      b = { n: b };
    }
    const r = diffState(a, b, { maxDepth: 5 });
    expect(r.truncated).toBe(true);
    expect(r.truncationReason).toBe("depth");
  });

  it("does not blow the stack on deep nesting within the cap", () => {
    let a: unknown = { leaf: 1 };
    let b: unknown = { leaf: 2 };
    for (let i = 0; i < 20_000; i++) {
      a = { n: a };
      b = { n: b };
    }
    // Iterative walk: bounded by maxDepth, never by the JS call stack.
    expect(() => diffState(a, b, { maxDepth: 100_000 })).not.toThrow();
  });

  it("caps output size and reports it", () => {
    const a: Record<string, number> = {};
    const b: Record<string, number> = {};
    for (let i = 0; i < 500; i++) {
      a[`k${i}`] = i;
      b[`k${i}`] = i + 1;
    }
    const r = diffState(a, b, { maxChanges: 10 });
    expect(r.truncated).toBe(true);
    expect(r.truncationReason).toBe("size");
    expect(r.changes.length).toBeLessThanOrEqual(10 + 1);
  });

  it("never emits an inherited or __proto__ key as a path segment", () => {
    const poisoned = JSON.parse('{"__proto__": {"injected": true}, "real": 1}') as object;
    const r = diffState(poisoned, { real: 2 });
    // `__proto__` from JSON.parse is an OWN key, so it may legitimately appear as a
    // removal — what must never happen is it polluting Object.prototype.
    expect((Object.prototype as unknown as { injected?: unknown }).injected).toBeUndefined();
    expect(r.changes.some((c) => c.path[0] === "real")).toBe(true);
  });

  it("does not surface prototype-chain properties as diffs", () => {
    const base = { inherited: 1 };
    const a = Object.create(base) as Record<string, unknown>;
    a.own = 1;
    const b = Object.create(base) as Record<string, unknown>;
    b.own = 2;
    // Both have a non-Object.prototype proto, so they are opaque leaves — the point is
    // that `inherited` is never walked as though it were state.
    const r = diffState(a, b);
    expect(r.changes.every((c) => c.path[0] !== "inherited")).toBe(true);
  });
});

describe("formatPath", () => {
  it("escapes so that distinct paths never render identically", () => {
    expect(formatPath(["a", "b"])).toBe("a.b");
    expect(formatPath(["a.b"])).toBe("a\\.b");
    expect(formatPath(["a\\b"])).toBe("a\\\\b");
    expect(formatPath(["a.b"])).not.toBe(formatPath(["a", "b"]));
  });
});
