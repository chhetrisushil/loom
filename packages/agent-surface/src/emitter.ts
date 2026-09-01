import { DEFAULT_SURFACE, SURFACE_PATCH } from "./types";
import type { PatchProvenance, SurfacePatch } from "./types";

// The producer half of the protocol. Any context that can emit events (a
// WorkflowContext, a step's EffectContext, an agent) can drive the UI through
// this ergonomic wrapper — every method emits a single SURFACE_PATCH event.
export interface SurfaceEmitter {
  // Replace the value at `path` ("" replaces the whole surface).
  set(path: string, value: unknown): void;
  // Shallow-merge an object into the object at `path`.
  merge(path: string, value: Record<string, unknown>): void;
  // Push a value onto the array at `path` (created if absent) — ideal for
  // streaming tokens, log lines, or timeline entries.
  append(path: string, value: unknown): void;
  // Delete the key at `path`.
  remove(path: string): void;
  // Add `by` (default 1) to the number at `path`.
  increment(path: string, by?: number): void;
  // Emit an arbitrary batch of patches atomically (one event).
  patch(patches: SurfacePatch[]): void;
  /**
   * A view of this emitter that attributes its patches to `by`.
   *
   * Provenance is per-author, not per-call: an agent stamps itself once and every
   * patch it makes carries it, rather than every method growing an extra
   * argument that most callers would leave off.
   *
   *   const planner = ctx.ui.as({ by: "planner-agent", note: "model=opus-5" });
   *   planner.set("panels.why", { ... });
   */
  as(by: PatchProvenance): SurfaceEmitter;
}

type EmitFn = (eventType: string, payload: unknown) => void;

export function createSurfaceEmitter(
  emit: EmitFn,
  surface: string = DEFAULT_SURFACE,
  // Named `author` rather than `by` so it cannot be confused with `increment`'s
  // `by`, which is an amount.
  author?: PatchProvenance
): SurfaceEmitter {
  const send = (patches: SurfacePatch[]): void => {
    emit(SURFACE_PATCH, { surface, patches, ...(author !== undefined && { by: author }) });
  };
  return {
    as: (next) => createSurfaceEmitter(emit, surface, next),
    set: (path, value) => send([{ op: "set", path, value }]),
    merge: (path, value) => send([{ op: "merge", path, value }]),
    append: (path, value) => send([{ op: "append", path, value }]),
    remove: (path) => send([{ op: "remove", path }]),
    increment: (path, by) => send([{ op: "increment", path, ...(by !== undefined && { by }) }]),
    patch: (patches) => send(patches),
  };
}
