import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { createSurfaceEmitter } from "./emitter";
import { provenanceOf, surfaceProvenanceProjection } from "./provenance";
import type { ProvenanceState } from "./provenance";
import { SURFACE_PATCH } from "./types";

/** A projection's handler table; one built without it is a failure of the fixture, not a skip. */
function handlersOf<H>(projection: { handlers?: H }): H {
  if (projection.handlers === undefined) throw new Error("the projection declares no handlers");
  return projection.handlers;
}

const event = (seq: number, payload: unknown): EventEnvelope => ({
  id: `e${seq}`,
  workflowId: "wf",
  executionId: "exec-1",
  eventType: SURFACE_PATCH,
  sequence: seq,
  timestamp: seq,
  payload,
});

function fold(events: EventEnvelope[], surface = "ui"): ProvenanceState {
  const projection = surfaceProvenanceProjection(surface);
  let state = projection.initialState;
  for (const e of events) {
    const handler = handlersOf(projection)[e.eventType];
    if (handler) state = handler(state, e);
  }
  return state;
}

describe("surfaceProvenanceProjection", () => {
  it('answers "who last wrote this path"', () => {
    const state = fold([
      event(1, {
        surface: "ui",
        patches: [{ op: "set", path: "panels.what", value: 1 }],
        by: { by: "planner-agent", note: "model=opus-5" },
      }),
      event(2, {
        surface: "ui",
        patches: [{ op: "set", path: "panels.what", value: 2 }],
        by: { by: "operator:ana" },
      }),
    ]);

    expect(state["panels.what"]).toEqual({ by: "operator:ana", sequence: 2, op: "set" });
  });

  it("records nothing for an unattributed patch, rather than inventing an author", () => {
    const state = fold([
      event(1, { surface: "ui", patches: [{ op: "set", path: "a", value: 1 }] }),
    ]);
    expect(state).toEqual({});
  });

  it("ignores patches addressed to another surface", () => {
    const state = fold([
      event(1, {
        surface: "sidebar",
        patches: [{ op: "set", path: "a", value: 1 }],
        by: { by: "agent" },
      }),
    ]);
    expect(state).toEqual({});
  });

  it("attributes every path in a batch to the batch's author", () => {
    const state = fold([
      event(1, {
        surface: "ui",
        patches: [
          { op: "set", path: "a", value: 1 },
          { op: "append", path: "log", value: "x" },
        ],
        by: { by: "agent" },
      }),
    ]);
    expect(Object.keys(state).sort()).toEqual(["a", "log"]);
    expect(state.log?.op).toBe("append");
  });
});

describe("provenanceOf", () => {
  const state = fold([
    event(1, {
      surface: "ui",
      patches: [{ op: "set", path: "panels.why", value: { chart: {} } }],
      by: { by: "planner-agent" },
    }),
  ]);

  it("returns the exact entry when the path was written directly", () => {
    expect(provenanceOf(state, "panels.why")?.by).toBe("planner-agent");
  });

  it("falls back to the nearest ancestor that was actually placed", () => {
    // A composer that sets a whole panel in one patch records provenance for the
    // panel, not for every leaf inside it. Asking who placed a leaf has to walk
    // up to the placement that actually happened.
    expect(provenanceOf(state, "panels.why.chart.series")?.by).toBe("planner-agent");
  });

  it("returns undefined when nothing on the path was attributed", () => {
    expect(provenanceOf(state, "panels.what")).toBeUndefined();
  });

  it("finds a root placement for any path", () => {
    const rooted = fold([
      event(1, {
        surface: "ui",
        patches: [{ op: "set", path: "", value: {} }],
        by: { by: "boot" },
      }),
    ]);
    expect(provenanceOf(rooted, "a.b.c")?.by).toBe("boot");
  });
});

describe("createSurfaceEmitter — attribution", () => {
  it("stamps every patch from an attributed emitter, and none from a bare one", () => {
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const emit = (type: string, payload: unknown) =>
      emitted.push({ type, payload: payload as Record<string, unknown> });

    const bare = createSurfaceEmitter(emit);
    bare.set("a", 1);
    expect(emitted[0]?.payload.by).toBeUndefined();

    const planner = bare.as({ by: "planner-agent", note: "model=opus-5" });
    planner.append("log", "x");
    expect(emitted[1]?.payload.by).toEqual({ by: "planner-agent", note: "model=opus-5" });

    // `as` returns a view; the original stays unattributed.
    bare.set("b", 2);
    expect(emitted[2]?.payload.by).toBeUndefined();
  });

  it("does not confuse increment's `by` amount with the author", () => {
    const emitted: Array<Record<string, unknown>> = [];
    const emitter = createSurfaceEmitter(
      (_t, p) => emitted.push(p as Record<string, unknown>),
      "ui"
    ).as({ by: "agent" });

    emitter.increment("count", 5);
    expect(emitted[0]?.by).toEqual({ by: "agent" });
    expect((emitted[0]?.patches as Array<{ by?: number }>)[0]?.by).toBe(5);
  });
});
