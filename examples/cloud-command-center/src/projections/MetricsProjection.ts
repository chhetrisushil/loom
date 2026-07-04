import type { EventEnvelope } from "@loom/core";

export interface MetricsState {
  cpu: { current: number; threshold: number };
  memory: { usedMb: number; totalMb: number };
  connections: { active: number; max: number };
  lastUpdated: number;
}

const initialState: MetricsState = {
  cpu: { current: 0, threshold: 80 },
  memory: { usedMb: 0, totalMb: 0 },
  connections: { active: 0, max: 0 },
  lastUpdated: 0,
};

export const MetricsProjection = {
  id: "metrics",
  initialState,
  handlers: {
    STEP_COMPLETED: (state: MetricsState, event: EventEnvelope): MetricsState => {
      const payload = event.payload as { stepId?: string; output?: MetricsState };
      if (payload.stepId === "fetch-metrics" && payload.output) {
        return { ...payload.output, lastUpdated: event.timestamp };
      }
      return state;
    },
  },
};
