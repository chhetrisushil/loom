import {
  AGENT_INTERRUPTED,
  type AgentHistoryMessage,
  type InterruptedAgentRun,
  agentLoop$,
  continueEvery,
  isTerminalToolError,
} from "@loom/agent";
import { unwrapTainted } from "@loom/classify";
import { TypedFailure, flow$ } from "@loom/core";
import type { ExecutionContext, FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";
import { type BudgetVerdict, fitToWindow } from "./budget";
import { withTurnScope } from "./hub";
import { conversationIdOf } from "./ids";
import {
  CONVERSATION_TOPIC,
  type CarriedTurn,
  type ConversationCarry,
  type ConversationConfig,
  type ConversationResult,
  type MessageRecord,
  type MessageStatus,
  RECORD_SOURCE,
  SUMMARY_ORIGIN,
  type TurnEnvelope,
  USER_ORIGIN,
} from "./types";

// ── conversation$: a durable dialogue as ONE chained execution (ADR 0122) ────────────────────────
//
//   idle:     parked on the inbox (`ctx.receive`) — costs nothing, survives a restart
//   a turn:   the user's message is consumed, the prompt is fitted to the token budget (a RECORDED
//             decision), `agentLoop$` answers it, the reply is recorded as a durable event
//   barge-in: while a turn runs, the NEXT inbox message is already being waited on; when it lands
//             the turn's AbortSignal fires. `agentLoop$` stops at its next recorded checkpoint with
//             AGENT_INTERRUPTED, the partial is kept as an `interrupted` reply, and the loop goes on
//             with the new message. The execution is never cancelled.
//   rotation: every `rotateEveryTurns` the flow `continueAsNew`s, carrying the summary and the
//             bounded window, so the fold and the log of any one generation stay bounded.
//
// Everything non-deterministic is already a recorded fact by the time this body re-runs: the inbox
// message is a `MESSAGE_CONSUMED`, the budget verdict a decision, the summary and the model calls
// frames, the abort checkpoints decisions. The body adds no clock, no random, no I/O of its own.

const DEFAULTS = {
  rotateEveryTurns: 100,
  maxTurnChars: 32_000,
  maxReplyChars: 64_000,
  maxWindowTurns: 64,
  maxCarryBytes: 256 * 1024,
  maxSummaryChars: 16_000,
} as const;
const MAX_RECENT_IDS = 256;

const UTF8 = new TextEncoder();

function positive(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v < 1) {
    throw new RangeError(`conversation$: ${name} must be a positive integer (got ${String(v)})`);
  }
}

export function parseEnvelope(value: unknown): TurnEnvelope | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const o = value as Record<string, unknown>;
  const id = typeof o.id === "string" && o.id.length <= 256 ? { id: o.id } : {};
  if (o.kind === "close") return { kind: "close", ...id };
  if (o.kind === "user" && typeof o.text === "string") return { kind: "user", text: o.text, ...id };
  return undefined;
}

