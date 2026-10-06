import type { ExecutionContext } from "@loom/workflow-runtime";
import { createSurfaceEmitter } from "./emitter";
import type { SurfaceEmitter } from "./emitter";
import { DEFAULT_SURFACE } from "./types";

// ADR 0114 — `ctx.ui` leaves the kernel. The kernel's `ExecutionContext` extends an EMPTY
// `ExecutionContextExtensions`; this package merges the UI accessor into it, so `ctx.ui`
// type-checks wherever agent-surface is in the program and nowhere else. At runtime the accessor
// comes from the injected `WorkflowRuntimeDeps.surface` factory (`defineConfig`, `@loom/testing`
// and the scaffold pass `createSurfaceEmitter`).
declare module "@loom/workflow-runtime" {
  interface ExecutionContextExtensions {
    /** Drive durable, replayable UI surfaces. Prefer `surface(ctx)`. */
    readonly ui: SurfaceEmitter;
  }
}

/**
 * The documented spelling for UI patches from a context: `surface(ctx).set(path, value)`.
 *
 * Needs only `ctx.emit`, so it works on a runtime built WITHOUT the `surface` dep, and on an
 * `EffectContext`. Every patch is a plain `emit`, so it is durable and appended once per
 * execution (ADR 0102) exactly like the injected `ctx.ui`; the events are byte-identical.
 */
export function surface(
  ctx: Pick<ExecutionContext, "emit">,
  name: string = DEFAULT_SURFACE
): SurfaceEmitter {
  return createSurfaceEmitter((eventType, payload) => ctx.emit(eventType, payload), name);
}
