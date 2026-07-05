import type { A2ATask, A2ATaskResult, A2ATaskStatus, AgentCard } from "@loom/a2a";
import type { ExecutionHandle, RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { progressHub } from "../runtime/progressHub";

// ── InProcessA2ABus — a bring-your-own A2A transport ──────────────────────────
//
// The A2A protocol is transport-agnostic: an agent publishes an AgentCard and
// accepts tasks; a caller sends a task and polls its status until terminal
// (submitted → working → completed/failed). @loom/a2a ships an HTTP transport
// (createA2AServer/createA2AClientEffect) for cross-process agents. This app runs
// entirely in the browser, so we bring our own in-process transport with the
// exact same protocol shapes.
//
// Beyond the base protocol it adds two ergonomic hooks the base HTTP client
// approximates by polling: onProgress (live narration from the agent) and
// onApproval (a human-in-the-loop gate that resumes a durably-suspended flow).

// A capability an agent exposes, backed by a durable Loom flow.
interface Registration {
  agentId: string;
  flow: RegisteredFlow;
}

export interface ApprovalDecision {
  approved: boolean;
  approvedBy: string;
}

export interface DispatchOptions {
  onProgress?: ((line: string) => void) | undefined;
  onStatus?: ((status: A2ATaskStatus) => void) | undefined;
  // Called when the agent's flow reaches a durable suspend checkpoint. The
  // resolved decision is delivered as the resume payload — either the risk
  // policy (auto) or a human operator (manual). Absent ⇒ auto-approve.
  onApproval?: (() => Promise<ApprovalDecision>) | undefined;
  // Stable id for the underlying execution so progress can be correlated before
  // the flow starts running. Defaults to a derived id.
  executionId?: string | undefined;
}

export interface DispatchResult {
  taskId: string;
  status: A2ATaskStatus;
  artifact: unknown;
}

function executionStatusToA2A(status: string): A2ATaskStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "cancelled":
      return "failed";
    case "running":
    case "suspended":
      return "working";
    default:
      return "submitted";
  }
}

export class InProcessA2ABus {
  private readonly cards = new Map<string, AgentCard>();
  private readonly capabilities = new Map<string, Registration>();
  private readonly tasks = new Map<string, A2ATaskResult>();

  constructor(private readonly runtime: WorkflowRuntime) {}

  registerAgent(card: AgentCard): this {
    this.cards.set(card.name, card);
    return this;
  }

  // Wire a capability id to the agent that owns it and the flow that fulfils it.
  registerCapability(capabilityId: string, agentId: string, flow: RegisteredFlow): this {
    this.capabilities.set(capabilityId, { agentId, flow });
    return this;
  }

  agentCards(): AgentCard[] {
    return [...this.cards.values()];
  }

  // A2A "get task" — the poll surface. Mirrors GET /tasks/:id.
  getTask(taskId: string): A2ATaskResult | undefined {
    return this.tasks.get(taskId);
  }

  // A2A "send task" + poll to terminal, in one awaitable call (what the HTTP
  // client effect does under the hood). Returns the final artifact.
  async dispatch(
    capabilityId: string,
    input: unknown,
    prompt: string,
    options: DispatchOptions = {}
  ): Promise<DispatchResult> {
    const reg = this.capabilities.get(capabilityId);
    if (!reg) {
      throw new Error(`No agent exposes capability "${capabilityId}"`);
    }

    const executionId = options.executionId ?? `task-${capabilityId}-${this.tasks.size}`;
    // The A2A task envelope that would travel over the wire to the agent. In this
    // in-process transport we hand its input straight to the agent's flow.
    const task: A2ATask = {
      id: executionId,
      message: { role: "user", parts: [{ type: "text", text: prompt }] },
      metadata: { capabilityId, agentId: reg.agentId },
    };
    this.tasks.set(task.id, { id: task.id, status: "submitted" });

    // Route the flow's live narration to the caller.
    const unsub = progressHub.onReport(executionId, (line) => options.onProgress?.(line));

    const setStatus = (status: A2ATaskStatus): void => {
      const prev = this.tasks.get(executionId);
      this.tasks.set(executionId, { ...(prev ?? { id: executionId, status }), status });
      options.onStatus?.(status);
    };

    try {
      setStatus("working");
      const handle = await this.runtime.start(reg.flow, input, { executionId });

      const state = await this.awaitTerminal(handle, executionId, options);
      const status = executionStatusToA2A(state.status);
      const artifact = state.variables._output;

      this.tasks.set(executionId, {
        id: executionId,
        status,
        ...(status === "completed"
          ? {
              artifacts: [
                {
                  parts: [
                    {
                      type: "text",
                      text: typeof artifact === "string" ? artifact : JSON.stringify(artifact),
                    },
                  ],
                },
              ],
            }
          : { error: String(state.variables._error ?? "failed") }),
      });
      options.onStatus?.(status);
      return { taskId: executionId, status, artifact };
    } finally {
      unsub();
    }
  }

  // Drives one dispatch to a terminal state, resuming through any durable
  // suspend checkpoint via the caller's approval hook.
  private async awaitTerminal(
    handle: ExecutionHandle,
    executionId: string,
    options: DispatchOptions
  ): Promise<ReturnType<ExecutionHandle["getState"]>> {
    // waitForCompletion stays pending on suspend; waitForSuspend stays pending
    // when the flow never suspends — so this race resolves on whichever the flow
    // actually does.
    const outcome = await Promise.race([
      handle.waitForSuspend().then(() => ({ kind: "suspended" as const })),
      handle.waitForCompletion().then((state) => ({ kind: "completed" as const, state })),
    ]);

    if (outcome.kind === "completed") {
      return outcome.state;
    }

    // Durable human-in-the-loop checkpoint reached.
    const decision: ApprovalDecision = options.onApproval
      ? await options.onApproval()
      : { approved: true, approvedBy: "auto" };

    const resumed = await this.runtime.resume(executionId, {
      eventType: "ApprovalGranted",
      payload: decision,
    });
    return resumed.waitForCompletion();
  }
}
