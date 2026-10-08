import { randomUUID } from "node:crypto";
import type { EffectRuntime, PrincipalChain } from "@loom/effect-runtime";
import { type EventStore, readRangeOf } from "@loom/event-runtime";
import type { SendResult, WorkflowRuntime } from "@loom/workflow-runtime";
import {
  type Identity,
  identityKey,
  identityOf,
  parseIdentity,
  sameIdentity,
  senderKey,
} from "./access";
import { type BargeInSource, inboxBargeIn } from "./bargeIn";
import { type ConversationFlow, signedEnvelope } from "./conversation";
import { generationOf, isValidConversationId } from "./ids";
import {
  type ConversationReader,
  type ReadOptions,
  type ReadResult,
  createConversationReader,
} from "./reader";
import { registerSharedTurnEffect } from "./turn";
import { CONVERSATION_TOPIC, type HistoryEntry, type TurnEnvelope } from "./types";

// ── The client API of a conversation (ADR 0122 D1, D8, D10) ──────────────────────────────────────
//
// WHO MAY DO WHAT. Every call is first judged HERE, against the conversation's recorded owner, and a
// caller who is not allowed gets the same `ConversationNotFoundError` as for a conversation that does not
// exist (existence is not revealed). The default is OWNER-ONLY: only the identity that started the
// conversation (tenant, actor and onBehalfOf all equal; a delegate is a different identity) may send,
// close, read or stream. SHARED mode adds an explicit participant set (D10). The runtime's own policy
// still applies underneath in owner-only mode; in shared mode the client, being the one place that knows
// the participant set, performs the runtime calls with the runtime's system grant after its own check.

export class ConversationNotFoundError extends Error {
  readonly code = "CONVERSATION_NOT_FOUND";
  constructor(readonly conversationId: string) {
    super(`conversation "${conversationId}" not found`);
    this.name = "ConversationNotFoundError";
  }
}

export class InvalidTurnError extends Error {
  readonly code = "INVALID_TURN";
  constructor(detail: string) {
    super(`invalid turn: ${detail}`);
    this.name = "InvalidTurnError";
  }
}

export interface ConversationsDeps {
  runtime: WorkflowRuntime;
  /** The store the runtime appends to (history is read from it with bounded range reads). */
  eventStore: EventStore;
  /** The `conversation$` flow (registered here if the runtime does not know it yet). */
  flow: ConversationFlow;
  /** Characters a sent turn may have (the flow enforces its own `maxTurnChars` too). Default 32 000. */
  maxTurnChars?: number;
  /** Shared mode: the effect runtime to register the turn effect on. Required for a shared flow. */
  effects?: EffectRuntime;
  /** Shared mode: what notices a participant's own follow-up while their turn runs. Default `inboxBargeIn(eventStore)`. */
  bargeIn?: BargeInSource;
  /** Shared mode: the principal a turn runs as for an asker identity. Default: the identity itself. */
  principalFor?: (asker: Identity) => PrincipalChain | Promise<PrincipalChain>;
}

export interface CallOptions {
  /** The authenticated caller. */
  principal?: PrincipalChain;
}

export interface SendTurnOptions extends CallOptions {
  /**
   * The idempotency key. A retry with the SAME id from the SAME sender is consumed once (at-least-once
   * send, exactly-once consume, within the kernel's dedupe window); minted when omitted.
   */
  messageId?: string;
}

export type ConversationState = "open" | "closed" | "failed" | "cancelled";

export interface ConversationStatus {
  conversationId: string;
  /** The generation that currently holds the conversation (it advances at each rotation). */
  executionId: string;
  generation: number;
  state: ConversationState;
  /** A turn is being answered right now (the last recorded message is an unanswered user turn). */
  running: boolean;
  /** Turns accepted so far (the highest turn number in the transcript), 0 if none. */
  turns: number;
}