const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max)}…`);

function emptyCarry(): ConversationCarry {
  return { v: 1, seq: 0, ord: 0, turns: [] };
}

function carryOf(input: unknown): ConversationCarry {
  if (typeof input !== "object" || input === null) return emptyCarry();
  const c = input as Partial<ConversationCarry>;
  if (c.v !== 1) return emptyCarry();
  return {
    v: 1,
    seq: typeof c.seq === "number" ? c.seq : 0,
    ord: typeof c.ord === "number" ? c.ord : 0,
    ...(typeof c.summary === "string" && { summary: c.summary }),
    ...(Array.isArray(c.ids) && { ids: c.ids.filter((x): x is string => typeof x === "string") }),
    turns: Array.isArray(c.turns) ? (c.turns as CarriedTurn[]) : [],
    ...(c.pending !== undefined && { pending: c.pending }),
  };
}

/** The earlier turns as the loop's history: the summary first, then whole turns, oldest first. */
function historyOf(
  summary: string | undefined,
  turns: readonly CarriedTurn[]
): AgentHistoryMessage[] {
  const out: AgentHistoryMessage[] = [];
  if (summary !== undefined && summary !== "") {
    out.push({
      role: "user",
      content: `Summary of the earlier conversation: ${summary}`,
      origin: SUMMARY_ORIGIN,
    });
  }
  for (const t of turns) {
    out.push({ role: "user", content: t.user, origin: USER_ORIGIN });
    if (t.assistant !== undefined && t.assistant !== "") {
      out.push({ role: "assistant", content: t.assistant });
    }
  }
  return out;
}

/**
 * The flow body of a conversation. Register it with {@link conversation$} (which also builds the
 * definition) or call it from your own runner.
 */
export function conversationRunner(
  config: ConversationConfig
): FlowRunner<ConversationCarry | Record<string, never>, ConversationResult> {
  const rotateEvery = config.rotateEveryTurns ?? DEFAULTS.rotateEveryTurns;
  const maxTurnChars = config.maxTurnChars ?? DEFAULTS.maxTurnChars;
  const maxReplyChars = config.maxReplyChars ?? DEFAULTS.maxReplyChars;
  const maxWindowTurns = config.maxWindowTurns ?? DEFAULTS.maxWindowTurns;
  const maxCarryBytes = config.maxCarryBytes ?? DEFAULTS.maxCarryBytes;
  positive("rotateEveryTurns", rotateEvery);
  positive("maxTurnChars", maxTurnChars);
  positive("maxReplyChars", maxReplyChars);
  positive("maxWindowTurns", maxWindowTurns);
  positive("maxCarryBytes", maxCarryBytes);
  if ((config.agent as { requireApproval?: unknown }).requireApproval !== undefined) {
    throw new Error(
      "conversation$: `requireApproval` is not supported (a parked approval cannot coexist with the barge-in watcher); gate tools with the effect authorizer"
    );
  }
  for (const k of ["signal", "loopId"] as const) {
    if ((config.agent as Record<string, unknown>)[k] !== undefined) {
      throw new Error(`conversation$: agent.${k} is owned by the conversation`);
    }
  }
  const budget = config.budget;
  if (budget !== undefined && !(budget.contextWindow > 0)) {
    throw new RangeError("conversation$: budget.contextWindow must be a positive number");
  }
  const toolText = config.agent.definition.tools
    .map((t) => `${t.name} ${t.description}`)
    .join("\n");
  const systemForCount = [config.agent.systemPrompt, toolText].filter((s) => !!s).join("\n");

  return async (ctx: ExecutionContext, input) => {
    const conversationId = conversationIdOf(ctx.executionId);
    const carry = carryOf(input);
    let seq = carry.seq;
    /** Messages consumed so far (accepted or not): the id space of every recorded fact, never reused. */
    let ord = carry.ord;
    let summary = carry.summary;
    let turns: CarriedTurn[] = carry.turns.slice();
    let pending: unknown = carry.pending;
    /** Idempotency keys of recent turns, oldest first: what a barge-in watcher must NOT treat as new. */
    const ids: string[] = (carry.ids ?? []).slice(-MAX_RECENT_IDS);
    const known = new Set(ids);
    const remember = (id: string | undefined): void => {
      if (id === undefined || known.has(id)) return;
      known.add(id);
      ids.push(id);
      if (ids.length > MAX_RECENT_IDS) known.delete(ids.shift() as string);
    };
    let rotateDue = false;
    const counter = continueEvery(rotateEvery);

    /**
     * Record a fact exactly once (a decision under a deterministic id; see {@link RECORD_SOURCE}).
     * `live` runs only when the fact is NEW (a decider never runs for a recorded one).
     */
    const record = async (
      id: string,
      rec: MessageRecord,
      live?: () => Promise<void>
    ): Promise<void> => {
      await ctx.decide(
        `conv#o${ord}:${id}`,
        async () => {
          await live?.();
          return rec;
        },
        { source: RECORD_SOURCE }
      );
    };

    for (;;) {
      // Idle: the next message is either one already consumed (a rotation's `pending`) or a wait.
      // This is the ONLY place the execution parks.
      const raw: unknown = pending !== undefined ? pending : await ctx.receive(CONVERSATION_TOPIC);
      pending = undefined;
      const env = parseEnvelope(unwrapTainted(raw));

      if (env?.kind === "close") {
        await ctx.decide("conv#closed", () => ({ kind: "closed", turns: seq }), {
          source: RECORD_SOURCE,
        });
        return { conversationId, turns: seq, closed: true };
      }

      // Rotation sits BETWEEN consuming a message and starting its turn: no wait is outstanding
      // here, which `continueAsNew` requires. The consumed message rides
      // the carry, so the successor handles it first and the inbox cursor never re-delivers it.
      if (rotateDue) {
        return ctx.continueAsNew(
          trimCarry(
            { v: 1, seq, ord, ids, ...(summary !== undefined && { summary }), turns, pending: raw },
            maxCarryBytes
          )
        );
      }

      ord++;
      remember(env?.id);
      if (env === undefined || env.text.trim() === "") {
        await record("user", {
          turn: seq + 1,
          role: "user",
          text: "",
          status: "rejected",
          reason: "malformed",
        });
        continue;
      }
      if (env.text.length > maxTurnChars) {
        await record("user", {
          turn: seq + 1,
          role: "user",
          text: "",
          status: "rejected",
          reason: "too-long",
        });
        continue;
      }

      const ctl = new AbortController();

      // ── the token budget: a recorded verdict, then the (deterministic) eviction ────────────────
      const overflow = Math.max(0, turns.length - maxWindowTurns);
      let dropCount = overflow;
      if (budget !== undefined) {
        const view = turns.slice(overflow);
        const verdict = await ctx.decide<BudgetVerdict>(
          `conv#fit:${ord}`,
          () =>
            fitToWindow({
              contextWindow: budget.contextWindow,
              ...(budget.reserveOutputTokens !== undefined && {
                reserveOutputTokens: budget.reserveOutputTokens,
              }),
              ...(systemForCount !== "" && { system: systemForCount }),
              ...(summary !== undefined && { summary }),
              prompt: env.text,
              turns: view.map((t) => ({
                user: t.user,
                ...(t.assistant !== undefined && { assistant: t.assistant }),
                ...(t.tokens !== undefined && { tokens: t.tokens }),
              })),
              ...(budget.counter !== undefined && { counter: budget.counter }),
            }),
          { source: "conversation-budget" }
        );
        if (!verdict.ok) {
          // The message does not fit even alone: refused, never sent to the model, not a turn.
          await record("user", {
            turn: seq + 1,
            role: "user",
            text: "",
            status: "rejected",
            reason: "prompt-too-large",
          });
          continue;
        }
        for (const [i, tokens] of verdict.counted) {
          const t = view[i];
          if (t !== undefined) t.tokens = tokens;
        }
        dropCount = overflow + (view.length - verdict.keep);
      }
      const n = ++seq;
      // The barge-in watch starts when the turn goes LIVE: this decider runs only for a new turn, and
      // the provider wrapper starts it for a recovered one whose model call re-runs. A turn replayed
      // from the log (every wake re-runs the whole generation) never subscribes to anything.
      let watching: Promise<() => void> | undefined;
      const ensureWatch = (): Promise<() => void> => {
        if (watching === undefined) {
          watching = Promise.resolve(
            config.bargeIn?.(conversationId, ctx.executionId, {
              onMessage: () => ctl.abort(),
              isKnown: (id) => known.has(id),
            }) ?? (() => undefined)
          );
        }
        return watching;
      };
      await record(
        "user",
        { turn: n, role: "user", text: env.text, status: "complete" },
        async () => {
          await ensureWatch();
        }
      );
      if (dropCount > 0) {
        const dropped = turns.slice(0, dropCount);
        turns = turns.slice(dropCount);
        if (budget?.summarizerToolId !== undefined) {
          const messages = [
            ...(summary !== undefined && summary !== ""
              ? [{ role: "user", content: `Summary so far: ${summary}` }]
              : []),
            ...dropped.flatMap((t) => [
              { role: "user", content: t.user },
              ...(t.assistant ? [{ role: "assistant", content: t.assistant }] : []),
            ]),
          ];
          const out = (await ctx.execute(
            {
              _tag: "TaskDefinition",
              kind: "memory",
              id: `conv#o${ord}:summarize`,
              toolId: budget.summarizerToolId,
            },
            { messages }
          )) as { summary?: unknown };
          if (typeof out?.summary === "string") {
            summary = clip(out.summary, DEFAULTS.maxSummaryChars);
          }
        }
      }

      // ── the turn ──────────────────────────────────────────────────────────────────────────────
      let reply = "";
      let status: MessageStatus = "complete";
      let reason: string | undefined;
      try {
        const out = await withTurnScope(
          conversationId,
          n,
          ctl.signal,
          () =>
            agentLoop$(
              ctx,
              { ...config.agent, loopId: `conv#o${ord}`, signal: ctl.signal },
              {
                prompt: env.text,
                promptOrigin: USER_ORIGIN,
                history: historyOf(summary, turns),
              }
            ),
          ensureWatch
        );
        reply = clip(out.content, maxReplyChars);
      } catch (e) {
        if (e instanceof TypedFailure && e.channel === AGENT_INTERRUPTED) {
          status = "interrupted";
          reply = clip((e.payload as InterruptedAgentRun).content ?? "", maxReplyChars);
        } else if (isTerminalToolError(e)) {
          throw e; // a park, an authority/safety stop, a cancel, a replay divergence: not a failed turn
        } else {
          status = "failed";
          reason = clip(e instanceof Error ? `${e.name}: ${e.message}` : String(e), 500);
        }
      } finally {
        // Host-side, not a `ctx` operation: it can only fire the signal, which the loop reads
        // through its recorded checkpoints.
        if (watching !== undefined) (await watching.catch(() => () => undefined))();
      }
      await record("reply", {
        turn: n,
        role: "assistant",
        text: reply,
        status,
        ...(reason !== undefined && { reason }),
      });
      turns.push({ n, user: env.text, assistant: reply, status });
      hubEnd(config, conversationId, n);
      if (counter.turn()) rotateDue = true;
    }
  };
}

