import { A2UI_PATCH, DEFAULT_SURFACE } from "./types";
import type { A2UIPatch } from "./types";

// The producer half of the protocol. Any context that can emit events (a
// WorkflowContext, a step's EffectContext, an agent) can drive the UI through
// this ergonomic wrapper — every method emits a single A2UI_PATCH event.
export interface A2UIEmitter {
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
  patch(patches: A2UIPatch[]): void;
}

type EmitFn = (eventType: string, payload: unknown) => void;

export function createA2UIEmitter(emit: EmitFn, surface: string = DEFAULT_SURFACE): A2UIEmitter {
  const send = (patches: A2UIPatch[]): void => {
    emit(A2UI_PATCH, { surface, patches });
  };
  return {
    set: (path, value) => send([{ op: "set", path, value }]),
    merge: (path, value) => send([{ op: "merge", path, value }]),
    append: (path, value) => send([{ op: "append", path, value }]),
    remove: (path) => send([{ op: "remove", path }]),
    increment: (path, by) => send([{ op: "increment", path, ...(by !== undefined && { by }) }]),
    patch: (patches) => send(patches),
  };
}
