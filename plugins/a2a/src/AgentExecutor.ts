import { createHash, randomUUID } from "node:crypto";
import type { ExecutionState } from "@loom/core";
import type { PrincipalChain } from "@loom/effect-runtime";
import type { RegisteredFlow, ResumeEvent, WorkflowRuntime } from "@loom/workflow-runtime";
import type { A2ATask, A2ATaskResult, A2ATaskStatus } from "./types";

/**
 * The A2A task lifecycle, expressed as a small executor interface. Its states map
 * one-to-one onto Loom's execution states, so the entire A2A layer reduces to a
 * single adapter over the runtime:
 *
 *   submit / working   → runtime.start → running
 *   input-required     → SuspendError / status "suspended" (approval / agent-surface form)
 *   provideInput       → runtime.resume(executionId, resumeEvent)
 *   completed / failed → terminal ExecutionState
 *
 * A transport (the in-house HTTP server below, or an external @a2a-js/sdk server)
 * only has to move bytes to/from this interface.
 */
export interface AgentExecutor {
  submit(task: A2ATask, call?: ExecutorCall): Promise<{ id: string }>;
  /** Poll a task's status/result. `null` ⇒ unknown task (→ 404). */
  get(taskId: string, call?: ExecutorCall): Promise<A2ATaskResult | null>;
  /** Deliver the input an `input-required` (suspended) task is waiting on. */
  provideInput(taskId: string, event: ResumeEvent, call?: ExecutorCall): Promise<{ id: string }>;
}

/**
 * R3 — per-call context from the transport. `principal` is the AUTHENTICATED identity of whoever
 * made the request (resolved by the transport from its connection, never from the task body);
 * the executor applies it to the runtime call so a runtime that fails closed (`security.strict`)
 * authorizes the task as that caller. Absent ⇒ anonymous, which such a runtime refuses.
 */
export interface ExecutorCall {
  principal?: PrincipalChain;
  /**
   * R12 — the task namespace when no principal identifies the caller (e.g. a boolean `authorize`
   * gate). Ignored when `principal` is present (the principal's identity wins). Only meaningful
   * on an executor created with `namespaceByPrincipal`.
   */
  namespace?: string;
}

export interface LoomAgentExecutorOptions {
  /**
   * R12 — scope task ids to the caller. The execution id the runtime sees is
   * `a2a.<namespace of caller>.<client task id>`: a caller can only ever name executions in its
   * OWN namespace, so it cannot read, resume or collide with another caller's task by guessing
   * or choosing an id (the lookup simply lands on a different, nonexistent execution). The
   * client-visible id stays the one it chose. Default `false` for direct (in-process) use of the
   * executor, where the id is the embedder's own; the HTTP server turns it on.
   */
  namespaceByPrincipal?: boolean;
}

/** R12 — does this principal carry the minimum identity a per-caller namespace needs? */
export function hasActor(principal: PrincipalChain): boolean {
  return typeof principal.actor === "string" && principal.actor.trim().length > 0;
}

/**
 * R12 — a stable, opaque key for a principal; the namespace its tasks live in. Two callers with
 * different identity can never address each other's execution ids, because the id the runtime
 * sees embeds this key. Tenant + actor + onBehalfOf are the identity; a delegation token is not
 * (it is a credential, and rotating it must not orphan the caller's tasks).
 */
export function principalNamespace(principal: PrincipalChain | undefined): string {
  if (principal === undefined) return "anonymous";
  // Fail closed: `PrincipalChain` makes every field optional and allows extras, so a principal
  // identifying callers by another field (`{ sub }`) would hash to ONE shared namespace and hand
  // every such caller each other's tasks. An actor is the minimum identity.
  if (!hasActor(principal)) {
    throw new Error(
      "principalNamespace: the principal has no non-empty string `actor` — it cannot be given a per-caller task namespace"
    );
  }
  const identity = JSON.stringify([
    principal.tenant ?? null,
    principal.actor ?? null,
    principal.onBehalfOf ?? null,
  ]);
  return createHash("sha256").update(identity).digest("hex").slice(0, 24);
}

function scopedId(
  call: ExecutorCall,
  clientId: string,
  namespaceOf: (p: PrincipalChain | undefined) => string
): string {
  const ns =
    call.principal !== undefined ? namespaceOf(call.principal) : (call.namespace ?? "anonymous");
  return `a2a.${ns}.${clientId}`;
}

/** Strip the `a2a.<namespace>.` prefix back off an execution id. */
function clientIdOf(executionId: string): string {
  const m = /^a2a\.[^.]*\.(.*)$/s.exec(executionId);
  return m?.[1] ?? executionId;
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
    private readonly flow: RegisteredFlow,
    private readonly options: LoomAgentExecutorOptions = {}
  ) {}

  private idFor(call: ExecutorCall, clientId: string): string {
    return this.options.namespaceByPrincipal === true
      ? scopedId(call, clientId, principalNamespace)
      : clientId;
  }

  async submit(task: A2ATask, call: ExecutorCall = {}): Promise<{ id: string }> {
    const prompt = task.message.parts.map((p) => p.text).join("\n");
    const identity = call.principal !== undefined ? { principal: call.principal } : {};
    const handle = await this.runtime.start(
      this.flow,
      { prompt },
      {
        ...((task.id || this.options.namespaceByPrincipal === true) && {
          executionId: this.idFor(call, task.id || randomUUID()),
        }),
        ...identity,
      }
    );
    // Under namespacing the caller only ever sees the id it chose (or was minted).
    return {
      id:
        this.options.namespaceByPrincipal === true
          ? clientIdOf(handle.executionId)
          : handle.executionId,
    };
  }

  async get(taskId: string, call: ExecutorCall = {}): Promise<A2ATaskResult | null> {
    const identity = call.principal !== undefined ? { principal: call.principal } : {};
    const state = await this.runtime.loadState(this.idFor(call, taskId), identity);
    return state ? toTaskResult(taskId, state) : null;
  }

  async provideInput(
    taskId: string,
    event: ResumeEvent,
    call: ExecutorCall = {}
  ): Promise<{ id: string }> {
    const identity = call.principal !== undefined ? { principal: call.principal } : {};
    const handle = await this.runtime.resume(this.idFor(call, taskId), event, identity);
    return { id: taskId };
  }
}
