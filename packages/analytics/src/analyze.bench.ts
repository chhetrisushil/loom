import type { EventEnvelope } from "@loom/core";
import { bench, describe } from "vitest";
import {
  analyze,
  costAnalytics,
  executionAnalytics,
  failureAnalytics,
  reasoningAnalytics,
} from "./analyze";
import { runtimeIntelligence } from "./intelligence";

// Guardrail bench: `analyze`/`runtimeIntelligence` fold the log in ONE pass. The
// baselines below reproduce the previous shape — four independent lens passes (and a
// fifth for hotFailures) over the same events — so the single-pass win is visible.

const TYPES = [
  "STEP_STARTED",
  "STEP_COMPLETED",
  "STEP_FAILED",
  "DECISION_RECORDED",
  "RESOURCE_METERED",
  "EFFECT_DENIED",
];

function makeLog(n: number): EventEnvelope[] {
  const events: EventEnvelope[] = [];
  for (let i = 0; i < n; i++) {
    const eventType = TYPES[i % TYPES.length] as string;
    const payload =
      eventType === "DECISION_RECORDED"
        ? {
            decisionId: i % 7 === 0 ? "reason:elevate:1" : "reason:route",
            choice: `m${i % 5}`,
            source: "reasoning",
          }
        : eventType === "RESOURCE_METERED"
          ? { tokens: 10, costUsd: 0.01, ms: 5 }
          : eventType === "STEP_FAILED"
            ? { stepId: `step-${i % 20}` }
            : eventType === "EFFECT_DENIED"
              ? { toolId: `tool-${i % 8}` }
              : { stepId: `step-${i % 20}` };
    events.push({
      id: `e-${i}`,
      workflowId: "wf",
      executionId: "x",
      eventType,
      sequence: i,
      timestamp: i,
      payload,
    });
  }
  return events;
}

// Previous shape: four independent passes (what `analyze` used to do).
function analyzeFourPass(events: EventEnvelope[]) {
  return {
    execution: executionAnalytics(events),
    cost: costAnalytics(events),
    reasoning: reasoningAnalytics(events),
    failure: failureAnalytics(events),
  };
}

const log = makeLog(50_000);

describe("analyze over 50k events", () => {
  bench("four-pass baseline (previous shape)", () => {
    analyzeFourPass(log);
  });

  bench("analyze (single pass)", () => {
    analyze(log);
  });
});

describe("runtimeIntelligence over 50k events", () => {
  // Baseline reproduces the old extra hotFailures pass over the raw log.
  bench("analyze + separate failure pass (previous shape)", () => {
    const a = analyzeFourPass(log);
    const counts = new Map<string, number>();
    for (const s of a.failure.failedSteps) counts.set(s, (counts.get(s) ?? 0) + 1);
    [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5);
  });

  bench("runtimeIntelligence (single pass, reused failedSteps)", () => {
    runtimeIntelligence(log);
  });
});
