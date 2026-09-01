export { SURFACE_PATCH, DEFAULT_SURFACE } from "./types";
export type {
  SurfacePatch,
  SurfacePatchPayload,
  SurfaceState,
  PatchProvenance,
} from "./types";
export { applySurfacePatch, applySurfacePatches, getSurfaceValue } from "./applyPatch";
export { createSurfaceEmitter } from "./emitter";
export type { SurfaceEmitter } from "./emitter";
export { AgentSurfaceRuntime } from "./AgentSurfaceRuntime";
export {
  agentSurfaceProjection,
  type SurfaceProjectionOptions,
} from "./surfaceProjection";
export { surfaceProvenanceProjection, provenanceOf } from "./provenance";
export type { PathProvenance, ProvenanceState } from "./provenance";
