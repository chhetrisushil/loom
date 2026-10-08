import {
  AGENT_INTERRUPTED,
  type AgentHistoryMessage,
  type InterruptedAgentRun,
  agentLoop$,
  isTerminalToolError,
} from "@loom/agent";
import { TypedFailure, flow$, fnv1a64 } from "@loom/core";
import { ToolEffect } from "@loom/effect-runtime";
import type { EffectRuntime, PrincipalChain } from "@loom/effect-runtime";
import type { RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { z } from "zod";
import { type Identity, identityKey, parseIdentity, verifySignature } from "./access";
import type { BargeInSource, StoredInboxMessage } from "./bargeIn";
import { withTurnScope } from "./hub";
import { type ConversationConfig, USER_ORIGIN } from "./types";

// ── SHARED MODE: a turn is its own execution, started as the ASKER (ADR 0122 D10) ───────────────────
//
// The conversation execution runs under its OWNER's authority and only COORDINATES: it dequeues a turn,
// asks this effect to run it, and records the transcript. The turn itself is a separate execution
// started with the asker's principal (ADR 0111), so every tool call, memory write, quota and capability
// check inside it is the ASKER's. A participant with fewer grants than the owner cannot reach a tool the
// owner can: the denial is raised inside the turn, and surfaces to that participant as a failed turn.

/** What the coordinator hands the turn. */
export interface TurnInput {
  conversationId: string;
  turn: number;
  ord: number;
  asker: Identity;
  text: string;
  /** The key the message was sent under (the barge-in watcher's retry test). */
  id?: string;
  history: AgentHistoryMessage[];
  /** Idempotency keys of recent turns (the watcher must not treat a retry as an interruption). */
  known: string[];
}

export interface TurnResult {
  status: "complete" | "interrupted" | "failed";
  content: string;
  /** Names of the tools the turn called (for classification). */
  tools: string[];
  /** A fixed, user-safe reason for `failed`. */
  reason?: "denied" | "model-error" | "turn-failed" | "cancelled";
  errorId?: string;
  /** The execution that ran the turn. */
  turnExecutionId: string;
}

/** The turn execution's id: deterministic, so a recovery adopts the same execution. */
export const turnExecutionId = (conversationId: string, ord: number): string =>
  `turn:${conversationId}:o${ord}`;

const DENIED = /Denied|Forbidden|Unauthori[sz]ed/;

/** The flow a shared turn runs as (one `agentLoop$`), with the abort signals the effect registers. */
export function sharedTurnFlow(
  config: ConversationConfig,
  signals: Map<string, AbortSignal>,
  flowId: string
): RegisteredFlow<TurnInput, Omit<TurnResult, "turnExecutionId">> {
  const definition = flow$({
    id: flowId,
    name: "Conversation turn",
    version: "1.0.0",
    inputSchema: z.any(),
    outputSchema: z.any(),
    steps: [],
  });
  const runner = async (
    ctx: Parameters<RegisteredFlow["runner"]>[0],
    input: TurnInput
  ): Promise<Omit<TurnResult, "turnExecutionId">> => {
    const signal = signals.get(ctx.executionId);
    const errorId = `err-${fnv1a64(ctx.executionId)}`;
    try {
      const out = await agentLoop$(
        ctx,
        { ...config.agent, loopId: "turn", ...(signal !== undefined && { signal }) },
        { prompt: input.text, promptOrigin: USER_ORIGIN, history: input.history }
      );
      return {
        status: "complete",
        content: out.content,
        tools: out.toolCallLog.map((s) => s.toolName),
      };
    } catch (e) {
      if (e instanceof TypedFailure && e.channel === AGENT_INTERRUPTED) {
        const run = e.payload as InterruptedAgentRun;
        return {
          status: "interrupted",
          content: run.content ?? "",
          tools: (run.toolCallLog ?? []).map((s) => s.toolName),
        };
      }
      if (isTerminalToolError(e)) {
        // An authority refusal is a user-visible outcome of THIS asker's turn; the rest (a park, a
        // cancel, a divergence) is the runtime's and propagates.
        if (e instanceof Error && DENIED.test(e.name)) {
          config.onError?.(errorId, e, { conversationId: input.conversationId, turn: input.turn });
          return { status: "failed", content: "", tools: [], reason: "denied", errorId };
        }
        throw e;
      }
      config.onError?.(errorId, e, { conversationId: input.conversationId, turn: input.turn });
      return { status: "failed", content: "", tools: [], reason: "model-error", errorId };
    }
  };
  return { definition, runner } as unknown as RegisteredFlow<
    TurnInput,
    Omit<TurnResult, "turnExecutionId">
  >;
}

export interface TurnEffectDeps {
  runtime: WorkflowRuntime;
  turnFlow: RegisteredFlow<TurnInput, Omit<TurnResult, "turnExecutionId">>;
  signals: Map<string, AbortSignal>;
  key: string;
  bargeIn?: BargeInSource;
  /** The principal a turn runs as for an asker identity. Default: the identity itself (tenant, actor, onBehalfOf). */
  principalFor?: (asker: Identity) => PrincipalChain | Promise<PrincipalChain>;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/**
 * The effect the coordinator runs a turn through. Idempotent by construction: the turn execution has a
 * deterministic id, a re-run after a crash finds it (finished: use its output; unfinished: continue it).
 */
export function sharedTurnEffect(
  deps: TurnEffectDeps
): ToolEffect<TurnInput & { ownerExecutionId: string }, TurnResult> {
  const { runtime } = deps;
  return new ToolEffect<TurnInput & { ownerExecutionId: string }, TurnResult>(
    async (input, ctx) => {
      const turnId = turnExecutionId(input.conversationId, input.ord);
      const ctl = new AbortController();
      deps.signals.set(turnId, ctl.signal);
      const sys = runtime.systemOptions();
      // The coordinator being cancelled cancels the turn it is waiting on.
      const onCancel = (): void => {
        void runtime.cancel(turnId, undefined, sys).catch(() => undefined);
      };
      ctx.signal?.addEventListener("abort", onCancel, { once: true });
      const askerKey = identityKey(input.asker);
      let unwatch: (() => void) | undefined;
      try {
        if (deps.bargeIn !== undefined) {
          unwatch = await deps.bargeIn(input.conversationId, input.ownerExecutionId, {
            onMessage: () => ctl.abort(),
            isKnown: (id) => input.known.includes(id) || id === input.id,
            // Only the SAME asker's own signed message interrupts their turn.
            accept: (m: StoredInboxMessage) => {
              const p = m.payload as Record<string, unknown> | null;
              if (p === null || typeof p !== "object" || p.kind !== "user") return false;
              const { sig, ...body } = p;
              const asker = parseIdentity(p.asker);
              return (
                asker !== undefined &&
                identityKey(asker) === askerKey &&
                verifySignature(deps.key, body, sig)
              );
            },
            idOf: (m) => {
              const id = (m.payload as { id?: unknown } | null)?.id;
              return typeof id === "string" ? id : undefined;
            },
          });
        }
        const principal = await (deps.principalFor?.(input.asker) ?? {
          actor: input.asker.actor,
          ...(input.asker.tenant !== undefined && { tenant: input.asker.tenant }),
          ...(input.asker.onBehalfOf !== undefined && { onBehalfOf: input.asker.onBehalfOf }),
        });
        return await withTurnScope(
          input.conversationId,
          input.turn,
          ctl.signal,
          async (): Promise<TurnResult> => {
            const out = await runTurnExecution(runtime, deps.turnFlow, turnId, input, principal);
            return { ...out, turnExecutionId: turnId };
          },
          undefined,
          askerKey
        );
      } finally {
        ctx.signal?.removeEventListener("abort", onCancel);
        unwatch?.();
        deps.signals.delete(turnId);
      }
    },
    // Re-running it is safe: the turn execution is found by its deterministic id.
    { idempotent: true }
  );
}

async function runTurnExecution(
  runtime: WorkflowRuntime,
  turnFlow: RegisteredFlow<TurnInput, Omit<TurnResult, "turnExecutionId">>,
  turnId: string,
  input: TurnInput,
  principal: PrincipalChain
): Promise<Omit<TurnResult, "turnExecutionId">> {
  const sys = runtime.systemOptions();
  const failed = (
    reason: NonNullable<TurnResult["reason"]>
  ): Omit<TurnResult, "turnExecutionId"> => ({
    status: "failed",
    content: "",
    tools: [],
    reason,
    errorId: `err-${fnv1a64(turnId)}`,
  });
  try {
    let state = await runtime.loadState(turnId, sys);
    if (state === null) {
      const handle = await runtime.start(
        turnFlow,
        {
          conversationId: input.conversationId,
          turn: input.turn,
          ord: input.ord,
          asker: input.asker,
          text: input.text,
          history: input.history,
          known: [],
        },
        { executionId: turnId, principal }
      );
      state = await handle.waitForCompletion();
    } else if (!TERMINAL.has(state.status)) {
      // The process died mid-turn: continue THE SAME execution (its log, its principal).
      state = await (await runtime.restoreFromState(state)).waitForCompletion();
    }
    if (state.status === "completed") {
      return state.variables._output as Omit<TurnResult, "turnExecutionId">;
    }
    return failed(state.status === "cancelled" ? "cancelled" : "turn-failed");
  } catch {
    return failed("turn-failed");
  }
}

/** Register the turn effect on `effects` under `effectId`. */
export function registerSharedTurnEffect(
  effects: EffectRuntime,
  effectId: string,
  deps: TurnEffectDeps
): void {
  effects.register(effectId, sharedTurnEffect(deps) as never);
}
