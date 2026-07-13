export interface ExtractedChunk {
  // The owning construct's id — a step id (kind "step") or skill id (kind "skill").
  stepId: string;
  kind: "step" | "skill";
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

export interface FlowEntry {
  id: string;
  version: string;
  stepIds: string[];
  suspendPoints: string[];
  sourceFile: string;
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
}
