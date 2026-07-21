import type { ExecutionState } from "@loom/core";
import type { RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { type JsonRpcRequest, type JsonRpcResponse, RPC_ERRORS, WIRE_ABI } from "./protocol";

// ── T2.4 — the carrier: drive executions over JSON-RPC ────────────────────────
//
// A pure request→response dispatcher that maps the CARRIER methods onto a
// WorkflowRuntime. Mount it on any transport (the A2A server, worker-server, or
// a bare node:http handler). Every ring the runtime is wired with (K2 authorize,
// K3 meter, K6 validate, K7 egress, K12 authority) runs KERNEL-SIDE of the wire
// (T2.2) — a wire client gains no bypass; it only starts/resumes/reads, and the
// kernel folds. The returned fold is byte-identical to an in-process client's.

/** Resolve a flow id to the registered flow to start (the server's code registry). */
export type FlowResolver = (flowId: string) => RegisteredFlow | undefined;

export interface CarrierOptions {
  /** How `execution.start` resolves a flowId to a RegisteredFlow. Defaults to `runtime.getFlow`. */
  resolveFlow?: FlowResolver;
  /**
   * Resolve the authenticated principal for a request from the TRANSPORT's connection
   * context — NEVER from the request body. The mounting transport authenticates the
   * connection (mTLS, bearer token, signed header, …) and supplies this bound to that
   * identity; the carrier ignores any client-supplied `principal` in the wire params.
   * Omitted → no principal is asserted and the runtime's default identity applies.
   *
   * This is the trust boundary: the K2/K12 authz ring keys tenant/actor grants and the
   * DelegationAuthorizer confused-deputy binding on this principal, so it must reflect who
   * is really connected, not who the client claims to be.
   */
  resolvePrincipal?: (request: JsonRpcRequest) => Record<string, unknown> | undefined;
}

interface StartParams {
  flowId: string;
  input?: unknown;
  executionId?: string;
  // NOTE: no `principal` field — identity is resolved transport-side via
  // CarrierOptions.resolvePrincipal, never trusted from the client request body.
}
interface ResumeParams {
  executionId: string;
  event: { eventType: string; payload: unknown };
}
interface IdParams {
  executionId: string;
  reason?: string;
}

function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}
function err(id: JsonRpcRequest["id"], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** A JSON-safe projection of the folded state — what a wire client reads back. */
function stateView(state: ExecutionState): unknown {
  return {
    executionId: state.executionId,
    workflowId: state.workflowId,
    status: state.status,
    sequence: state.sequence,
    variables: state.variables,
    frames: state.frames,
    ...(state.suspendedOn !== undefined && { suspendedOn: state.suspendedOn }),
  };
}

/**
 * Handle one JSON-RPC request against the runtime. Never throws — every failure
 * (bad params, kernel-ring refusal, unknown method) is a JSON-RPC error object,
 * so a shell client parses one shape. `ctx.*` syscall methods are rejected
 * with `methodNotFound`: a wire client drives executions, it does not make
 * individual syscalls (that is the kernel's own concern — A3).
 */
export async function handleRpc(
  runtime: WorkflowRuntime,
  request: JsonRpcRequest,
  options: CarrierOptions = {}
): Promise<JsonRpcResponse> {
  const { id, method, params } = request;
  const resolveFlow = options.resolveFlow ?? ((fid: string) => runtime.getFlow(fid));

  try {
    switch (method) {
      case "abi.describe":
        return ok(id, WIRE_ABI);

      case "execution.start": {
        const p = params as StartParams;
        const flow = resolveFlow(p.flowId);
        if (flow === undefined) {
          return err(id, RPC_ERRORS.invalidParams, `no flow registered: "${p.flowId}"`);
        }
        // SECURITY: the principal (the identity the K2/K12 authz ring keys on) comes from
        // the transport's AUTHENTICATED connection via resolvePrincipal — never from the
        // request body. A wire client cannot self-assert an actor/tenant, so a captured
        // delegation token can't be replayed by supplying a matching `actor` field.
        const principal = options.resolvePrincipal?.(request);
        const handle = await runtime.start(flow, p.input, {
          ...(p.executionId !== undefined && { executionId: p.executionId }),
          ...(principal !== undefined && { principal }),
        });
        await settle(runtime, handle);
        return ok(id, stateView(handle.getState()));
      }

      case "execution.resume": {
        const p = params as ResumeParams;
        const handle = await runtime.resume(p.executionId, p.event);
        await settle(runtime, handle);
        return ok(id, stateView(handle.getState()));
      }

      case "execution.getState": {
        const p = params as IdParams;
        const state = await runtime.loadState(p.executionId);
        if (state === null) {
          return err(id, RPC_ERRORS.invalidParams, `no execution: "${p.executionId}"`);
        }
        return ok(id, stateView(state));
      }

      case "execution.cancel": {
        const p = params as IdParams;
        const cancelled = await runtime.cancel(p.executionId, p.reason);
        return ok(id, { cancelled });
      }

      default:
        if (method.startsWith("ctx.")) {
          return err(
            id,
            RPC_ERRORS.methodNotFound,
            `syscall "${method}" is kernel-internal; wire clients use the execution.* carrier`
          );
        }
        return err(id, RPC_ERRORS.methodNotFound, `unknown method: "${method}"`);
    }
  } catch (e) {
    // A kernel-ring refusal (denial, quota, safety, mismatch, forged approval, …)
    // surfaces here as a thrown error — reported as a kernel-refused RPC error.
    return err(id, RPC_ERRORS.kernelRefused, e instanceof Error ? e.message : String(e));
  }
}

// Wait for the run to reach a terminal-or-suspended state (whichever the flow
// does), so getState() returns a settled fold — never a mid-flight snapshot.
async function settle(
  _runtime: WorkflowRuntime,
  handle: { waitForCompletion(): Promise<unknown>; waitForSuspend(): Promise<unknown> }
): Promise<void> {
  await Promise.race([
    handle.waitForSuspend().catch(() => undefined),
    handle.waitForCompletion().catch(() => undefined),
  ]);
}
