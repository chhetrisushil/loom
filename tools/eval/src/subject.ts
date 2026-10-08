import type { ExecutionState } from "@loom/core";
import type { Subject } from "./suite";

/** What `flowSubject` needs of a runtime: structurally `WorkflowRuntime.start`. */
export interface FlowSubjectOptions<I> {
  /** Start the flow under test with `input` (e.g. `(i) => runtime.start(flow, i)`). */
  start(input: I): Promise<{ executionId: string; waitForCompletion(): Promise<ExecutionState> }>;
}

/**
 * A {@link Subject} that runs a flow (or agent flow) to completion and yields what a grader
 * needs: `{ status, output, executionId }`. A run that does not complete rejects, and the case
 * is reported as errored rather than silently scored on a half result.
 */
export function flowSubject<I>(
  opts: FlowSubjectOptions<I>
): Subject<I, { status: string; output: unknown; executionId: string }> {
  return async (input) => {
    const handle = await opts.start(input);
    const state = await handle.waitForCompletion();
    if (state.status !== "completed") {
      throw new Error(`execution ${handle.executionId} ended ${state.status}, not completed`);
    }
    return {
      status: state.status,
      output: state.variables._output,
      executionId: handle.executionId,
    };
  };
}
