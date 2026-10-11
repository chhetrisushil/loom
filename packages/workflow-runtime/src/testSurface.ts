// Test-only stand-in for `@loom/agent-surface` (ADR 0114): the kernel package no longer depends on it,
// so its own tests inject a minimal `surface` factory and fold the resulting SURFACE_PATCH events
// with a flat-path fold. The real emitter/fold, and byte-identity against it, are tested in
// `@loom/agent-surface` (`context.test.ts`).
import type { EventEnvelope } from "@loom/core";

type Emit = (eventType: string, payload: unknown) => void;
type Patch = { op: string; path: string; value?: unknown; by?: number };

export interface TestSurface {
  set(path: string, value: unknown): void;
  merge(path: string, value: unknown): void;
  append(path: string, value: unknown): void;
  remove(path: string): void;
  increment(path: string, by?: number): void;
  patch(patches: Patch[]): void;
}

/**
 * `ctx.ui` is merged into `ExecutionContext` only where `@loom/agent-surface` is in the program (ADR 0114),
 * and this package cannot depend on it. The runtime injects the accessor from `deps.surface`, so the tests
 * read it through this narrowing instead of a declaration merge.
 */
export function uiOf(ctx: object): TestSurface {
  if (!("ui" in ctx))
    throw new Error("ctx.ui missing: build the runtime with `surface: testSurface`");
  return ctx.ui as TestSurface;
}

export function testSurface(emit: Emit, surface = "ui"): TestSurface {
  const send = (patches: Patch[]): void => emit("SURFACE_PATCH", { surface, patches });
  return {
    set: (path: string, value: unknown) => send([{ op: "set", path, value }]),
    merge: (path: string, value: unknown) => send([{ op: "merge", path, value }]),
    append: (path: string, value: unknown) => send([{ op: "append", path, value }]),
    remove: (path: string) => send([{ op: "remove", path }]),
    increment: (path: string, by?: number) =>
      send([{ op: "increment", path, ...(by !== undefined && { by }) }]),
    patch: (patches: Patch[]) => send(patches),
  };
}

/** Fold SURFACE_PATCH events over top-level (single-segment) paths. */
export function foldTestSurface(events: EventEnvelope[]): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  for (const e of events) {
    if (e.eventType !== "SURFACE_PATCH") continue;
    for (const p of (e.payload as { patches: Patch[] }).patches) {
      if (p.op === "set") state[p.path] = p.value;
      else if (p.op === "append")
        state[p.path] = [...((state[p.path] as unknown[]) ?? []), p.value];
      else if (p.op === "increment")
        state[p.path] = ((state[p.path] as number | undefined) ?? 0) + (p.by ?? 1);
      else if (p.op === "remove") delete state[p.path];
      else if (p.op === "merge")
        state[p.path] = { ...((state[p.path] as object) ?? {}), ...(p.value as object) };
    }
  }
  return state;
}
