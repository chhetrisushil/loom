import type { ExecutionState } from "@loom/core";
import type { RegisteredFlow, ResumeEvent, WorkflowRuntime } from "@loom/workflow-runtime";
import type { A2ATask, A2ATaskResult, A2ATaskStatus } from "./types";

/**
 * The A2A task lifecycle, expressed as a small executor interface. Its states map
 * one-to-one onto Loom's execution states, so the entire A2A layer reduces to a
 * single adapter over the runtime:
 *
 *   submit / working   → runtime.start → running
 *   input-required     → SuspendError / status "suspended" (approval / A2UI form)
 *   provideInput       → runtime.resume(executionId, resumeEvent)
 *   completed / failed → terminal ExecutionState
 *
 * A transport (the in-house HTTP server below, or an external @a2a-js/sdk server)
 * only has to move bytes to/from this interface.
 */
export interface AgentExecutor {
  submit(task: A2ATask): Promise<{ id: string }>;
  /** Poll a task's status/result. `null` ⇒ unknown task (→ 404). */
  get(taskId: string): Promise<A2ATaskResult | null>;
  /** Deliver the input an `input-required` (suspended) task is waiting on. */
  provideInput(taskId: string, event: ResumeEvent): Promise<{ id: string }>;
}

/** Map a Loom execution status onto an A2A task status. */
export function executionStatusToA2A(status: string): A2ATaskStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "running":
    case "suspended":
      return "working";
    default:
      return "submitted";
  }
}

/** Fold a terminal/interim ExecutionState into the A2A task result shape. */
export function toTaskResult(taskId: string, state: ExecutionState): A2ATaskResult {
  const a2aStatus = executionStatusToA2A(state.status);
  const result: A2ATaskResult = { id: taskId, status: a2aStatus };
  if (a2aStatus === "completed") {
    const output = state.variables._output;
    result.artifacts = [
      {
        parts: [
          { type: "text", text: typeof output === "string" ? output : JSON.stringify(output) },
        ],
      },
    ];
  } else if (a2aStatus === "failed") {
    result.error = String(state.variables._error ?? "unknown error");
  }
  return result;
}

/**
 * The single adapter: drives one Loom flow as an A2A agent. It is STATELESS —
 * `get` rebuilds status from the durable log via `runtime.loadState` rather than
 * holding a live handle, so the server can be horizontally scaled or restarted
 * without losing in-flight tasks (the same statelessness the remote-worker model
 * relies on).
 */
export class LoomAgentExecutor implements AgentExecutor {
  constructor(
    private readonly runtime: WorkflowRuntime,
    private readonly flow: RegisteredFlow
  ) {}

  async submit(task: A2ATask): Promise<{ id: string }> {
    const prompt = task.message.parts.map((p) => p.text).join("\n");
    const handle = await this.runtime.start(
      this.flow,
      { prompt },
      task.id ? { executionId: task.id } : undefined
    );
    return { id: handle.executionId };
  }

  async get(taskId: string): Promise<A2ATaskResult | null> {
    const state = await this.runtime.loadState(taskId);
    return state ? toTaskResult(taskId, state) : null;
  }

  async provideInput(taskId: string, event: ResumeEvent): Promise<{ id: string }> {
    const handle = await this.runtime.resume(taskId, event);
    return { id: handle.executionId };
  }
}
