import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import { ObservabilityLlmProvider } from "./agent";
import { DashboardComposer } from "./composer";
import { TELEMETRY_PROJECTIONS, answerProjection, seedScenario } from "./telemetry";

export interface ObservabilityCore {
  projectionRuntime: ProjectionRuntime;
  composer: DashboardComposer;
  executionId: string;
}

/**
 * The surface-agnostic core: the projection runtime (telemetry + answer read-models),
 * the seeded scenario, and the composer. Shared by BOTH the terminal CLI (src/app.ts,
 * which adds a TerminalRenderer) and the browser UI (src/browser, which renders the
 * same blueprint with React). Intentionally free of any renderer import so the browser
 * bundle never pulls in the Node-only terminal renderer.
 */
export function buildCore(executionId = "session-1"): ObservabilityCore {
  const projectionRuntime = new InMemoryProjectionRuntime();
  for (const projection of TELEMETRY_PROJECTIONS) projectionRuntime.register(projection);
  projectionRuntime.register(answerProjection);
  seedScenario(projectionRuntime, executionId);

  const composer = new DashboardComposer(
    projectionRuntime,
    new ObservabilityLlmProvider(),
    executionId
  );
  return { projectionRuntime, composer, executionId };
}
