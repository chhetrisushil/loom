import type { A2ATask, A2ATaskResult, A2ATaskStatus, AgentCard } from "@loom/a2a";
import { LocalDispatcher } from "@loom/dispatcher";
import type { ExecutionDispatcher } from "@loom/dispatcher";
import { LocalWorkerRuntime } from "@loom/worker-runtime-local";
import type { RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { progressHub } from "./progressHub";

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
//
// Placement note: the bus no longer calls the WorkflowRuntime directly. It hands
// each execution to an ExecutionDispatcher, which decides *where* the fiber runs
// (in-process here, Cloud Run later) and returns an ExecutionResult. A durable
// human-in-the-loop suspend comes back as `status: "suspended"`; we collect the
// approval decision and continue with a *fresh resume dispatch*, so the worker
// stays disposable across the gate.

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
  private readonly dispatcher: ExecutionDispatcher;

  constructor(
    runtime: WorkflowRuntime,
    // Placement is pluggable: default to running the fiber in-process on the
    // local runtime. Inject a remote/Cloud Run dispatcher to move it off-box
    // without touching this transport.
    dispatcher?: ExecutionDispatcher
  ) {
    this.dispatcher = dispatcher ?? new LocalDispatcher(new LocalWorkerRuntime(runtime));
  }

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
    const flowId = reg.flow.definition.id;
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

      // Run the fiber to suspend-or-complete. A durable human-in-the-loop gate
      // returns status:"suspended"; resolve the decision and resume with a fresh
      // dispatch. The loop tolerates multiple gates.
      let result = await this.dispatcher.dispatch({
        executionId,
        workflowId: flowId,
        flowId,
        input,
      });

      while (result.status === "suspended") {
        const decision: ApprovalDecision = options.onApproval
          ? await options.onApproval()
          : { approved: true, approvedBy: "auto" };
        result = await this.dispatcher.dispatch({
          executionId,
          workflowId: flowId,
          flowId,
          resumeEvent: { eventType: "ApprovalGranted", payload: decision },
        });
      }

      const status = executionStatusToA2A(result.state.status);
      const artifact = result.state.variables._output;

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
          : { error: String(result.state.variables._error ?? "failed") }),
      });
      options.onStatus?.(status);
      return { taskId: executionId, status, artifact };
    } finally {
      unsub();
    }
  }
}
