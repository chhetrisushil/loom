import { LocalDispatcher } from "@loom/dispatcher";
import type { ExecutionDispatcher } from "@loom/dispatcher";
import type { A2ATask, A2ATaskResult, A2ATaskStatus, AgentCard } from "@loom/plugin-a2a";
import { LocalWorkerRuntime } from "@loom/worker-runtime-local";
import type { RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { progressHub } from "./progressHub";

// ── InProcessA2ABus — a bring-your-own A2A transport ──────────────────────────
//
// The A2A protocol is transport-agnostic: an agent publishes an AgentCard and
// accepts tasks; a caller sends a task and polls its status until terminal
// (submitted → working → completed/failed). @loom/plugin-a2a ships an HTTP transport
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
  /**
   * R3 — the authenticated principal this dispatch acts for; overrides the bus-level default
   * (`InProcessA2ABusOptions.principal`). Forwarded on every package the dispatch sends (the
   * start AND each approval resume), so a runtime that fails closed (`security.strict`)
   * authorizes the dispatch as that caller. With none, the dispatch is anonymous and a strict
   * runtime refuses it — the bus's default dispatcher holds no system grant.
   */
  principal?: Record<string, unknown> | undefined;
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

export interface InProcessA2ABusOptions {
  /**
   * Cap on retained task records. Every `submit` records a terminal status and its
   * artifacts, and nothing removed them — so a long-lived agent process grew one entry per
   * request forever, holding the artifact text with it. Oldest-first eviction past the cap;
   * `getTask` returns `undefined` for a task evicted that way, which is the same answer it
   * already gives for an unknown id.
   *
   * Default 1,000. Raise it if callers poll `getTask` long after `submit` resolves.
   */
  maxTasks?: number;
  /**
   * R3 — default principal for every dispatch through this bus (a single-tenant agent process
   * acting as one identity). A per-dispatch `DispatchOptions.principal` overrides it. Omit it on
   * a bus that serves several callers and pass the caller's principal per dispatch.
   */
  principal?: Record<string, unknown>;
}

export class InProcessA2ABus {
  private readonly cards = new Map<string, AgentCard>();
  private readonly capabilities = new Map<string, Registration>();
  private readonly tasks = new Map<string, A2ATaskResult>();
  private readonly dispatcher: ExecutionDispatcher;
  private readonly maxTasks: number;
  private readonly defaultPrincipal: Record<string, unknown> | undefined;
  /**
   * Monotonic id counter. Deliberately NOT `tasks.size`, which this used to be: `size`
   * shrinks when the cap above evicts, so ids would start repeating and a new task would
   * collide with an old one on the event log. Adding eviction without this would have
   * introduced that bug rather than fixed one.
   *
   * (There is no concurrency hazard in the old form: nothing awaits between reading `size`
   * and inserting, so two dispatches cannot interleave there. Eviction is the whole reason.)
   */
  private issued = 0;

  constructor(
    runtime: WorkflowRuntime,
    // Placement is pluggable: default to running the fiber in-process on the
    // local runtime. Inject a remote/Cloud Run dispatcher to move it off-box
    // without touching this transport.
    dispatcher?: ExecutionDispatcher,
    options: InProcessA2ABusOptions = {}
  ) {
    this.dispatcher = dispatcher ?? new LocalDispatcher(new LocalWorkerRuntime(runtime));
    this.maxTasks = Math.max(1, options.maxTasks ?? 1_000);
    this.defaultPrincipal = options.principal;
  }

  /** Record a task result, evicting oldest-first past the cap. */
  private retainTask(id: string, result: A2ATaskResult): void {
    this.tasks.delete(id);
    this.tasks.set(id, result);
    while (this.tasks.size > this.maxTasks) {
      const oldest = this.tasks.keys().next();
      if (oldest.done) break;
      this.tasks.delete(oldest.value);
    }
  }

  /** Retained task records. Exposed so a caller can assert the bus is not growing. */
  get retainedTasks(): number {
    return this.tasks.size;
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

    const executionId = options.executionId ?? `task-${capabilityId}-${this.issued++}`;
    const principal = options.principal ?? this.defaultPrincipal;
    const flowId = reg.flow.definition.id;
    // The A2A task envelope that would travel over the wire to the agent. In this
    // in-process transport we hand its input straight to the agent's flow.
    const task: A2ATask = {
      id: executionId,
      message: { role: "user", parts: [{ type: "text", text: prompt }] },
      metadata: { capabilityId, agentId: reg.agentId },
    };
    this.retainTask(task.id, { id: task.id, status: "submitted" });

    // Route the flow's live narration to the caller.
    const unsub = progressHub.onReport(executionId, (line) => options.onProgress?.(line));

    const setStatus = (status: A2ATaskStatus): void => {
      const prev = this.tasks.get(executionId);
      this.retainTask(executionId, { ...(prev ?? { id: executionId, status }), status });
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
        ...(principal !== undefined && { principal }),
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
          ...(principal !== undefined && { principal }),
        });
      }

      const status = executionStatusToA2A(result.state.status);
      const artifact = result.state.variables._output;

      this.retainTask(executionId, {
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
