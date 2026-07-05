import type { EventEnvelope } from "@loom/core";
import { describe, expect, it, vi } from "vitest";
import { A2UIRuntime } from "./A2UIRuntime";
import { applyA2UIPatch, applyA2UIPatches } from "./applyPatch";
import { createA2UIEmitter } from "./emitter";
import { a2uiSurfaceProjection } from "./surfaceProjection";
import { A2UI_PATCH } from "./types";
import type { A2UIPatch, A2UISurfaceState } from "./types";

// ── applyA2UIPatch ────────────────────────────────────────────────────────────

describe("applyA2UIPatch", () => {
  it("set writes a nested value immutably", () => {
    const before: A2UISurfaceState = { a: { b: 1 } };
    const after = applyA2UIPatch(before, { op: "set", path: "a.c", value: 2 });
    expect(after).toEqual({ a: { b: 1, c: 2 } });
    expect(before).toEqual({ a: { b: 1 } }); // unchanged
    expect(after.a).not.toBe(before.a); // cloned along path
  });

  it("set with empty path replaces the whole surface", () => {
    const after = applyA2UIPatch({ a: 1 }, { op: "set", path: "", value: { x: 9 } });
    expect(after).toEqual({ x: 9 });
  });

  it("merge shallow-merges into an object", () => {
    const after = applyA2UIPatch({ cfg: { a: 1 } }, { op: "merge", path: "cfg", value: { b: 2 } });
    expect(after).toEqual({ cfg: { a: 1, b: 2 } });
  });

  it("append creates an array then pushes", () => {
    let s: A2UISurfaceState = {};
    s = applyA2UIPatch(s, { op: "append", path: "log", value: "a" });
    s = applyA2UIPatch(s, { op: "append", path: "log", value: "b" });
    expect(s).toEqual({ log: ["a", "b"] });
  });

  it("increment adds to a number (default 1, default base 0)", () => {
    let s: A2UISurfaceState = {};
    s = applyA2UIPatch(s, { op: "increment", path: "n" });
    s = applyA2UIPatch(s, { op: "increment", path: "n", by: 4 });
    expect(s).toEqual({ n: 5 });
  });

  it("remove deletes a nested key", () => {
    const after = applyA2UIPatch({ a: { b: 1, c: 2 } }, { op: "remove", path: "a.b" });
    expect(after).toEqual({ a: { c: 2 } });
  });

  it("ignores an unknown op (forward-compatible)", () => {
    const before = { a: 1 };
    const after = applyA2UIPatch(before, { op: "frobnicate", path: "a" } as unknown as A2UIPatch);
    expect(after).toEqual(before);
  });

  it("applyA2UIPatches folds a batch in order", () => {
    const after = applyA2UIPatches({}, [
      { op: "set", path: "status", value: "running" },
      { op: "append", path: "log", value: "start" },
      { op: "increment", path: "progress", by: 10 },
    ]);
    expect(after).toEqual({ status: "running", log: ["start"], progress: 10 });
  });
});

// ── createA2UIEmitter ─────────────────────────────────────────────────────────

describe("createA2UIEmitter", () => {
  it("emits one A2UI_PATCH event per call with the default surface", () => {
    const emit = vi.fn();
    const ui = createA2UIEmitter(emit);
    ui.set("cpu", 87);
    expect(emit).toHaveBeenCalledWith(A2UI_PATCH, {
      surface: "ui",
      patches: [{ op: "set", path: "cpu", value: 87 }],
    });
  });

  it("honors a custom surface id", () => {
    const emit = vi.fn();
    createA2UIEmitter(emit, "sidebar").append("items", 1);
    expect(emit).toHaveBeenCalledWith(A2UI_PATCH, {
      surface: "sidebar",
      patches: [{ op: "append", path: "items", value: 1 }],
    });
  });

  it("patch() sends an arbitrary batch atomically", () => {
    const emit = vi.fn();
    createA2UIEmitter(emit).patch([
      { op: "set", path: "a", value: 1 },
      { op: "remove", path: "b" },
    ]);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

// ── A2UIRuntime ───────────────────────────────────────────────────────────────

function patchEvent(patches: A2UIPatch[], surface?: string, executionId = "exec-1"): EventEnvelope {
  return {
    id: `${executionId}-1`,
    workflowId: "wf",
    executionId,
    eventType: A2UI_PATCH,
    sequence: 1,
    timestamp: Date.now(),
    payload: { ...(surface !== undefined && { surface }), patches },
  };
}

describe("A2UIRuntime", () => {
  it("folds patch events into a per-execution surface", () => {
    const rt = new A2UIRuntime();
    rt.handleEvent(patchEvent([{ op: "set", path: "status", value: "ok" }]));
    rt.handleEvent(patchEvent([{ op: "increment", path: "n", by: 2 }]));
    expect(rt.getSurface("ui", "exec-1")).toEqual({ status: "ok", n: 2 });
  });

  it("keeps surfaces and executions isolated", () => {
    const rt = new A2UIRuntime();
    rt.handleEvent(patchEvent([{ op: "set", path: "x", value: 1 }], "ui", "exec-1"));
    rt.handleEvent(patchEvent([{ op: "set", path: "x", value: 2 }], "sidebar", "exec-1"));
    rt.handleEvent(patchEvent([{ op: "set", path: "x", value: 3 }], "ui", "exec-2"));
    expect(rt.getSurface("ui", "exec-1")).toEqual({ x: 1 });
    expect(rt.getSurface("sidebar", "exec-1")).toEqual({ x: 2 });
    expect(rt.getSurface("ui", "exec-2")).toEqual({ x: 3 });
  });

  it("notifies subscribers on change", () => {
    const rt = new A2UIRuntime();
    const seen: A2UISurfaceState[] = [];
    rt.subscribe("ui", "exec-1", (s) => seen.push(s));
    rt.handleEvent(patchEvent([{ op: "set", path: "a", value: 1 }]));
    expect(seen).toEqual([{ a: 1 }]);
  });

  it("ignores non-A2UI events", () => {
    const rt = new A2UIRuntime();
    rt.handleEvent({ ...patchEvent([]), eventType: "STEP_COMPLETED" });
    expect(rt.getSurface("ui", "exec-1")).toEqual({});
  });
});

// ── a2uiSurfaceProjection ─────────────────────────────────────────────────────

describe("a2uiSurfaceProjection", () => {
  it("produces a projection whose id is the surface id", () => {
    expect(a2uiSurfaceProjection().id).toBe("ui");
    expect(a2uiSurfaceProjection("sidebar").id).toBe("sidebar");
  });

  it("its A2UI_PATCH handler folds matching-surface patches", () => {
    const proj = a2uiSurfaceProjection("ui");
    const handler = proj.handlers[A2UI_PATCH]!;
    const next = handler({}, patchEvent([{ op: "set", path: "a", value: 1 }], "ui"));
    expect(next).toEqual({ a: 1 });
  });

  it("ignores patches for other surfaces", () => {
    const proj = a2uiSurfaceProjection("ui");
    const handler = proj.handlers[A2UI_PATCH]!;
    const next = handler({ a: 0 }, patchEvent([{ op: "set", path: "a", value: 1 }], "sidebar"));
    expect(next).toEqual({ a: 0 });
  });
});
