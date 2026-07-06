import type { DispatchMetadata } from "@loom/dispatcher";
import type { CloudRunConfig, SizingPolicy } from "./types";

/**
 * Default sizing: honor explicit estimates when present, else infer from the
 * lane. Mirrors the plan's example — heavy LLM planning → 4 vCPU / 8 GiB, small
 * projection → 1 vCPU / 512 MiB.
 */
export const defaultSizingPolicy: SizingPolicy = (meta?: DispatchMetadata): CloudRunConfig => {
  const heavyLane = meta?.lane === "planning" || meta?.lane === "heavy";
  const cpu = meta?.estimatedCpu ?? (heavyLane ? 4 : 1);
  const memoryMb =
    meta?.estimatedMemory ?? (cpu >= 4 ? 8192 : cpu >= 2 ? 2048 : heavyLane ? 2048 : 512);
  return { cpu, memoryMb };
};
