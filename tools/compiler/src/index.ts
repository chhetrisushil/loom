export { loomPlugin } from "./plugin";
export { buildManifest, printWarnings, COMPILER_MANIFEST_VERSION } from "./manifest";
export { transformFile } from "./transform";
export { shortHash, fnv1a32 } from "./hash";
export { analyzeNonDeterminism, analyzeNode } from "./nondeterminism";
export type { NonDeterministicCall } from "./nondeterminism";
export { analyzeLoopIdentity, analyzeLoopIdentityNode } from "./loopIdentity";
export type { LoopStepIdentityFinding } from "./loopIdentity";
export { analyzeReachNode, analyzeRunnerReach } from "./runnerReach";
export type {
  ReachEscape,
  RunnerReach,
  RunnerStepRef,
  RunnerSuspend,
  UnresolvedReach,
} from "./runnerReach";
export type { LoomManifest, ManifestFlow } from "./manifest";
export type { ExtractedChunk, FlowEntry, PluginState, StepEntry } from "./types";
