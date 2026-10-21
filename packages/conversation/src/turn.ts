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
import type { EventStore } from "@loom/event-runtime";
import { readRangeOf } from "@loom/event-runtime";
import type { RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { z } from "zod";
import {
  ENVELOPE_DOMAIN,
  type Identity,
  identityKey,
  identityOf,
  parseIdentity,
  sameIdentity,
  sign,
  verifySignature,
} from "./access";
import type { BargeInSource, StoredInboxMessage } from "./bargeIn";
import { withTurnScope } from "./hub";
import { isProviderError } from "./providerError";
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
  /** The memory scope this turn recalled from / wrote to, when the agent has a memory. */
  memoryScope?: string;
  /** The execution that ran the turn. */
  turnExecutionId: string;
}

/**
 * The turn execution's id: deterministic (a recovery finds the same execution) and UNGUESSABLE: the tail is
 * an HMAC of the conversation and ordinal under the host's key. A predictable id let anyone who can start an
 * execution plant one first and have the conversation adopt it (a forged answer, or a refusal to run).
 */
export const turnExecutionId = (conversationId: string, ord: number, key: string): string =>
  `turn:${conversationId}:o${ord}:${sign(key, { conversationId, ord, purpose: "turn-id" }).slice(0, 24)}`;

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
    // Memory is PER ASKER: the scope comes from the asker, never from a constant the host wrote once.
    const scope = config.shared?.memoryScope?.(input.asker);
    const wb = config.agent.writeBack;
    try {
      const out = await agentLoop$(
        ctx,
        {
          ...config.agent,
          loopId: "turn",
          ...(signal !== undefined && { signal }),
          ...(scope !== undefined && { memoryScope: scope }),
          ...(scope !== undefined &&
            typeof wb === "object" &&
            wb !== null && { writeBack: { ...wb, scope } }),
        },
        { prompt: input.text, promptOrigin: USER_ORIGIN, history: input.history }
      );
      return {
        status: "complete",
        content: out.content,
        tools: out.toolCallLog.map((s) => s.toolName),
        ...(config.agent.memory !== undefined && scope !== undefined && { memoryScope: scope }),
      };
    } catch (e) {
      if (e instanceof TypedFailure && e.channel === AGENT_INTERRUPTED) {
        const run = e.payload as InterruptedAgentRun;
        return {
          status: "interrupted",
          content: run.content ?? "",
          tools: (run.toolCallLog ?? []).map((s) => s.toolName),
          ...(config.agent.memory !== undefined && scope !== undefined && { memoryScope: scope }),
        };
      }
      if (!isProviderError(e) && isTerminalToolError(e)) {
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
  /** Where the turn execution's recorded start is verified before it is adopted. */
  eventStore: EventStore;
  /** The host's log of the real error behind a failed turn. */
  onError?: ConversationConfig["onError"];
  turnFlow: RegisteredFlow<TurnInput, Omit<TurnResult, "turnExecutionId">>;
  signals: Map<string, AbortSignal>;
  key: string;
  /** Keys still accepted for VERIFICATION during a rotation window. */
  previousKeys?: readonly string[];
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
      const turnId = turnExecutionId(input.conversationId, input.ord, deps.key);
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
            // Only the SAME asker's own signed message, for THIS conversation, interrupts their turn.
            accept: (m: StoredInboxMessage) => {
              const p = m.payload as Record<string, unknown> | null;
              if (p === null || typeof p !== "object" || p.kind !== "user") return false;
              const { sig, ...body } = p;
              const asker = parseIdentity(p.asker);
              return (
                asker !== undefined &&
                identityKey(asker) === askerKey &&
                p.conversationId === input.conversationId &&
                verifySignature(
                  [deps.key, ...(deps.previousKeys ?? [])],
                  body,
                  sig,
                  ENVELOPE_DOMAIN
                )
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
            const out = await runTurnExecution(deps, turnId, input, principal);
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

/**
 * An execution already living under the turn's id is ADOPTED only if it is provably the one this turn
 * would have started: our flow, started as THIS asker (the principal the kernel recorded), on THIS
 * conversation, ordinal, message and text. Anything else is refused, never continued: continuing it would
 * serve whatever its starter wanted as the participant's answer.
 */
async function adoptable(
  deps: TurnEffectDeps,
  turnId: string,
  input: TurnInput,
  principal: PrincipalChain
): Promise<boolean> {
  const first = (await readRangeOf(deps.eventStore, turnId, 0, 0))[0];
  if (first === undefined) return false;
  if (first.workflowId !== deps.turnFlow.definition.id) return false;
  const payload = first.payload as {
    input?: Partial<TurnInput>;
    principal?: { identity?: unknown };
  } | null;
  const recorded = parseIdentity(payload?.principal?.identity);
  const expected = identityOf(principal);
  if (recorded === undefined || expected === undefined || !sameIdentity(recorded, expected))
    return false;
  const started = payload?.input;
  const a = started?.asker === undefined ? undefined : parseIdentity(started.asker);
  return (
    started?.conversationId === input.conversationId &&
    started.ord === input.ord &&
    started.turn === input.turn &&
    started.text === input.text &&
    started.id === input.id &&
    a !== undefined &&
    sameIdentity(a, input.asker)
  );
}

async function runTurnExecution(
  deps: TurnEffectDeps,
  turnId: string,
  input: TurnInput,
  principal: PrincipalChain
): Promise<Omit<TurnResult, "turnExecutionId">> {
  const { runtime, turnFlow } = deps;
  const sys = runtime.systemOptions();
  const errorId = `err-${fnv1a64(turnId)}`;
  const failed = (
    reason: NonNullable<TurnResult["reason"]>,
    cause?: unknown
  ): Omit<TurnResult, "turnExecutionId"> => {
    // The user sees the fixed reason; the host gets the cause (the first cut swallowed it).
    deps.onError?.(errorId, cause ?? new Error(`turn execution ${reason}`), {
      conversationId: input.conversationId,
      turn: input.turn,
    });
    return { status: "failed", content: "", tools: [], reason, errorId };
  };
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
          ...(input.id !== undefined && { id: input.id }),
          history: input.history,
          known: [],
        },
        { executionId: turnId, principal }
      );
      state = await handle.waitForCompletion();
    } else {
      if (!(await adoptable(deps, turnId, input, principal))) {
        return failed(
          "turn-failed",
          new Error(`refused to adopt a foreign execution at "${turnId}"`)
        );
      }
      if (!TERMINAL.has(state.status)) {
        // The process died mid-turn: continue THE SAME execution (its log, its principal).
        state = await (await runtime.restoreFromState(state)).waitForCompletion();
      }
    }
    if (state.status === "completed") {
      return state.variables._output as Omit<TurnResult, "turnExecutionId">;
    }
    return failed(state.status === "cancelled" ? "cancelled" : "turn-failed");
  } catch (err) {
    return failed("turn-failed", err);
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
