import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { AgentSurfaceRuntime } from "./AgentSurfaceRuntime";
import { applySurfacePatch, applySurfacePatches } from "./applyPatch";
import { SURFACE_PATCH } from "./types";

const patchEvent = (executionId: string, patches: unknown[]): EventEnvelope => ({
  id: `${executionId}-0`,
  workflowId: "wf",
  executionId,
  eventType: SURFACE_PATCH,
  sequence: 0,
  timestamp: 1,
  payload: { surface: "main", patches },
});

describe("applySurfacePatch — reserved keys (prototype safety)", () => {
  it("ignores a patch whose path names __proto__", () => {
    const before = Object.getPrototypeOf({});
    const state = applySurfacePatch({ ok: 1 }, {
      op: "set",
      path: "__proto__.polluted",
      value: "yes",
    } as never);
    // The patch is dropped whole — the state is untouched and nothing is re-parented.
    expect(state).toEqual({ ok: 1 });
    expect(Object.getPrototypeOf(state)).toBe(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("ignores constructor and prototype segments too, at any depth", () => {
    for (const path of ["constructor.x", "prototype.x", "a.__proto__.b", "a.b.constructor"]) {
      const state = applySurfacePatch({ keep: true }, { op: "set", path, value: 1 } as never);
      expect(state).toEqual({ keep: true });
    }
  });

  it("does not re-parent the state object via a merge or append", () => {
    const merged = applySurfacePatch({}, {
      op: "merge",
      path: "__proto__",
      value: { evil: 1 },
    } as never);
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect((merged as Record<string, unknown>).evil).toBeUndefined();
  });

  it("still applies ordinary paths, including ones merely containing the substring", () => {
    const s1 = applySurfacePatches({}, [
      { op: "set", path: "a.b", value: 1 },
      { op: "increment", path: "n", by: 2 },
      { op: "append", path: "list", value: "x" },
    ] as never);
    expect(s1).toEqual({ a: { b: 1 }, n: 2, list: ["x"] });
    // "prototypes" is not "prototype" — the guard is exact-segment, not substring.
    const s2 = applySurfacePatch({}, { op: "set", path: "prototypes.x", value: 1 } as never);
    expect(s2).toEqual({ prototypes: { x: 1 } });
  });
});

describe("AgentSurfaceRuntime — bounded retention", () => {
  it("does not grow without bound as executions come and go", () => {
    const rt = new AgentSurfaceRuntime({ maxSurfaces: 50 });
    for (let i = 0; i < 500; i++) {
      rt.handleEvent(patchEvent(`exec-${i}`, [{ op: "set", path: "n", value: i }]));
    }
    expect(rt.retained).toBeLessThanOrEqual(50);
  });

  it("never evicts a surface someone is subscribed to", () => {
    const rt = new AgentSurfaceRuntime({ maxSurfaces: 10 });
    const seen: unknown[] = [];
    rt.subscribe("main", "watched", (s) => seen.push(s));
    rt.handleEvent(patchEvent("watched", [{ op: "set", path: "n", value: 1 }]));
    // Flood well past the cap.
    for (let i = 0; i < 200; i++) {
      rt.handleEvent(patchEvent(`other-${i}`, [{ op: "set", path: "n", value: i }]));
    }
    // The watched surface is an incremental fold; evicting it would silently reset it.
    expect(rt.getSurface("main", "watched")).toEqual({ n: 1 });
    rt.handleEvent(patchEvent("watched", [{ op: "increment", path: "n", by: 5 }]));
    expect(rt.getSurface("main", "watched")).toEqual({ n: 6 });
    expect(seen.length).toBe(2);
  });

  it("forgetExecution drops every surface for that execution", () => {
    const rt = new AgentSurfaceRuntime();
    rt.handleEvent(patchEvent("e1", [{ op: "set", path: "n", value: 1 }]));
    rt.seed("other", "e1", { k: 1 });
    rt.handleEvent(patchEvent("e2", [{ op: "set", path: "n", value: 2 }]));
    expect(rt.retained).toBe(3);
    expect(rt.forgetExecution("e1")).toBe(2);
    expect(rt.retained).toBe(1);
    expect(rt.getSurface("main", "e1")).toEqual({});
    expect(rt.getSurface("main", "e2")).toEqual({ n: 2 });
  });
});