export interface Conversations {
  readonly mode: "owner" | "shared";
  /** Whether the runtime fails closed on a principal-less call (it has an execution authorizer that requires one). */
  readonly requiresPrincipal: boolean;
  start(options?: CallOptions & { conversationId?: string }): Promise<{ conversationId: string }>;
  sendTurn(conversationId: string, text: string, options?: SendTurnOptions): Promise<SendResult>;
  close(conversationId: string, options?: SendTurnOptions): Promise<SendResult>;
  history(conversationId: string, options?: ReadOptions & CallOptions): Promise<ReadResult>;
  status(conversationId: string, options?: CallOptions): Promise<ConversationStatus>;
  /**
   * Prove the caller may read the conversation and return its head generation, WITHOUT reading any
   * history: the gate a streaming transport runs once per connection (and again to re-authorize).
   */
  authorizeRead(conversationId: string, options?: CallOptions): Promise<{ generation: number }>;
  /**
   * SHARED mode: apply the per-viewer filter to raw entries (from `followConversation`, a history page):
   * an entry whose classes the viewer is not cleared for becomes a bare `restricted` placeholder. Owner-only
   * conversations pass entries through. Does NOT authorize: call `authorizeRead` first.
   */
  filterEntries(
    entries: readonly HistoryEntry[],
    principal?: PrincipalChain
  ): Promise<HistoryEntry[]>;
  /** SHARED mode: the viewer's identity key (to match against a live event's `asker`), or undefined. */
  viewerKey(principal?: PrincipalChain): string | undefined;
  /** SHARED mode: the participant set. Owner / manager only. */
  participants(conversationId: string, options?: CallOptions): Promise<Identity[]>;
  addParticipant(conversationId: string, who: Identity, options?: CallOptions): Promise<void>;
  removeParticipant(conversationId: string, who: Identity, options?: CallOptions): Promise<void>;
  readonly reader: ConversationReader;
}

/** The identity fields exactly as `runtime.send` stamps them on a message (ADR 0110 D1). */
function rawSender(p: PrincipalChain | undefined): {
  tenant?: string;
  actor?: string;
  onBehalfOf?: string;
} {
  return {
    ...(typeof p?.tenant === "string" && { tenant: p.tenant }),
    ...(typeof p?.actor === "string" && { actor: p.actor }),
    ...(typeof p?.onBehalfOf === "string" && { onBehalfOf: p.onBehalfOf }),
  };
}

const OWNER_CACHE_MAX = 1024;

