export interface ExtractedChunk {
  // The owning construct's id — a step id (kind "step"), skill id ("skill"), or
  // projection id ("projection").
  stepId: string;
  kind: "step" | "skill" | "projection";
  chunkVirtualId: string;
  chunkSource: string;
  sourceFile: string;
  hash: string;
}

export interface SkillEntry {
  id: string;
  varName: string;
  chunkVirtualId?: string;
  hash?: string;
  sourceFile: string;
}

export interface ProjectionEntry {
  id: string;
  varName: string;
  /** The event-type keys the projection folds — read statically from the handlers object. */
  eventTypes: string[];
  chunkVirtualId?: string;
  hash?: string;
  sourceFile: string;
}

export interface FlowEntry {
  id: string;
  version: string;
  stepIds: string[];
  suspendPoints: string[];
  sourceFile: string;
  /**
   * ADR 0061 — loop step-identity findings from `analyzeLoopIdentity` over the
   * flow-declaring module (surfaced as manifest warnings and consumable by
   * `@loom/verify` via `FlowSpec.loopIdentityCalls`).
   */
  loopIdentityFindings?: import("./loopIdentity").LoopStepIdentityFinding[];
  /**
   * Issue #82 — non-deterministic calls reachable outside a `ctx.decide`/
   * `ctx.execute` boundary, from `analyzeNonDeterminism` over the flow-declaring
   * module. Consumed by `@loom/verify` via `FlowSpec.nonDeterministicCalls`.
   *
   * Emitted here for the same reason `loopIdentityFindings` is: the analysis
   * needs the runner SOURCE, the compiler is the only thing that has it, and
   * asking an application to read its own files to feed a linter is a wiring
   * step nobody performs.
   */
  nonDeterministicCalls?: import("./nondeterminism").NonDeterministicCall[];
  /**
   * ADR 0086 — runner-body reach: `ctx.run` targets and `ctx.suspend`
   * conditions, plus what could not be resolved. Consumed by `@loom/verify` via
   * `FlowSpec.effects` / `suspends` / `unresolvedReach`.
   */
  runnerReach?: import("./runnerReach").RunnerReach;
}

export interface StepEntry {
  id: string;
  varName: string;
  hasHandler: boolean;
  chunkVirtualId?: string;
  toolId?: string;
  sourceFile: string;
  hash?: string;
}

export interface PluginState {
  chunks: Map<string, ExtractedChunk>;
  steps: Map<string, StepEntry>;
  stepsByVarName: Map<string, string>;
  flows: Map<string, FlowEntry>;
  skills: Map<string, SkillEntry>;
  skillsByVarName: Map<string, string>;
  projections: Map<string, ProjectionEntry>;
}
