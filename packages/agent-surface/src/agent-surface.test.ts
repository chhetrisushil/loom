import type { EventEnvelope } from "@loom/core";
import { describe, expect, it, vi } from "vitest";
import { AgentSurfaceRuntime } from "./AgentSurfaceRuntime";
import { applySurfacePatch, applySurfacePatches } from "./applyPatch";
import { createSurfaceEmitter } from "./emitter";
import { agentSurfaceProjection } from "./surfaceProjection";
import { SURFACE_PATCH } from "./types";
import type { SurfacePatch, SurfaceState } from "./types";

// ── applySurfacePatch ────────────────────────────────────────────────────────────

describe("applySurfacePatch", () => {
  it("set writes a nested value immutably", () => {
    const before: SurfaceState = { a: { b: 1 } };
    const after = applySurfacePatch(before, { op: "set", path: "a.c", value: 2 });
    expect(after).toEqual({ a: { b: 1, c: 2 } });
    expect(before).toEqual({ a: { b: 1 } }); // unchanged
    expect(after.a).not.toBe(before.a); // cloned along path
  });

  it("set with empty path replaces the whole surface", () => {
    const after = applySurfacePatch({ a: 1 }, { op: "set", path: "", value: { x: 9 } });
    expect(after).toEqual({ x: 9 });
  });

  it("merge shallow-merges into an object", () => {
    const after = applySurfacePatch(
      { cfg: { a: 1 } },
      { op: "merge", path: "cfg", value: { b: 2 } }
    );
    expect(after).toEqual({ cfg: { a: 1, b: 2 } });
  });

  it("append creates an array then pushes", () => {
    let s: SurfaceState = {};
    s = applySurfacePatch(s, { op: "append", path: "log", value: "a" });
    s = applySurfacePatch(s, { op: "append", path: "log", value: "b" });
    expect(s).toEqual({ log: ["a", "b"] });
  });

  it("batch multi-append is correct and never mutates the input state", () => {
    const before: SurfaceState = { log: ["x"] };
    const after = applySurfacePatches(before, [
      { op: "append", path: "log", value: "a" },
      { op: "append", path: "log", value: "b" },
      { op: "append", path: "log", value: "c" },
    ]);
    expect(after).toEqual({ log: ["x", "a", "b", "c"] });
    expect(before).toEqual({ log: ["x"] }); // input untouched
    expect(after.log).not.toBe(before.log);
  });

  it("a later batch does not mutate an earlier batch's array", () => {
    const first = applySurfacePatches({}, [{ op: "append", path: "log", value: "a" }]);
    const second = applySurfacePatches(first, [{ op: "append", path: "log", value: "b" }]);
    expect(first).toEqual({ log: ["a"] }); // earlier state unchanged
    expect(second).toEqual({ log: ["a", "b"] });
    expect(second.log).not.toBe(first.log);
  });

  it("increment adds to a number (default 1, default base 0)", () => {
    let s: SurfaceState = {};
    s = applySurfacePatch(s, { op: "increment", path: "n" });
    s = applySurfacePatch(s, { op: "increment", path: "n", by: 4 });
    expect(s).toEqual({ n: 5 });
  });

  it("remove deletes a nested key", () => {
    const after = applySurfacePatch({ a: { b: 1, c: 2 } }, { op: "remove", path: "a.b" });
    expect(after).toEqual({ a: { c: 2 } });
  });

  it("ignores an unknown op (forward-compatible)", () => {
    const before = { a: 1 };
    const after = applySurfacePatch(before, {
      op: "frobnicate",
      path: "a",
    } as unknown as SurfacePatch);
    expect(after).toEqual(before);
  });

  it("applySurfacePatches folds a batch in order", () => {
    const after = applySurfacePatches({}, [
      { op: "set", path: "status", value: "running" },
      { op: "append", path: "log", value: "start" },
      { op: "increment", path: "progress", by: 10 },
    ]);
    expect(after).toEqual({ status: "running", log: ["start"], progress: 10 });
  });
});

// ── createSurfaceEmitter ─────────────────────────────────────────────────────────

