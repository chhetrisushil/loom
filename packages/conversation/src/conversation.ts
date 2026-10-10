import {
  AGENT_INTERRUPTED,
  type AgentHistoryMessage,
  type InterruptedAgentRun,
  agentLoop$,
  continueEvery,
  isTerminalToolError,
} from "@loom/agent";
import { tainted, unwrapTainted } from "@loom/classify";
import { TypedFailure, flow$, fnv1a64 } from "@loom/core";
import type { ExecutionContext, FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
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
import {
  type BudgetVerdict,
  fitWithSummaryFallback,
  heuristicTokenCounter,
  truncateToTokens,
} from "./budget";
import { withTurnScope } from "./hub";
import { conversationIdOf } from "./ids";
import {
  type TurnInput,
  type TurnResult,
  registerSharedTurnEffect,
  sharedTurnEffect,
  sharedTurnFlow,
} from "./turn";
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
const MAX_RECENT_IDS = 1024;
const MAX_KNOWN_FOR_WATCH = 256;
const MAX_CLOCK_SKEW_MS = 60_000;
const MAX_CLASSES = 16;
const EDIT_QUOTE_CHARS = 500;
const MAX_CLASS_LEN = 64;
const STATUSES = new Set<MessageStatus>(["complete", "interrupted", "failed", "rejected"]);

const UTF8 = new TextEncoder();

function positive(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v < 1) {
    throw new RangeError(`conversation$: ${name} must be a positive integer (got ${String(v)})`);
  }
}

export type EnvelopeRefusal = "malformed" | "unauthenticated";

/**
 * Both modes: an envelope is acted on only if the host's client SIGNED it, for THIS conversation, with an
 * issue time and an id (the replay set's key). The signature covers every field, so none can be lifted
 * from one message into another.
 */
export function parseSignedEnvelope(
  value: unknown,
  keys: string | readonly string[],
  conversationId: string
): { env?: TurnEnvelope; reason?: EnvelopeRefusal } {
  if (typeof value !== "object" || value === null) return { reason: "malformed" };
  const { sig, ...body } = value as Record<string, unknown>;
  if (!verifySignature(keys, body, sig, ENVELOPE_DOMAIN)) return { reason: "unauthenticated" };
  if (body.conversationId !== conversationId) return { reason: "unauthenticated" };
  const id = body.id;
  const iat = body.iat;
  if (typeof id !== "string" || id.length === 0 || id.length > 256) return { reason: "malformed" };
  if (typeof iat !== "number" || !Number.isFinite(iat)) return { reason: "malformed" };
  let asker: Identity | undefined;
  if (body.asker !== undefined) {
    asker = parseIdentity(body.asker);
    if (asker === undefined) return { reason: "malformed" };
  }
  const who = asker === undefined ? {} : { asker };
  if (body.kind === "close") return { env: { kind: "close", id, iat, ...who } };
  if (body.kind === "user" && typeof body.text === "string") {
    let editOf: number | undefined;
    if (body.editOf !== undefined) {
      if (typeof body.editOf !== "number" || !Number.isSafeInteger(body.editOf) || body.editOf < 1)
        return { reason: "malformed" };
      editOf = body.editOf;
    }
    return {
      env: {
        kind: "user",
        text: body.text,
        id,
        iat,
        ...who,
        ...(editOf !== undefined && { editOf }),
      },
    };
  }
  return { reason: "malformed" };
}

/** What the client signs / the body checks (the envelope without its signature). */
export function signedEnvelope(
  key: string,
  body: Record<string, unknown>
): Record<string, unknown> {
  return { ...body, sig: sign(key, body, ENVELOPE_DOMAIN) };
}

