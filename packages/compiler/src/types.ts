export interface ExtractedChunk {
  stepId: string;
  chunkVirtualId: string;
  chunkSource: string;
  sourceFile: string;
  hash: string;
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
}
