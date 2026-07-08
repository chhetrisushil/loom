import type { ExecutionPolicy } from "@loom/core";
import type { DispatchMetadata, PlacementPolicy } from "./types";

// Map the out-of-core ExecutionPolicy (the Loom 2.0 PCB sidecar) onto the advisory
// DispatchMetadata the compute layer already understands. This is the seam by which
// a flow's declared placement/priority/resources drive WHERE it runs — without the
// kernel ever depending on the compute layer (P10).
export function dispatchMetadataFromPolicy(policy: ExecutionPolicy): DispatchMetadata {
  return {
    ...(policy.computeTarget !== undefined && { target: policy.computeTarget }),
    ...(policy.priority !== undefined && { priority: policy.priority }),
    ...(policy.affinity !== undefined && { lane: policy.affinity }),
    ...(policy.resources?.cpu !== undefined && { estimatedCpu: policy.resources.cpu }),
    ...(policy.resources?.memoryMb !== undefined && { estimatedMemory: policy.resources.memoryMb }),
  };
}

// Default placement: honour an explicit `meta.target` when it names a registered
// target, otherwise fall through to the dispatcher's default. Deterministic and
// dependency-free — the advisory plane never affects correctness (P10), only WHERE.
export function defaultPlacementPolicy(defaultTarget: string): PlacementPolicy {
  return (_pkg, meta, targets) => {
    if (meta?.target !== undefined && targets.includes(meta.target)) return meta.target;
    return defaultTarget;
  };
}
