export type { FlowTelemetryInfo, StepTelemetryInfo, TelemetryAdapter } from "./types";
export { createTelemetryHook } from "./createTelemetryHook";
export { ConsoleTelemetryAdapter } from "./adapters/ConsoleTelemetryAdapter";

import type { TelemetryAdapter } from "./types";

export function composeAdapters(...adapters: TelemetryAdapter[]): TelemetryAdapter {
  return {
    onFlowStart:    (info) => adapters.forEach((a) => a.onFlowStart?.(info)),
    onFlowComplete: (info) => adapters.forEach((a) => a.onFlowComplete?.(info)),
    onFlowFail:     (info) => adapters.forEach((a) => a.onFlowFail?.(info)),
    onFlowSuspend:  (info) => adapters.forEach((a) => a.onFlowSuspend?.(info)),
    onFlowResume:   (info) => adapters.forEach((a) => a.onFlowResume?.(info)),
    onStepStart:    (info) => adapters.forEach((a) => a.onStepStart?.(info)),
    onStepComplete: (info) => adapters.forEach((a) => a.onStepComplete?.(info)),
    onStepFail:     (info) => adapters.forEach((a) => a.onStepFail?.(info)),
    onStepRetry:    (info) => adapters.forEach((a) => a.onStepRetry?.(info)),
  };
}