function hubEnd(config: ConversationConfig, conversationId: string, turn: number): void {
  config.hub?.endTurn(conversationId, turn);
}

/** Keep the carry under `maxBytes` by dropping the oldest turns (deterministic: a function of the carry). */
function trimCarry(carry: ConversationCarry, maxBytes: number): ConversationCarry {
  let size = UTF8.encode(JSON.stringify(carry)).length;
  if (size <= maxBytes) return carry;
  const turns = carry.turns.slice();
  while (turns.length > 0 && size > maxBytes) {
    const gone = turns.shift() as CarriedTurn;
    size -= UTF8.encode(JSON.stringify(gone)).length + 1;
  }
  return { ...carry, turns };
}

export interface ConversationFlowOptions {
  /** The flow id (default `"conversation"`). */
  id?: string;
  name?: string;
  version?: string;
}

/**
 * Build the registered flow of a conversation. Register it on the runtime
 * (`runtime.registerFlow(flow.definition, flow.runner)`) and drive it with {@link createConversations}.
 * Needs `kernel.features.inbox` and `kernel.features.continueAsNew` on the runtime.
 */
export function conversation$(
  config: ConversationConfig,
  options: ConversationFlowOptions = {}
): RegisteredFlow<ConversationCarry | Record<string, never>, ConversationResult> {
  const definition = flow$({
    id: options.id ?? "conversation",
    name: options.name ?? "Conversation",
    version: options.version ?? "1.0.0",
    inputSchema: z.any(),
    outputSchema: z.any(),
    steps: [],
  });
  return { definition, runner: conversationRunner(config) } as RegisteredFlow<
    ConversationCarry | Record<string, never>,
    ConversationResult
  >;
}
