import type {
  ProjectionDefinition,
  ProjectionHandlers,
  ProjectionHandlersRef,
  ProjectionHandlersSpec,
} from "../types/definitions";

export interface ProjectionConfig<TState> {
  id: string;
  name: string;
  sourceFlowId?: string;
  /** ADR 0095 — the declared semantics of this fold. See {@link ProjectionDefinition.version}. */
  version?: string;
  initialState: TState;
  /**
   * The event-fold map (`{ [eventType]: (state, event) => state }`). Uncompiled it is
   * inline; the `@loom/compiler` plugin rewrites it to a lazy `import()` ref so the fold
   * code lands in its own chunk, loaded on demand when a handled event first fires.
   */
  handlers: ProjectionHandlersSpec<TState>;
}

export function projection$<TState>(
  config: ProjectionConfig<TState>
): ProjectionDefinition<TState> {
  return {
    _tag: "ProjectionDefinition",
    id: config.id,
    name: config.name,
    initialState: config.initialState,
    handlers: config.handlers,
    ...(config.sourceFlowId !== undefined && { sourceFlowId: config.sourceFlowId }),
    ...(config.version !== undefined && { version: config.version }),
  };
}

/** True when a projection's handlers are the compiler-emitted lazy ref (not an inline map). */
export function isProjectionHandlersRef<TState>(
  spec: ProjectionHandlersSpec<TState>
): spec is ProjectionHandlersRef<TState> {
  return (spec as ProjectionHandlersRef<TState>)._loomProjectionHandlersRef === true;
}

/**
 * The event types a projection folds — read WITHOUT loading the fold code. For the lazy
 * ref this is the compiler-recorded key set; for an inline map it is `Object.keys`.
 */
export function projectionEventTypes<TState>(spec: ProjectionHandlersSpec<TState>): string[] {
  return isProjectionHandlersRef(spec) ? spec.eventTypes : Object.keys(spec);
}

/**
 * Resolve either handlers form to the concrete fold map — the inline map (dev / no plugin)
 * or the compiler-emitted loader (`() => import(chunk)`). Mirrors `loadInstructions`.
 */
export async function loadProjectionHandlers<TState>(
  spec: ProjectionHandlersSpec<TState>
): Promise<ProjectionHandlers<TState>> {
  if (isProjectionHandlersRef(spec)) {
    const mod = await spec.load();
    return mod.default;
  }
  return spec;
}
