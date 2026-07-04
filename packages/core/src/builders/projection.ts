import type { ProjectionDefinition } from "../types/definitions";

export interface ProjectionConfig<TState> {
  id: string;
  name: string;
  sourceFlowId?: string;
  initialState: TState;
  handlers: Record<string, (state: TState, payload: unknown) => TState>;
}

export function projection$<TState>(config: ProjectionConfig<TState>): ProjectionDefinition<TState> {
  return {
    _tag: "ProjectionDefinition",
    id: config.id,
    name: config.name,
    initialState: config.initialState,
    handlers: config.handlers,
    ...(config.sourceFlowId !== undefined && { sourceFlowId: config.sourceFlowId }),
  };
}
