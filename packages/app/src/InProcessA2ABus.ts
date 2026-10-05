import { LocalDispatcher } from "@loom/dispatcher";
import type { ExecutionDispatcher } from "@loom/dispatcher";
import type { PrincipalChain } from "@loom/effect-runtime";
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
  /**
   * R13 — the approver's signed proof (`signResume` from `@loom/workflow-runtime`), for an app
   * whose runtime wires a `resumeAuthenticator`. Sign the payload the bus will send — build it
   * with {@link approvalPayload} — then return `{ ...decision, proof }`:
   *
   * ```ts
   * onApproval: async (req) => {
   *   const decision = { approved: true, approvedBy: "alice" };
   *   const signed = signResume(
   *     { eventType: req.gate, payload: approvalPayload(req, decision) },
   *     { actor: "alice", secret, exp: Date.now() + 60_000,
   *       executionId: req.executionId, parkedAtSequence: req.parkedAtSequence! }
   *   );
   *   return { ...decision, proof: (signed.payload as { proof: ApprovalProof }).proof };
   * }
   * ```
   */
  proof?: ApprovalProof | undefined;
}

/** The `proof` object `signResume` puts in an approval payload. */
export interface ApprovalProof {
  actor: string;
  sig: string;
  exp: number;
}

/**
 * What an approver is asked to decide: which execution, which gate, and the digest of the
 * proposal the gate declared (`state.suspendedOn.viewDigest`, R13). The bus echoes that digest
 * in the resume it sends, so the decision is bound to THIS proposal — an approval for an older
 * one is refused by the runtime before anything is recorded.
 */
export interface ApprovalRequest {
  executionId: string;
  gate: string;
  viewDigest?: string | undefined;
  /**
   * Sequence of the `EXECUTION_SUSPENDED` that parked the execution (the state's sequence at the
   * park). What a signed approval binds to (single use per park); see `ApprovalDecision.proof`.
   */
  parkedAtSequence?: number | undefined;
}

/**
 * The exact resume payload the bus sends for `decision` at `request`: the decision plus the
 * gate's `viewDigest` echoed (and the `proof`, if the decision has one). An approver who signs
 * must sign THIS — the proof covers the whole payload except itself.
 */
export function approvalPayload(
  request: ApprovalRequest,
  decision: ApprovalDecision
): Record<string, unknown> {
  return {
    ...decision,
    ...(request.viewDigest !== undefined && { viewDigest: request.viewDigest }),
  };
}

/**
 * Approve every gate, unconditionally. For demos and tests ONLY: it is the behaviour the bus
 * used to have when no `onApproval` was supplied (R13 removed that default — a gate the bus
 * resumes itself is an approval nobody made). Named loudly so it is visible in review.
 */
export const unsafeAutoApprove = async (): Promise<ApprovalDecision> => {
  if (!warnedAutoApprove) {
    warnedAutoApprove = true;
    console.warn(
      "[loom] unsafeAutoApprove is approving a gate: no human decided this. Demos and tests only — never in a deployment."
    );
  }
  return { approved: true, approvedBy: "unsafeAutoApprove" };
};
let warnedAutoApprove = false;