const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max)}…`);

function emptyCarry(): ConversationCarry {
  return { v: 1, seq: 0, ord: 0, turns: [] };
}

const safeInt = (v: unknown): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;

/**
 * The start input is the owner's, but it is read like any untrusted JSON: shape, counts and bytes are
 * all bounded here, so a malformed or oversized input can neither crash the body nor inflate the window.
 */
export function carryOf(
  input: unknown,
  lim: { turns: number; turnChars: number; replyChars: number; summaryChars: number; bytes: number }
): ConversationCarry {
  if (typeof input !== "object" || input === null) return emptyCarry();
  const c = input as Record<string, unknown>;
  if (c.v !== 1) return emptyCarry();
  const turns: CarriedTurn[] = [];
  for (const t of Array.isArray(c.turns) ? c.turns : []) {
    if (typeof t !== "object" || t === null) continue;
    const o = t as Record<string, unknown>;
    if (typeof o.user !== "string" || !STATUSES.has(o.status as MessageStatus)) continue;
    const asker = parseIdentity(o.asker);
    const classes = Array.isArray(o.classes)
      ? o.classes
          .filter((x): x is string => typeof x === "string" && x.length <= MAX_CLASS_LEN)
          .slice(0, MAX_CLASSES)
      : undefined;
    turns.push({
      n: safeInt(o.n),
      ...(typeof o.ord === "number" && Number.isSafeInteger(o.ord) && o.ord >= 1 && { ord: o.ord }),
      user: clip(o.user, lim.turnChars),
      ...(typeof o.assistant === "string" && { assistant: clip(o.assistant, lim.replyChars) }),
      status: o.status as MessageStatus,
      ...(typeof o.tokens === "number" &&
        Number.isFinite(o.tokens) &&
        o.tokens >= 0 && { tokens: o.tokens }),
      ...(asker !== undefined && { asker }),
      ...(classes !== undefined && classes.length > 0 && { classes }),
    });
  }
  const owner = parseIdentity(c.owner);
  const rawIds = Array.isArray(c.ids) ? c.ids : [];
  const rawIats = Array.isArray(c.iats) ? c.iats : [];
  const iatOfId = new Map<string, number>();
  const idsKept: string[] = [];
  rawIds.forEach((x, i) => {
    if (typeof x !== "string" || x.length > 256) return;
    idsKept.push(x);
    const t = rawIats[i];
    iatOfId.set(x, typeof t === "number" && Number.isFinite(t) ? t : 0);
  });
  idsKept.splice(0, Math.max(0, idsKept.length - MAX_RECENT_IDS));
  const carry: ConversationCarry = {
    v: 1,
    seq: safeInt(c.seq),
    ord: safeInt(c.ord),
    ...(safeInt(c.rec) > 0 && { rec: safeInt(c.rec) }),
    dropped: safeInt(c.dropped),
    ...(owner !== undefined && { owner }),
    ...(typeof c.summary === "string" && { summary: clip(c.summary, lim.summaryChars) }),
    ids: idsKept,
    iats: idsKept.map((id) => iatOfId.get(id) ?? 0),
    floor: typeof c.floor === "number" && Number.isFinite(c.floor) && c.floor >= 0 ? c.floor : 0,
    turns: turns.slice(-lim.turns),
    ...(c.pending !== undefined && { pending: c.pending }),
  };
  return trimCarry(carry, lim.bytes);
}

const PLACEHOLDER = {
  interrupted: "(interrupted)",
  failed: "(no reply: the request failed)",
  rejected: "(no reply)",
  complete: "(no reply)",
  restricted: "(no reply)",
} as const;

/**
 * The earlier turns as the loop's history: the summary first, then whole turns, oldest first. Roles
 * ALTERNATE: a turn with no reply text (interrupted before any, failed) gets a placeholder assistant
 * message, and the summary a short acknowledgement, so no provider that rejects consecutive user
 * messages is ever sent two in a row.
 */
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
    out.push({ role: "assistant", content: "(earlier conversation summarized above)" });
  }
  for (const t of turns) {
    out.push({ role: "user", content: t.user, origin: USER_ORIGIN });
    out.push({
      role: "assistant",
      content:
        t.assistant !== undefined && t.assistant !== "" ? t.assistant : PLACEHOLDER[t.status],
    });
  }
  return out;
}

const union = (...lists: (readonly string[] | undefined)[]): string[] =>
  [...new Set(lists.flatMap((l) => l ?? []))].sort();

/**
 * The flow body of a conversation. Register it with {@link conversation$} (which also builds the
 * definition) or call it from your own runner.
 */
export function conversationRunner(
  config: ConversationConfig,
  shared?: { turnEffectId: string }
): FlowRunner<ConversationCarry | Record<string, never>, ConversationResult> {
  const rotateEvery = config.rotateEveryTurns ?? DEFAULTS.rotateEveryTurns;
  const maxTurnChars = config.maxTurnChars ?? DEFAULTS.maxTurnChars;
  const maxReplyChars = config.maxReplyChars ?? DEFAULTS.maxReplyChars;
  const maxWindowTurns = config.maxWindowTurns ?? DEFAULTS.maxWindowTurns;
  const maxCarryBytes = config.maxCarryBytes ?? DEFAULTS.maxCarryBytes;
  const maxEnvelopeAge = config.maxEnvelopeAgeMs ?? 60 * 60_000;
  const maxInvalid = config.maxInvalidRecords ?? 50;
  if (typeof config.key !== "string" || config.key.length < 8) {
    throw new Error(
      "conversation$: `key` (the host's envelope-signing secret, at least 8 characters) is required"
    );
  }
  positive("rotateEveryTurns", rotateEvery);
  positive("maxTurnChars", maxTurnChars);
  positive("maxReplyChars", maxReplyChars);
  positive("maxWindowTurns", maxWindowTurns);
  positive("maxCarryBytes", maxCarryBytes);
  for (const k of ["requireApproval", "needsApproval"] as const) {
    if ((config.agent as Record<string, unknown>)[k] === undefined) continue;
    throw new Error(
      `conversation$: \`${k}\` is not supported (a parked approval cannot coexist with the barge-in watcher); gate tools with the effect authorizer`
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
  const sharedCfg = config.shared;
  if (sharedCfg !== undefined) {
    const wb = config.agent.writeBack;
    if (wb !== undefined && wb !== false && (typeof wb !== "object" || wb.toolId === undefined)) {
      throw new Error(
        "conversation$ (shared): `agent.writeBack` must go through an effect (`toolId`): a direct write would not be the asker's"
      );
    }
    if (typeof sharedCfg.cleared !== "function") {
      throw new Error("conversation$ (shared): `shared.cleared` is required (fail closed)");
    }
    if (identityOf(sharedCfg.servicePrincipal) === undefined) {
      throw new Error(
        "conversation$ (shared): `shared.servicePrincipal` (a principal with an actor) is required: it owns the coordinating execution"
      );
    }
    const a = config.agent;
    if (a.memoryScope !== undefined) {
      throw new Error(
        "conversation$ (shared): a constant `agent.memoryScope` would hand one participant's memory to every other; give `shared.memoryScope(asker)` instead"
      );
    }
    if (typeof wb === "object" && wb !== null && wb.scope !== undefined) {
      throw new Error(
        "conversation$ (shared): `agent.writeBack.scope` must come from `shared.memoryScope(asker)`"
      );
    }
    if (a.memory !== undefined && typeof sharedCfg.memoryScope !== "function") {
      throw new Error(
        "conversation$ (shared): `agent.memory` needs `shared.memoryScope(asker)` (a per-asker scope)"
      );
    }
  }
  const counter = budget?.counter ?? heuristicTokenCounter();
  const maxSummaryTokens =
    budget === undefined ? 0 : (budget.maxSummaryTokens ?? Math.floor(budget.contextWindow / 4));
  const toolText = config.agent.definition.tools
    .map((t) => `${t.name} ${t.description}`)
    .join("\n");
  const systemForCount = [config.agent.systemPrompt, toolText].filter((s) => !!s).join("\n");

  return async (ctx: ExecutionContext, input) => {
    const conversationId = conversationIdOf(ctx.executionId);
    const carry = carryOf(input, {
      turns: maxWindowTurns,
      turnChars: maxTurnChars,
      replyChars: maxReplyChars,
      summaryChars: DEFAULTS.maxSummaryChars,
      bytes: maxCarryBytes,
    });
    let seq = carry.seq;
    /** Rejected envelopes so far: recorded up to `maxInvalidRecords`, then only counted. */
    let droppedCount = carry.dropped ?? 0;
    /** Messages consumed so far (accepted or not): the id space of every recorded fact, never reused. */
    let ord = carry.ord;
    /** Transcript records written so far (the unique `ord` of each record; carried across rotations). */
    let rec = carry.rec ?? 0;
    let summary = carry.summary;
    let turns: CarriedTurn[] = carry.turns.slice();
    let pending: unknown = carry.pending;
    const owner = carry.owner;
    /** Idempotency keys of recent turns, oldest first: what a barge-in watcher must NOT treat as new. */
    const ids: string[] = (carry.ids ?? []).slice(-MAX_RECENT_IDS);
    /** The issue time of each remembered id (parallel to `ids`). */
    const iats: number[] = ids.map((_, i) => carry.iats?.[i] ?? 0);
    /**
     * HIGH-WATER MARK of evicted issue times. The replay set is bounded, so an id can fall out of it; the
     * guarantee that a captured envelope cannot be replayed after that is THIS floor: anything issued at or
     * before the newest evicted envelope is refused as stale, whatever the set still remembers. (An attacker
     * who floods the set can only raise the floor, never reopen an old envelope.)
     */
    let floor = carry.floor ?? 0;
    const known = new Set(ids);
    const remember = (id: string | undefined, iat = 0): void => {
      if (id === undefined || known.has(id)) return;
      known.add(id);
      ids.push(id);
      iats.push(iat);
      if (ids.length > MAX_RECENT_IDS) {
        known.delete(ids.shift() as string);
        floor = Math.max(floor, iats.shift() as number);
      }
    };
    let rotateDue = false;
    const turnsCounter = continueEvery(rotateEvery);

    /**
     * Record a fact exactly once (a decision under a deterministic id; see {@link RECORD_SOURCE}).
     * `live` runs only when the fact is NEW (a decider never runs for a recorded one).
     */
    const record = async (
      id: string,
      message: MessageRecord,
      live?: () => Promise<void>
    ): Promise<number> => {
      // The record's own ordinal, counted whether the fact is new or served from the log: the body is
      // deterministic, so a replay counts the same. The value only matters when the fact is NEW.
      const recOrd = ++rec;
      await ctx.decide(
        `conv#o${ord}:${id}`,
        async () => {
          await live?.();
          return { ...message, ord: recOrd };
        },
        { source: RECORD_SOURCE }
      );
      return recOrd;
    };
    // A rejected message is not a turn: `turn: 0`, so it can never share a number with an accepted turn.
    const reject = (reason: string, asker?: Identity): Promise<unknown> =>
      record("user", {
        turn: 0,
        role: "user",
        text: "",
        status: "rejected",
        reason,
        ...(asker !== undefined && { asker }),
      });

    /**
     * Fold `dropped` turns into the rolling summary (when a summarizer is configured): the user's words
     * go in TAINTED, the previous summary too (model output over untrusted text), and the new summary is
     * cut to `maxSummaryTokens` by a recorded decision, so it can never crowd the prompt out.
     */
    const summarize = async (dropped: readonly CarriedTurn[]): Promise<void> => {
      if (budget?.summarizerToolId === undefined) return;
      // SHARED: only unrestricted turns may be summarized. The summary reaches every participant's
      // prompt, so restricted content must never be in it (evicted restricted turns are just dropped).
      const usable = sharedCfg === undefined ? dropped : dropped.filter((t) => !t.classes?.length);
      if (usable.length === 0) return;
      const messages = [
        ...(summary !== undefined && summary !== ""
          ? [{ role: "user", content: tainted(`Summary so far: ${summary}`, SUMMARY_ORIGIN) }]
          : []),
        ...usable.flatMap((t) => [
          { role: "user", content: tainted(t.user, USER_ORIGIN) },
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
        const raw = clip(out.summary, DEFAULTS.maxSummaryChars);
        summary = await ctx.decide<string>(
          `conv#o${ord}:summary-fit`,
          () => truncateToTokens(raw, maxSummaryTokens, counter),
          { source: "conversation-budget" }
        );
      }
    };

    for (;;) {
      // Idle: the next message is either one already consumed (a rotation's `pending`) or a wait.
      // This is the ONLY place the execution parks.
      const raw: unknown = pending !== undefined ? pending : await ctx.receive(CONVERSATION_TOPIC);
      pending = undefined;
      const parsed = parseSignedEnvelope(
        unwrapTainted(raw),
        [config.key, ...(config.previousKeys ?? [])],
        conversationId
      );
      const env = parsed.env;

      // Rotation sits BETWEEN consuming a message and starting its turn: no wait is outstanding
      // here, which `continueAsNew` requires. The consumed message rides
      // the carry, so the successor handles it first and the inbox cursor never re-delivers it.
      if (rotateDue) {
        return ctx.continueAsNew(
          trimCarry(
            {
              v: 1,
              seq,
              ord,
              rec,
              ids,
              iats,
              floor,
              dropped: droppedCount,
              ...(owner !== undefined && { owner }),
              ...(summary !== undefined && { summary }),
              turns,
              pending: raw,
            },
            maxCarryBytes
          )
        );
      }

      ord++;

      // ── is this message ONE THE HOST SIGNED, for this conversation, from the right voice, once, and still fresh? ──
      // The inbox is writable by whatever the runtime's policy admits, so nothing in it is trusted until it
      // passes here. A refusal is a recorded entry (up to `maxInvalidRecords`), after that only counted.
      let invalid: string | undefined = parsed.reason;
      if (env !== undefined && invalid === undefined) {
        const id = env.id as string;
        if (known.has(id)) invalid = "replayed";
        else if ((env.iat as number) <= floor) invalid = "stale";
        else if (
          sharedCfg === undefined
            ? !(sameIdentity(env.asker, owner) || (env.asker === undefined && owner === undefined))
            : env.asker === undefined
        ) {
          // owner mode: only the OWNER's voice; shared: some asker is named (membership is judged below)
          invalid = "unauthenticated";
        } else {
          const iat = env.iat as number;
          const fresh = await ctx.decide<boolean>(
            `conv#o${ord}:fresh`,
            () => {
              const age = Date.now() - iat;
              return age <= maxEnvelopeAge && age >= -MAX_CLOCK_SKEW_MS;
            },
            { source: "conversation-access" }
          );
          if (!fresh) invalid = "stale";
          else remember(id, iat);
        }
      }
      if (invalid !== undefined) {
        droppedCount++;
        if (droppedCount <= maxInvalid) await reject(invalid);
        else if (droppedCount % 100 === 0) {
          const count = droppedCount;
          await ctx.decide(`conv#o${ord}:dropped`, () => ({ kind: "dropped", count }), {
            source: RECORD_SOURCE,
          });
        }
        continue;
      }
      const verified = env as TurnEnvelope;

      if (verified.kind === "close") {
        // SHARED: a close ends EVERYONE's conversation, so the body re-judges the "manage" rule the client
        // applies (the key alone must not be enough): the owner, the service principal, or a host manager
        // (`manageParticipants`). A plain participant may not close. Recorded verdict, so replay is stable.
        if (sharedCfg !== undefined) {
          const closer = verified.asker;
          const mayClose = await ctx.decide<boolean>(
            `conv#o${ord}:close-auth`,
            async () =>
              closer !== undefined &&
              (sameIdentity(closer, owner) ||
                sameIdentity(closer, identityOf(sharedCfg.servicePrincipal)) ||
                (await sharedCfg.manageParticipants?.(closer, conversationId)) === true),
            { source: "conversation-access" }
          );
          if (!mayClose) {
            await reject("unauthenticated", closer);
            continue;
          }
        }
        await ctx.decide("conv#closed", () => ({ kind: "closed", turns: seq }), {
          source: RECORD_SOURCE,
        });
        return { conversationId, turns: seq, closed: true };
      }
      if (verified.text.trim() === "") {
        await reject("malformed");
        continue;
      }
      const asker = verified.asker;
      const attributed = sharedCfg !== undefined ? asker : undefined;
      if (verified.text.length > maxTurnChars) {
        await reject("too-long", attributed);
        continue;
      }

      // SHARED: is the asker (still) a participant? Judged when the turn is DEQUEUED, as a recorded
      // verdict, so a participant removed while their message queued is not served.
      if (sharedCfg !== undefined && asker !== undefined) {
        const member = await ctx.decide<boolean>(
          `conv#o${ord}:member`,
          async () =>
            sameIdentity(asker, owner) ||
            (await sharedCfg.directory.list(conversationId)).some((i) => sameIdentity(i, asker)),
          { source: "conversation-access" }
        );
        if (!member) {
          await reject("not-a-participant", asker);
          continue;
        }
      }

      // EDIT: the signed `editOf` names an earlier user record. It must be a turn of this conversation that
      // was ACCEPTED (only accepted turns are in the window) and is the ASKER's own (owner mode: the owner's
      // voice is the only one admitted, so every turn in it is the owner's). Anything else is refused with
      // a fixed reason and nothing is obeyed; the reason does not say which of the cases it was.
      let edited: CarriedTurn | undefined;
      if (verified.editOf !== undefined) {
        edited = turns.find(
          (t) =>
            t.ord === verified.editOf && (sharedCfg === undefined || sameIdentity(t.asker, asker))
        );
        if (edited === undefined) {
          await reject("edit-invalid", attributed);
          continue;
        }
      }
      // The model sees the edit as DATA inside the (tainted, fenced) user text, never as an instruction.
      const promptText =
        edited === undefined
          ? verified.text
          : `[This message edits the user's earlier message ${JSON.stringify(
              clip(edited.user, EDIT_QUOTE_CHARS)
            )}.]\n\n${verified.text}`;

      const ctl = new AbortController();

      // The turns the asker's prompt may draw on. OWNER: all of them. SHARED: only the entries the ASKER
      // is cleared for (a recorded verdict), so restricted content never enters an uncleared asker's context.
      let visibleTurns = turns;
      if (sharedCfg !== undefined && asker !== undefined) {
        const verdict = await ctx.decide<boolean[]>(
          `conv#o${ord}:visible`,
          async () => {
            const cache = new Map<string, boolean>();
            return Promise.all(
              turns.map(async (t) => {
                if (!t.classes?.length || sameIdentity(t.asker, asker)) return true;
                const k = t.classes.join("\u0000");
                let ok = cache.get(k);
                if (ok === undefined) {
                  ok = (await sharedCfg.cleared(asker, t.classes)) === true;
                  cache.set(k, ok);
                }
                return ok;
              })
            );
          },
          { source: "conversation-access" }
        );
        visibleTurns = turns.filter((_, i) => verdict[i] === true);
      }

      // ── the token budget: a recorded verdict, then the (deterministic) eviction ────────────────
      const overflow = Math.max(0, turns.length - maxWindowTurns);
      let dropCount = sharedCfg === undefined ? overflow : 0;
      let promptTurns: CarriedTurn[] = turns;
      let skipSummary = false;
      const summaryForTurn = (): string | undefined => (skipSummary ? undefined : summary);
      if (sharedCfg !== undefined)
        promptTurns = visibleTurns.slice(Math.max(0, visibleTurns.length - maxWindowTurns));
      if (budget !== undefined) {
        const view = sharedCfg !== undefined ? promptTurns : turns.slice(overflow);
        const verdict = await ctx.decide<BudgetVerdict>(
          `conv#fit:${ord}`,
          () =>
            fitWithSummaryFallback({
              contextWindow: budget.contextWindow,
              ...(budget.reserveOutputTokens !== undefined && {
                reserveOutputTokens: budget.reserveOutputTokens,
              }),
              ...(systemForCount !== "" && { system: systemForCount }),
              ...(summary !== undefined && { summary }),
              prompt: promptText,
              turns: view.map((t) => ({
                user: t.user,
                ...(t.assistant !== undefined && { assistant: t.assistant }),
                ...(t.tokens !== undefined && { tokens: t.tokens }),
              })),
              counter,
            }),
          { source: "conversation-budget" }
        );
        if (!verdict.ok) {
          // The message does not fit even alone: refused, never sent to the model, not a turn.
          await reject("prompt-too-large", asker);
          continue;
        }
        if (verdict.dropSummary === true) {
          // OWNER: the summary is only this one user's, drop it. SHARED: it is everyone's, so only THIS turn goes without.
          if (sharedCfg === undefined) summary = undefined;
          else skipSummary = true;
        }
        for (const [i, tokens] of verdict.counted) {
          const t = view[i];
          if (t !== undefined) t.tokens = tokens;
        }
        if (sharedCfg !== undefined) promptTurns = view.slice(view.length - verdict.keep);
        else dropCount = overflow + (view.length - verdict.keep);
      }
      const n = ++seq;
      // The barge-in watch starts when the turn goes LIVE: this decider runs only for a new turn, and
      // the provider wrapper starts it for a recovered one whose model call re-runs. A turn replayed
      // from the log (every wake re-runs the whole generation) never subscribes to anything.
      // (SHARED mode watches inside the turn effect, for the asker's own messages only.)
      let watching: Promise<() => void> | undefined;
      const ensureWatch = (): Promise<() => void> => {
        if (watching === undefined) {
          watching =
            sharedCfg !== undefined
              ? Promise.resolve(() => undefined)
              : Promise.resolve(
                  config.bargeIn?.(conversationId, ctx.executionId, {
                    onMessage: () => ctl.abort(),
                    isKnown: (id) => known.has(id),
                  }) ?? (() => undefined)
                );
        }
        return watching;
      };
      // The question is classified by what it was ASKED AGAINST: the classes of every entry in the context
      // it was built on (known before the turn), so a question that quotes restricted content is filtered
      // like the answer is.
      const contextClasses = union(...promptTurns.map((t) => t.classes), edited?.classes);
      const userOrd = await record(
        "user",
        {
          turn: n,
          role: "user",
          text: verified.text,
          status: "complete",
          ...(edited?.ord !== undefined && { editOf: edited.ord, editOfTurn: edited.n }),
          ...(attributed !== undefined && { asker: attributed }),
          ...(contextClasses.length > 0 && { classes: contextClasses }),
        },
        async () => {
          await ensureWatch();
        }
      );
      if (dropCount > 0) {
        const dropped = turns.slice(0, dropCount);
        turns = turns.slice(dropCount);
        await summarize(dropped);
      }

      // ── the turn ──────────────────────────────────────────────────────────────────────────────
      let reply = "";
      let status: MessageStatus = "complete";
      let reason: string | undefined;
      let errorId: string | undefined;
      let failure: unknown;
      let toolNames: string[] = [];
      let turnExecutionId: string | undefined;
      let memoryScope: string | undefined;
      try {
        if (sharedCfg !== undefined && asker !== undefined) {
          const out = (await ctx.execute(
            {
              _tag: "TaskDefinition",
              kind: "tool",
              id: `conv#o${ord}:turn`,
              toolId: shared?.turnEffectId ?? "conversation.turn",
            },
            {
              conversationId,
              turn: n,
              ord,
              asker,
              text: promptText,
              ...(verified.id !== undefined && { id: verified.id }),
              history: historyOf(summaryForTurn(), promptTurns),
              known: [...known].slice(-MAX_KNOWN_FOR_WATCH),
              ownerExecutionId: ctx.executionId,
            }
          )) as TurnResult;
          status = out.status;
          reply = clip(out.content ?? "", maxReplyChars);
          toolNames = out.tools ?? [];
          turnExecutionId = out.turnExecutionId;
          memoryScope = out.memoryScope;
          if (out.status === "failed") {
            reason = out.reason ?? "turn-failed";
            errorId = out.errorId;
          }
        } else {
          const out = await withTurnScope(
            conversationId,
            n,
            ctl.signal,
            () =>
              agentLoop$(
                ctx,
                { ...config.agent, loopId: `conv#o${ord}`, signal: ctl.signal },
                {
                  prompt: promptText,
                  promptOrigin: USER_ORIGIN,
                  history: historyOf(summaryForTurn(), turns),
                }
              ),
            ensureWatch
          );
          reply = clip(out.content, maxReplyChars);
        }
      } catch (e) {
        if (e instanceof TypedFailure && e.channel === AGENT_INTERRUPTED) {
          status = "interrupted";
          reply = clip((e.payload as InterruptedAgentRun).content ?? "", maxReplyChars);
        } else if (isTerminalToolError(e)) {
          throw e; // a park, an authority/safety stop, a cancel, a replay divergence: not a failed turn
        } else {
          // The user sees a FIXED reason and a correlation id; the real error goes to the host's log.
          status = "failed";
          reason = "model-error";
          errorId = `err-${fnv1a64(`${ctx.executionId}:${ord}`)}`;
          failure = e;
        }
      } finally {
        // Host-side, not a `ctx` operation: it can only fire the signal, which the loop reads
        // through its recorded checkpoints.
        if (watching !== undefined) (await watching.catch(() => () => undefined))();
      }

      // SHARED: what the answer touched. The declared class of every tool called plus the classes of
      // every entry that fed the context; a tool the policy does not know is "unclassified".
      let classes: string[] = [];
      if (sharedCfg !== undefined) {
        classes = await ctx.decide<string[]>(
          `conv#o${ord}:classes`,
          () =>
            union(
              contextClasses,
              toolNames.map((name) => sharedCfg.classOf?.(name) ?? "unclassified"),
              // recalled / written memory is a data class of its own: whoever the scope belongs to
              memoryScope === undefined ? [] : [`memory:${memoryScope}`]
            ),
          { source: "conversation-access" }
        );
      }
      await record(
        "reply",
        {
          turn: n,
          role: "assistant",
          text: reply,
          status,
          ...(reason !== undefined && { reason }),
          ...(errorId !== undefined && { errorId }),
          ...(attributed !== undefined && { asker: attributed }),
          ...(classes.length > 0 && { classes }),
          ...(turnExecutionId !== undefined && { turnExecutionId }),
        },
        async () => {
          if (failure !== undefined && errorId !== undefined) {
            config.onError?.(errorId, failure, { conversationId, turn: n });
          }
        }
      );
      turns.push({
        n,
        ord: userOrd,
        user: verified.text,
        assistant: reply,
        status,
        ...(attributed !== undefined && { asker: attributed }),
        ...(classes.length > 0 && { classes }),
      });
      if (sharedCfg !== undefined && turns.length > maxWindowTurns) {
        const dropped = turns.slice(0, turns.length - maxWindowTurns);
        turns = turns.slice(turns.length - maxWindowTurns);
        await summarize(dropped);
      }
      hubEnd(config, conversationId, n);
      if (turnsCounter.turn()) rotateDue = true;
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

/** A conversation flow plus what a client needs to drive it. */
export type ConversationFlow = RegisteredFlow<
  ConversationCarry | Record<string, never>,
  ConversationResult
> & {
  /** `"owner"` (default) or `"shared"` (a participant set; see {@link SharedConfig}). */
  readonly mode: "owner" | "shared";
  readonly config: ConversationConfig;
  /** Shared mode only: the turn flow and the effect id to register. */
  readonly sharedTurn?: {
    flow: RegisteredFlow<TurnInput, Omit<TurnResult, "turnExecutionId">>;
    effectId: string;
    signals: Map<string, AbortSignal>;
  };
};

/**
 * Build the registered flow of a conversation. Register it on the runtime
 * (`runtime.registerFlow(flow.definition, flow.runner)`) and drive it with {@link createConversations}.
 * Needs `kernel.features.inbox` and `kernel.features.continueAsNew` on the runtime.
 */
export function conversation$(
  config: ConversationConfig,
  options: ConversationFlowOptions = {}
): ConversationFlow {
  const id = options.id ?? "conversation";
  const definition = flow$({
    id,
    name: options.name ?? "Conversation",
    version: options.version ?? "1.0.0",
    inputSchema: z.any(),
    outputSchema: z.any(),
    steps: [],
  });
  const effectId = config.shared?.turnEffectId ?? "conversation.turn";
  const base = {
    definition,
    runner: conversationRunner(config, { turnEffectId: effectId }),
    mode: config.shared === undefined ? "owner" : "shared",
    config,
  } as ConversationFlow;
  if (config.shared === undefined) return base;
  const signals = new Map<string, AbortSignal>();
  return {
    ...base,
    sharedTurn: { flow: sharedTurnFlow(config, signals, `${id}-turn`), effectId, signals },
  };
}

export { registerSharedTurnEffect, sharedTurnEffect };