export function createConversations(deps: ConversationsDeps): Conversations {
  const { runtime, eventStore, flow } = deps;
  const maxTurnChars = deps.maxTurnChars ?? 32_000;
  const reader = createConversationReader(eventStore);
  const mode = flow.mode;
  const shared = flow.config.shared;
  let registered = false;
  const ensureRegistered = (): void => {
    if (registered) return;
    // Idempotent for the same id + version + content (the kernel's own rule).
    runtime.registerFlow(flow.definition as never, flow.runner as never);
    if (shared !== undefined && flow.sharedTurn !== undefined) {
      runtime.registerFlow(
        flow.sharedTurn.flow.definition as never,
        flow.sharedTurn.flow.runner as never
      );
      if (deps.effects === undefined) {
        throw new Error(
          "createConversations: a shared conversation needs `effects` to register its turn effect on"
        );
      }
      registerSharedTurnEffect(deps.effects, flow.sharedTurn.effectId, {
        runtime,
        turnFlow: flow.sharedTurn.flow,
        signals: flow.sharedTurn.signals,
        key: shared.key,
        bargeIn: deps.bargeIn ?? inboxBargeIn(eventStore),
        ...(deps.principalFor !== undefined && { principalFor: deps.principalFor }),
      });
    }
    registered = true;
  };
  if (shared !== undefined) ensureRegistered();

  // ── ownership ─────────────────────────────────────────────────────────────────────────────────
  // The owner is read once per conversation from sequence 0 of generation 0 (immutable, start-once):
  // the identity the client stamped into the start input, cross-checked against the identity the
  // kernel recorded for the starting principal when that is stored verbatim. A disagreement is an
  // UNKNOWN owner, which nobody matches.
  const owners = new Map<string, Identity | null>();
  async function ownerOf(conversationId: string): Promise<Identity | undefined> {
    const cached = owners.get(conversationId);
    if (cached !== undefined) return cached ?? undefined;
    const first = (await readRangeOf(eventStore, conversationId, 0, 0))[0];
    if (first === undefined) throw new ConversationNotFoundError(conversationId);
    const payload = first.payload as {
      input?: { owner?: unknown };
      principal?: { identity?: unknown };
    } | null;
    const stamped = parseIdentity(payload?.input?.owner);
    const recorded = parseIdentity(payload?.principal?.identity);
    let owner: Identity | undefined;
    if (stamped !== undefined && recorded !== undefined) {
      owner = sameIdentity(stamped, recorded) ? stamped : undefined;
    } else owner = stamped ?? recorded;
    if (owners.size >= OWNER_CACHE_MAX) owners.delete(owners.keys().next().value as string);
    owners.set(conversationId, owner ?? null);
    return owner;
  }

  interface Access {
    owner: Identity | undefined;
    viewer: Identity | undefined;
    isOwner: boolean;
  }

  /** Judge `principal` for `need`. ANY refusal is the same `ConversationNotFoundError`. */
  async function authorize(
    conversationId: string,
    principal: PrincipalChain | undefined,
    need: "member" | "manage"
  ): Promise<Access> {
    if (!isValidConversationId(conversationId)) throw new ConversationNotFoundError(conversationId);
    const owner = await ownerOf(conversationId);
    const viewer = identityOf(principal);
    // A conversation with no recorded owner (started with no principal) is "owned" by the anonymous.
    const isOwner = owner === undefined ? principal === undefined : sameIdentity(viewer, owner);
    const access = { owner, viewer, isOwner };
    if (isOwner) return access;
    if (shared === undefined || viewer === undefined)
      throw new ConversationNotFoundError(conversationId);
    if (need === "manage") {
      if ((await shared.manageParticipants?.(viewer, conversationId)) !== true) {
        throw new ConversationNotFoundError(conversationId);
      }
      return access;
    }
    const members = await shared.directory.list(conversationId);
    if (!members.some((m) => sameIdentity(m, viewer)))
      throw new ConversationNotFoundError(conversationId);
    return access;
  }

  /** The runtime options for an authorized call: the caller's principal (owner-only) or the host's grant (shared). */
  const runtimeOpts = (principal: PrincipalChain | undefined) =>
    mode === "shared" ? runtime.systemOptions() : principal !== undefined ? { principal } : {};

  async function head(
    conversationId: string,
    principal: PrincipalChain | undefined,
    need: "member" | "manage" = "member"
  ) {
    const access = await authorize(conversationId, principal, need);
    const h = await runtime.followToHead(conversationId, runtimeOpts(principal));
    if (h === null) throw new ConversationNotFoundError(conversationId);
    return { h, access };
  }

  async function send(
    conversationId: string,
    body: Record<string, unknown>,
    need: "member" | "manage",
    o?: SendTurnOptions
  ): Promise<SendResult> {
    const { viewer } = await authorize(conversationId, o?.principal, need);
    const messageId = o?.messageId ?? randomUUID();
    let id: string;
    let kernelId: string;
    let payload: TurnEnvelope | Record<string, unknown>;
    if (mode === "shared") {
      if (viewer === undefined) throw new ConversationNotFoundError(conversationId);
      // The kernel sees the HOST as the sender, so its dedupe key is made per-asker here.
      id = senderKey(viewer, messageId);
      kernelId = id;
      payload = signedEnvelope(shared!.key, {
        ...body,
        id,
        ...(body.kind === "close" ? { by: viewer } : { asker: viewer }),
      });
    } else {
      id = senderKey(rawSender(o?.principal), messageId);
      kernelId = messageId;
      payload = { ...body, id };
    }
    try {
      return await runtime.send(
        conversationId,
        { topic: CONVERSATION_TOPIC, payload, messageId: kernelId },
        runtimeOpts(o?.principal)
      );
    } catch (err) {
      // The runtime throws a plain Error for an unknown id (after the authorization-hiding step).
      if (err instanceof Error && err.message.startsWith("No execution found for id")) {
        throw new ConversationNotFoundError(conversationId);
      }
      throw err;
    }
  }

  const restricted = (e: HistoryEntry): HistoryEntry => ({
    turn: e.turn,
    role: e.role,
    text: "",
    status: "restricted",
    cursor: e.cursor,
    executionId: e.executionId,
    ...(e.at !== undefined && { at: e.at }),
    // Attribution survives: who asked is on the (unrestricted) user message beside it anyway.
    ...(e.asker !== undefined && { asker: e.asker }),
  });

  async function manageGuard(conversationId: string, o?: CallOptions): Promise<Access> {
    if (shared === undefined) throw new Error("not a shared conversation");
    return authorize(conversationId, o?.principal, "manage");
  }

  return {
    reader,
    mode,
    requiresPrincipal: runtime.requiresPrincipal === true,
    async start(options = {}) {
      ensureRegistered();
      const conversationId = options.conversationId ?? `conv-${randomUUID()}`;
      if (!isValidConversationId(conversationId)) {
        throw new InvalidTurnError(`conversation id "${conversationId}" is not valid`);
      }
      const owner = identityOf(options.principal);
      if (mode === "shared" && owner === undefined) {
        throw new InvalidTurnError(
          "a shared conversation needs an identified owner (a principal with an actor)"
        );
      }
      // Start-once for a chosen id (ADR 0103): a duplicate start rejects, nothing re-runs. The owner is
      // stamped into the input: sequence 0 is immutable, which is what makes it a record.
      await runtime.start(
        flow as never,
        { v: 1, seq: 0, ord: 0, turns: [], ...(owner !== undefined && { owner }) } as never,
        {
          executionId: conversationId,
          ...(options.principal !== undefined && { principal: options.principal }),
        }
      );
      if (owner !== undefined) owners.set(conversationId, owner);
      return { conversationId };
    },
    async sendTurn(conversationId, text, options) {
      if (typeof text !== "string" || text.trim() === "") throw new InvalidTurnError("empty text");
      if (text.length > maxTurnChars) throw new InvalidTurnError(`over ${maxTurnChars} characters`);
      return send(conversationId, { kind: "user", text }, "member", options);
    },
    close(conversationId, options) {
      // Closing ends everyone's conversation: the owner (or, shared, a manager).
      return send(
        conversationId,
        { kind: "close" },
        mode === "shared" ? "manage" : "member",
        options
      );
    },
    async authorizeRead(conversationId, options) {
      const { h } = await head(conversationId, options?.principal);
      return { generation: generationOf(h.executionId) };
    },
    async history(conversationId, options = {}) {
      await authorize(conversationId, options.principal, "member");
      const page = await reader.read(conversationId, options);
      if (mode === "owner") return page;
      return { ...page, entries: await this.filterEntries(page.entries, options.principal) };
    },
    async status(conversationId, options) {
      const { h } = await head(conversationId, options?.principal);
      const generation = generationOf(h.executionId);
      const last = await reader.read(conversationId, { direction: "backward", limit: 1 });
      const newest = last.entries[0];
      const st = h.state.status;
      const state: ConversationState =
        st === "completed"
          ? "closed"
          : st === "failed"
            ? "failed"
            : st === "cancelled"
              ? "cancelled"
              : "open";
      return {
        conversationId,
        executionId: h.executionId,
        generation,
        state,
        running: state === "open" && newest?.role === "user" && newest.status === "complete",
        turns: newest?.turn ?? 0,
      };
    },
    async filterEntries(entries, principal) {
      if (shared === undefined) return [...entries];
      const viewer = identityOf(principal);
      const cache = new Map<string, boolean>();
      const out: HistoryEntry[] = [];
      for (const e of entries) {
        if (!e.classes?.length) {
          out.push(e);
          continue;
        }
        // Your own answer is yours; anything else needs clearance for EVERY class, fail closed.
        let ok = viewer !== undefined && sameIdentity(e.asker, viewer);
        if (!ok && viewer !== undefined) {
          const k = e.classes.join("\u0000");
          let c = cache.get(k);
          if (c === undefined) {
            c = (await shared.cleared(viewer, e.classes)) === true;
            cache.set(k, c);
          }
          ok = c;
        }
        out.push(ok ? stripClasses(e) : restricted(e));
      }
      return out;
    },
    viewerKey(principal) {
      const v = identityOf(principal);
      return v === undefined ? undefined : identityKey(v);
    },
    async participants(conversationId, options) {
      await manageGuard(conversationId, options);
      return (shared as NonNullable<typeof shared>).directory.list(conversationId);
    },
    async addParticipant(conversationId, who, options) {
      const { viewer, owner } = await manageGuard(conversationId, options);
      const identity = parseIdentity(who);
      if (identity === undefined || viewer === undefined)
        throw new InvalidTurnError("a participant needs an actor");
      if (sameIdentity(identity, owner)) return; // the owner is always a participant
      await (shared as NonNullable<typeof shared>).directory.apply(conversationId, {
        op: "add",
        identity,
        by: viewer,
      });
    },
    async removeParticipant(conversationId, who, options) {
      const { viewer, owner } = await manageGuard(conversationId, options);
      const identity = parseIdentity(who);
      if (identity === undefined || viewer === undefined)
        throw new InvalidTurnError("a participant needs an actor");
      if (sameIdentity(identity, owner)) throw new InvalidTurnError("the owner cannot be removed");
      await (shared as NonNullable<typeof shared>).directory.apply(conversationId, {
        op: "remove",
        identity,
        by: viewer,
      });
    },
  };
}

/** A visible entry still tells the viewer WHICH classes it touched? No: labels may themselves be sensitive. */
function stripClasses(e: HistoryEntry): HistoryEntry {
  const { classes: _classes, ...rest } = e;
  return rest;
}
