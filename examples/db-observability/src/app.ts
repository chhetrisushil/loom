import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import { TerminalRenderer } from "@loom/renderer-terminal";
import { ObservabilityLlmProvider } from "./agent";
import { DashboardComposer } from "./composer";
import { TELEMETRY_PROJECTIONS, answerProjection, seedScenario } from "./telemetry";

export interface ObservabilityApp {
  projectionRuntime: ProjectionRuntime;
  composer: DashboardComposer;
  renderer: TerminalRenderer;
  executionId: string;
}

/**
 * Wire the projection runtime (telemetry + answer read-models), seed the demo
 * scenario, and build the composer + terminal renderer. Swap the provider for a live
 * model, or the renderer for @loom/renderer-react, without touching the composer.
 */
export function buildApp(executionId = "session-1"): ObservabilityApp {
  const projectionRuntime = new InMemoryProjectionRuntime();
  for (const projection of TELEMETRY_PROJECTIONS) projectionRuntime.register(projection);
  projectionRuntime.register(answerProjection);
  seedScenario(projectionRuntime, executionId);

  const composer = new DashboardComposer(
    projectionRuntime,
    new ObservabilityLlmProvider(),
    executionId
  );
  const renderer = new TerminalRenderer(projectionRuntime);
  return { projectionRuntime, composer, renderer, executionId };
}