export interface DispatchOptions {
  onProgress?: ((line: string) => void) | undefined;
  onStatus?: ((status: A2ATaskStatus) => void) | undefined;
  // Called when the agent's flow reaches a durable suspend checkpoint. The
  // resolved decision is delivered as the resume payload — a risk policy or a
  // human operator. ABSENT ⇒ the gate stays suspended and `dispatch` returns
  // `status: "working"` with `suspended` set; resolve it later with
  // `resolveApproval` (R13: the bus no longer approves on anyone's behalf —
  // pass `onApproval: unsafeAutoApprove` for a demo).
  onApproval?: ((request: ApprovalRequest) => Promise<ApprovalDecision>) | undefined;
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
  /** Set when the task is parked at a gate nobody answered (no `onApproval`). */
  suspended?: ApprovalRequest;
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
  private readonly runtime: WorkflowRuntime;
  private readonly maxTasks: number;
  private readonly defaultPrincipal: Record<string, unknown> | undefined;
  /** Tasks parked at an unanswered gate → the flow to resume. Bounded like `tasks`. */
  private readonly parked = new Map<string, { flowId: string; request: ApprovalRequest }>();
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
    this.runtime = runtime;
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
      // returns status:"suspended"; ask `onApproval` and resume with a fresh
      // dispatch. With no `onApproval` the gate STAYS parked (R13).
      const first = await this.dispatcher.dispatch({
        executionId,
        workflowId: flowId,
        flowId,
        input,
        ...(principal !== undefined && { principal }),
      });
      return await this.settle(executionId, flowId, first, principal, options);
    } finally {
      unsub();
    }
  }

  /**
   * Answer the gate a task is parked at (a `dispatch` that returned `suspended`). The decision
   * is delivered as the gate's resume payload with the gate's `viewDigest` echoed — the digest
   * recorded when the task parked, i.e. the proposal the approver was shown.
   */
  async resolveApproval(
    taskId: string,
    decision: ApprovalDecision,
    options: Pick<DispatchOptions, "principal" | "onApproval" | "onStatus"> = {}
  ): Promise<DispatchResult> {
    const entry = this.parked.get(taskId);
    if (entry === undefined) {
      throw new Error(
        `task "${taskId}" is not parked at a gate this bus remembers (it was answered, never parked here, or evicted past maxTasks). The execution itself may still be parked: answer it directly with runtime.resume(executionId, answerApproval(state, decision)) from @loom/workflow-runtime.`
      );
    }
    const principal = options.principal ?? this.defaultPrincipal;
    const result = await this.resume(taskId, entry.flowId, entry.request, decision, principal);
    // Only forget the park once the runtime accepted the answer (a refusal throws above).
    this.parked.delete(taskId);
    return this.settle(taskId, entry.flowId, result, principal, options);
  }

  private resume(
    executionId: string,
    flowId: string,
    request: ApprovalRequest,
    decision: ApprovalDecision,
    principal: Record<string, unknown> | undefined
  ) {
    return this.dispatcher.dispatch({
      executionId,
      workflowId: flowId,
      flowId,
      resumeEvent: {
        eventType: request.gate,
        payload: approvalPayload(request, decision),
      },
      ...(principal !== undefined && { principal }),
    });
  }

  private parkTask(executionId: string, flowId: string, request: ApprovalRequest): void {
    this.parked.delete(executionId);
    this.parked.set(executionId, { flowId, request });
    while (this.parked.size > this.maxTasks) {
      const oldest = this.parked.keys().next();
      if (oldest.done) break;
      this.parked.delete(oldest.value);
    }
  }

  /** Drive a dispatch result to terminal, or leave it parked when nobody may answer the gate. */
  private async settle(
    executionId: string,
    flowId: string,
    first: Awaited<ReturnType<ExecutionDispatcher["dispatch"]>>,
    principal: Record<string, unknown> | undefined,
    options: Pick<DispatchOptions, "onApproval" | "onStatus">
  ): Promise<DispatchResult> {
    let result = first;
    while (result.status === "suspended") {
      const cond = result.state.suspendedOn;
      const gate = cond?.on;
      // R13 — the park is where the log says, not the result's tip: an audit event
      // (`EXECUTION_DENIED`) trailing the park would otherwise move the tip off it. Left
      // undefined when it cannot be read — an approval signed against a guess is refused anyway.
      const parkedAtSequence = await this.runtime
        .parkedAtSequence(executionId, {
          ...(principal !== undefined && { principal: principal as PrincipalChain }),
        })
        .catch(() => undefined);
      // A dispatcher that placed the execution on a log this runtime cannot read (remote) has
      // only the result's own sequence to offer.
      const request: ApprovalRequest | undefined =
        gate === undefined
          ? undefined
          : {
              executionId,
              gate,
              ...(cond?.viewDigest !== undefined && { viewDigest: cond.viewDigest }),
              parkedAtSequence: parkedAtSequence ?? result.state.sequence,
            };
      // No approver, an unreadable gate, or a timer wake (the kernel's, not an approver's):
      // the gate stays parked and the caller is told so.
      if (options.onApproval === undefined || request === undefined || gate === "TIMER_FIRED") {
        const parkedRequest = request ?? { executionId, gate: "<unknown>" };
        if (request !== undefined) this.parkTask(executionId, flowId, request);
        this.retainTask(executionId, { id: executionId, status: "working" });
        options.onStatus?.("working");
        return {
          taskId: executionId,
          status: "working",
          artifact: undefined,
          suspended: parkedRequest,
        };
      }
      const decision = await options.onApproval(request);
      result = await this.resume(executionId, flowId, request, decision, principal);
      this.parked.delete(executionId);
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
  }
}
