import type { ProjectionRuntime } from "@loom/projection-runtime";
import { TerminalRenderer } from "@loom/renderer-terminal";
import type { DashboardComposer } from "./composer";
import { buildCore } from "./wiring";

export interface ObservabilityApp {
  projectionRuntime: ProjectionRuntime;
  composer: DashboardComposer;
  renderer: TerminalRenderer;
  executionId: string;
}

/**
 * Terminal wiring: the surface-agnostic core (src/wiring.ts) plus a TerminalRenderer.
 * The browser UI (src/browser) reuses `buildCore` directly and renders the same
 * blueprint with React instead — one brain, two surfaces.
 */
export function buildApp(executionId = "session-1"): ObservabilityApp {
  const core = buildCore(executionId);
  const renderer = new TerminalRenderer(core.projectionRuntime);
  return { ...core, renderer };
}
