export interface DispatchResult {
  status: string;
  artifact: unknown;
}

export interface DispatchPlanConfig<TStep> {
  goal: string;
  /** Intent routing (observability only — its result is passed to `onRouted`). */
  route?: (goal: string) => Promise<unknown>;
  /** Compose the ordered plan of steps for the goal. */
  plan: (goal: string) => Promise<{ steps: TStep[] }>;
  /** Dispatch one step (the app does bus.dispatch + its surface updates here). */
  dispatch: (step: TStep, index: number) => Promise<DispatchResult>;
  onRouted?: (route: unknown) => void;
  onPlanned?: (steps: TStep[]) => void;
  onResult?: (step: TStep, result: DispatchResult, index: number) => void;
  /** Stop the run early (e.g. an operator rejection). Checked after each step. */
  isTerminal?: () => boolean;
}

/**
 * The route → plan → dispatch control-flow skeleton shared by every example
 * orchestrator, as a function apps *call* (not a base class they extend). It owns
 * only the sequence and the early-terminate check; all side effects (surface
 * sync, approval gating, artifact absorption) stay in the app's callbacks, so the
 * app keeps its conductor logic and this never forces a shape.
 */
export async function dispatchPlan<TStep>(config: DispatchPlanConfig<TStep>): Promise<TStep[]> {
  if (config.route) {
    config.onRouted?.(await config.route(config.goal));
  }
  const { steps } = await config.plan(config.goal);
  config.onPlanned?.(steps);

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!;
    const result = await config.dispatch(step, index);
    config.onResult?.(step, result, index);
    if (config.isTerminal?.()) break;
  }
  return steps;
}