describe("createSurfaceEmitter", () => {
  it("emits one SURFACE_PATCH event per call with the default surface", () => {
    const emit = vi.fn();
    const ui = createSurfaceEmitter(emit);
    ui.set("cpu", 87);
    expect(emit).toHaveBeenCalledWith(SURFACE_PATCH, {
      surface: "ui",
      patches: [{ op: "set", path: "cpu", value: 87 }],
    });
  });

  it("honors a custom surface id", () => {
    const emit = vi.fn();
    createSurfaceEmitter(emit, "sidebar").append("items", 1);
    expect(emit).toHaveBeenCalledWith(SURFACE_PATCH, {
      surface: "sidebar",
      patches: [{ op: "append", path: "items", value: 1 }],
    });
  });

  it("patch() sends an arbitrary batch atomically", () => {
    const emit = vi.fn();
    createSurfaceEmitter(emit).patch([
      { op: "set", path: "a", value: 1 },
      { op: "remove", path: "b" },
    ]);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

// ── AgentSurfaceRuntime ───────────────────────────────────────────────────────────────

function patchEvent(
  patches: SurfacePatch[],
  surface?: string,
  executionId = "exec-1"
): EventEnvelope {
  return {
    id: `${executionId}-1`,
    workflowId: "wf",
    executionId,
    eventType: SURFACE_PATCH,
    sequence: 1,
    timestamp: Date.now(),
    payload: { ...(surface !== undefined && { surface }), patches },
  };
}

describe("AgentSurfaceRuntime", () => {
  it("folds patch events into a per-execution surface", () => {
    const rt = new AgentSurfaceRuntime();
    rt.handleEvent(patchEvent([{ op: "set", path: "status", value: "ok" }]));
    rt.handleEvent(patchEvent([{ op: "increment", path: "n", by: 2 }]));
    expect(rt.getSurface("ui", "exec-1")).toEqual({ status: "ok", n: 2 });
  });

  it("keeps surfaces and executions isolated", () => {
    const rt = new AgentSurfaceRuntime();
    rt.handleEvent(patchEvent([{ op: "set", path: "x", value: 1 }], "ui", "exec-1"));
    rt.handleEvent(patchEvent([{ op: "set", path: "x", value: 2 }], "sidebar", "exec-1"));
    rt.handleEvent(patchEvent([{ op: "set", path: "x", value: 3 }], "ui", "exec-2"));
    expect(rt.getSurface("ui", "exec-1")).toEqual({ x: 1 });
    expect(rt.getSurface("sidebar", "exec-1")).toEqual({ x: 2 });
    expect(rt.getSurface("ui", "exec-2")).toEqual({ x: 3 });
  });

  it("notifies subscribers on change", () => {
    const rt = new AgentSurfaceRuntime();
    const seen: SurfaceState[] = [];
    rt.subscribe("ui", "exec-1", (s) => seen.push(s));
    rt.handleEvent(patchEvent([{ op: "set", path: "a", value: 1 }]));
    expect(seen).toEqual([{ a: 1 }]);
  });

  it("ignores non-surface events", () => {
    const rt = new AgentSurfaceRuntime();
    rt.handleEvent({ ...patchEvent([]), eventType: "STEP_COMPLETED" });
    expect(rt.getSurface("ui", "exec-1")).toEqual({});
  });
});

// ── agentSurfaceProjection ─────────────────────────────────────────────────────

describe("agentSurfaceProjection", () => {
  it("produces a projection whose id is the surface id", () => {
    expect(agentSurfaceProjection().id).toBe("ui");
    expect(agentSurfaceProjection("sidebar").id).toBe("sidebar");
  });

  it("its SURFACE_PATCH handler folds matching-surface patches", () => {
    const proj = agentSurfaceProjection("ui");
    const handler = proj.handlers[SURFACE_PATCH]!;
    const next = handler({}, patchEvent([{ op: "set", path: "a", value: 1 }], "ui"));
    expect(next).toEqual({ a: 1 });
  });

  it("ignores patches for other surfaces", () => {
    const proj = agentSurfaceProjection("ui");
    const handler = proj.handlers[SURFACE_PATCH]!;
    const next = handler({ a: 0 }, patchEvent([{ op: "set", path: "a", value: 1 }], "sidebar"));
    expect(next).toEqual({ a: 0 });
  });
});

describe("agentSurfaceProjection — egress redaction (K10-R6)", () => {
  function patchEvent(patches: SurfacePatch[]): EventEnvelope {
    return {
      id: "e1",
      workflowId: "wf",
      executionId: "x1",
      eventType: SURFACE_PATCH,
      sequence: 0,
      timestamp: 1,
      payload: { patches },
    };
  }

  it("masks declared surface paths before they reach the folded state", () => {
    const proj = agentSurfaceProjection("ui", { redact: ["user.ssn"] });
    const state = proj.handlers[SURFACE_PATCH]!(
      {},
      patchEvent([{ op: "set", path: "user", value: { name: "Ann", ssn: "123-45-6789" } }])
    );
    expect(state).toEqual({ user: { name: "Ann", ssn: "[redacted]" } });
  });

  it("stays masked across successive folds (idempotent) and leaves unmarked paths intact", () => {
    const proj = agentSurfaceProjection("ui", { redact: ["token"] });
    let state = proj.handlers[SURFACE_PATCH]!(
      {},
      patchEvent([{ op: "set", path: "token", value: "sk_1" }])
    );
    state = proj.handlers[SURFACE_PATCH]!(
      state,
      patchEvent([{ op: "set", path: "label", value: "ok" }])
    );
    expect(state).toEqual({ token: "[redacted]", label: "ok" });
  });

  it("with no redact option is an unchanged pass-through (G2)", () => {
    const proj = agentSurfaceProjection("ui");
    const state = proj.handlers[SURFACE_PATCH]!(
      {},
      patchEvent([{ op: "set", path: "a", value: 1 }])
    );
    expect(state).toEqual({ a: 1 });
  });
});
