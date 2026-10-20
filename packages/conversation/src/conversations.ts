import { randomUUID } from "node:crypto";
import type { EffectRuntime, PrincipalChain } from "@loom/effect-runtime";
import { type EventStore, readRangeOf } from "@loom/event-runtime";
import type { SendResult, WorkflowRuntime } from "@loom/workflow-runtime";
import {
  ENVELOPE_DOMAIN,
  type Identity,
  identityKey,
  identityOf,
  parseIdentity,
  sameIdentity,
  senderKey,
  verifySignature,
} from "./access";
import { type BargeInSource, inboxBargeIn, pendingMessages } from "./bargeIn";
import { type ConversationFlow, signedEnvelope } from "./conversation";
import { generationId, generationOf, isValidConversationId } from "./ids";
import {
  type ConversationReader,
  InvalidCursorError,
  type ReadOptions,
  type ReadResult,
  createConversationReader,
  parseCursor,
  recordOf,
} from "./reader";
import { registerSharedTurnEffect } from "./turn";
import { CONVERSATION_TOPIC, type HistoryEntry } from "./types";

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
  /**
   * Shared mode: the principal a turn runs as for an asker identity. Default: the identity itself (tenant,
   * actor, onBehalfOf), which carries NO delegation token. A sender who presents a delegation (an attenuated
   * grant) is therefore REFUSED unless this is supplied: rebuilding their principal from identity alone
   * would give the turn the actor's full grants. A host that supplies it maps the identity to the narrowed
   * principal (re-issuing the delegation from its own grant table, ADR 0111 D4).
   */
  principalFor?: (asker: Identity) => PrincipalChain | Promise<PrincipalChain>;
  /**
   * The execution policy the runtime was built with (`executionAccessPolicy(...)`, the SAME object). The
   * conversation's log holds the unfiltered transcript, so a runtime that lets a tenant peer `query`,
   * `send` to, `cancel` or `resume` another principal's execution defeats every per-viewer rule here: it is
   * REFUSED at construction unless `query`, `send`, `cancel`, `resume` and `actAsOwner` are `owner`-scoped
   * (or denied).
   */
  policy?: { readonly scopes?: Readonly<Record<string, string>> };
  /**
   * Acknowledge that the runtime's policy is owner-scoped for those ops although it cannot be inspected
   * (a custom `ExecutionAuthorizer`, or no authorizer in a development process). The host asserts it; this
   * layer cannot check it. The body still acts only on envelopes signed by the host (D10), which is what
   * remains if the assertion is false.
   */
  runtimePolicyIsOwnerScoped?: boolean;
  /** Shared mode: turns one asker may have waiting in the inbox before `sendTurn` refuses. Default 8. */
  maxQueuedPerAsker?: number;
  /** The clock envelopes are stamped with (tests). */
  now?: () => number;
}

export class QueueFullError extends Error {
  readonly code = "QUEUE_FULL";
  constructor() {
    super("too many of your turns are already waiting");
    this.name = "QueueFullError";
  }
}

const POLICED_OPS = [
  "query",
  "send",
  "cancel",
  "resume",
  "actAsOwner",
  "annotate",
  "discard",
  "quarantine",
  "release",
] as const;

function assertOwnerScopedPolicy(deps: ConversationsDeps): void {
  if (deps.runtimePolicyIsOwnerScoped === true) return;
  const scopes = deps.policy?.scopes;
  if (scopes === undefined) {
    throw new Error(
      "createConversations: cannot establish that the runtime's execution policy is owner-scoped. Pass `policy` (the `executionAccessPolicy(...)` object the runtime was built with) or acknowledge it with `runtimePolicyIsOwnerScoped: true`. A conversation's log holds the unfiltered transcript; a policy that lets a tenant peer query, send to, cancel or resume it defeats every access rule."
    );
  }
  for (const op of POLICED_OPS) {
    const scope = scopes[op];
    if (scope !== "owner" && scope !== "deny") {
      throw new Error(
        `createConversations: the runtime's policy scopes "${op}" as "${String(scope)}"; it must be "owner" or "deny" (rules: { ${POLICED_OPS.map((o) => `${o}: "owner"`).join(", ")} })`
      );
    }
  }
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
  /**
   * This turn EDITS an earlier user turn of yours: that turn's `ord` (from `history`). Signed into the
   * envelope and validated by the conversation: it must be an accepted user turn of the same asker still in
   * the prompt window, else the turn is recorded as rejected (`edit-invalid`) and not obeyed. The edit is a
   * NEW turn (the log is append-only); the model is told it replaces the earlier message.
   */
  editOf?: number;
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
  /** Whether `principal` may (still) read the conversation: a cheap membership check, for a stream to run per delivered message. */
  isParticipant(conversationId: string, principal?: PrincipalChain): Promise<boolean>;
  /**
   * Whether `principal` is the conversation's OWNER (the same identity rule as ownership: tenant, actor and
   * onBehalfOf all equal). Any refusal (unknown conversation, a non-participant, another tenant) is `false`,
   * never a distinguishable error. ADR 0133 D6 uses it for the live reasoning audience.
   */
  isOwner(conversationId: string, principal?: PrincipalChain): Promise<boolean>;
  /** SHARED mode: the participant set. Owner / manager only. */
  participants(conversationId: string, options?: CallOptions): Promise<Identity[]>;
  addParticipant(conversationId: string, who: Identity, options?: CallOptions): Promise<void>;
  removeParticipant(conversationId: string, who: Identity, options?: CallOptions): Promise<void>;
  readonly reader: ConversationReader;
  /**
   * ADR 0133 D6 - where the DURABLE reasoning of one assistant reply lives, for a caller entitled to read it.
   * `cursor` is the reply's history cursor. OWNER mode: the owner (the only reader) gets the generation that
   * ran the turn, narrowed to that turn's steps. SHARED mode: the reply's asker AND the conversation's
   * owner get it (the turn's own execution); every other participant, a non-participant, another tenant, an unknown
   * cursor and a record that is not an assistant reply all get the same `ConversationNotFoundError`.
   * Does not read the reasoning itself: the transport joins it with `readReasoning` and its store.
   */
  reasoningTarget(
    conversationId: string,
    cursor: string,
    options?: CallOptions
  ): Promise<{ executionId: string; stepPrefix?: string }>;
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

/** Pages of 100 records `status` walks back at most to find the newest accepted turn. */
const STATUS_MAX_PAGES = 50;
const OWNER_CACHE_MAX = 1024;

export function createConversations(deps: ConversationsDeps): Conversations {
  assertOwnerScopedPolicy(deps);
  const { runtime, eventStore, flow } = deps;
  const key = flow.config.key;
  const now = deps.now ?? Date.now;
  const maxQueued = deps.maxQueuedPerAsker ?? 8;
  const maxTurnChars = deps.maxTurnChars ?? 32_000;
  const reader = createConversationReader(eventStore);
  const mode = flow.mode;
  const shared = flow.config.shared;
  const service = shared === undefined ? undefined : identityOf(shared.servicePrincipal);
  /** No end-user identity may be the service principal that owns the coordinating executions. */
  const isService = (i: Identity | undefined): boolean =>
    service !== undefined && sameIdentity(i, service);
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
        key,
        ...(flow.config.previousKeys !== undefined && { previousKeys: flow.config.previousKeys }),
        eventStore,
        ...(flow.config.onError !== undefined && { onError: flow.config.onError }),
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
  const CONFLICT = "conflict" as const;
  const owners = new Map<string, Identity | null | typeof CONFLICT>();
  async function ownerOf(conversationId: string): Promise<Identity | undefined | typeof CONFLICT> {
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
    let owner: Identity | undefined | typeof CONFLICT;
    if (shared !== undefined) {
      // SHARED: the coordinator is owned by the SERVICE principal, and the human owner is the stamp. Anything
      // else (a coordinator someone started as themselves, claiming another owner) is a conflict.
      owner =
        recorded !== undefined && isService(recorded) && stamped !== undefined ? stamped : CONFLICT;
    } else if (stamped !== undefined && recorded !== undefined) {
      owner = sameIdentity(stamped, recorded) ? stamped : CONFLICT;
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
    const recorded = await ownerOf(conversationId);
    // A conflicting owner record is its own state: it matches NOBODY, the anonymous caller included.
    if (recorded === CONFLICT) throw new ConversationNotFoundError(conversationId);
    const owner = recorded;
    const viewer = identityOf(principal);
    if (isService(viewer)) throw new ConversationNotFoundError(conversationId);
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
    if (mode === "shared") {
      if (viewer === undefined) throw new ConversationNotFoundError(conversationId);
      // A sender presenting a delegation (an attenuated grant) cannot be run faithfully from their identity
      // alone: the turn would get the actor's FULL grants. Refused unless the host maps identity to a
      // principal itself.
      if (o?.principal?.delegation !== undefined && deps.principalFor === undefined) {
        throw new InvalidTurnError(
          "a delegated sender cannot be run as themselves in a shared conversation unless the host supplies `principalFor`"
        );
      }
      if (body.kind === "user" && (await queuedFor(conversationId, viewer)) >= maxQueued) {
        throw new QueueFullError();
      }
      // The kernel sees the HOST as the sender, so its dedupe key is made per-asker here.
      id = senderKey(viewer, messageId);
      kernelId = id;
    } else {
      id = senderKey(rawSender(o?.principal), messageId);
      kernelId = messageId;
    }
    // The signature covers the conversation, the sender's voice, the text, the id and the issue time: none
    // of it can be lifted into another message, conversation or time (the body also refuses a replayed id).
    const payload = signedEnvelope(key, {
      ...body,
      conversationId,
      id,
      iat: now(),
      ...(viewer !== undefined && { asker: viewer }),
    });
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

  /** How many of `asker`'s turns are waiting in the inbox (best effort across processes; small overshoot is possible). */
  async function queuedFor(conversationId: string, asker: Identity): Promise<number> {
    const g = (await reader.headGeneration(conversationId)) ?? 0;
    const waiting = await pendingMessages(
      eventStore,
      conversationId,
      generationId(conversationId, g),
      maxQueued + 16
    );
    const k = identityKey(asker);
    return (waiting ?? []).filter((m) => {
      // Only envelopes the host SIGNED for this conversation count: a garbage-signature message naming
      // someone as its asker must not fill that person's quota (a targeted denial of service).
      const p = m.payload as Record<string, unknown> | null;
      if (p === null || typeof p !== "object") return false;
      const { sig, ...body } = p;
      if (body.conversationId !== conversationId) return false;
      if (!verifySignature([key, ...(flow.config.previousKeys ?? [])], body, sig, ENVELOPE_DOMAIN))
        return false;
      const a = parseIdentity(body.asker);
      return a !== undefined && identityKey(a) === k;
    }).length;
  }

  // A placeholder keeps `ord` (an ordinal is not content) and never `editOf` or any text.
  const restricted = (e: HistoryEntry): HistoryEntry => ({
    turn: e.turn,
    ...(e.ord !== undefined && { ord: e.ord }),
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
      if (isService(owner))
        throw new InvalidTurnError("that identity is reserved for the service principal");
      // Start-once for a chosen id (ADR 0103): a duplicate start rejects, nothing re-runs. The owner is
      // stamped into the input: sequence 0 is immutable, which is what makes it a record. In SHARED mode the
      // coordinating execution is owned by the SERVICE principal, so no participant (the human owner
      // included) can `query` its unfiltered log through the runtime.
      await runtime.start(
        flow as never,
        { v: 1, seq: 0, ord: 0, turns: [], ...(owner !== undefined && { owner }) } as never,
        {
          executionId: conversationId,
          ...(shared !== undefined
            ? { principal: shared.servicePrincipal }
            : options.principal !== undefined && { principal: options.principal }),
        }
      );
      if (owner !== undefined) owners.set(conversationId, owner);
      return { conversationId };
    },
    async sendTurn(conversationId, text, options) {
      if (typeof text !== "string" || text.trim() === "") throw new InvalidTurnError("empty text");
      if (text.length > maxTurnChars) throw new InvalidTurnError(`over ${maxTurnChars} characters`);
      if (
        options?.editOf !== undefined &&
        (!Number.isSafeInteger(options.editOf) || options.editOf < 1)
      ) {
        throw new InvalidTurnError(
          "editOf must be a positive integer (the ord of an earlier turn)"
        );
      }
      return send(
        conversationId,
        { kind: "user", text, ...(options?.editOf !== undefined && { editOf: options.editOf }) },
        "member",
        options
      );
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
      // A rejected record belongs to no turn (`turn: 0`): the turn count is the newest ACCEPTED record's
      // number, looked for by paging backward (bounded: STATUS_MAX_PAGES pages of 100 records).
      let last = await reader.read(conversationId, { direction: "backward", limit: 100 });
      const newest = last.entries[0];
      let accepted = last.entries.find((e) => e.turn > 0)?.turn;
      for (let page = 1; accepted === undefined && !last.done && page < STATUS_MAX_PAGES; page++) {
        last = await reader.read(conversationId, {
          direction: "backward",
          limit: 100,
          ...(last.nextCursor !== undefined && { cursor: last.nextCursor }),
        });
        accepted = last.entries.find((e) => e.turn > 0)?.turn;
      }
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
        turns: accepted ?? 0,
      };
    },
    async filterEntries(entries, principal) {
      if (shared === undefined) return [...entries];
      const viewer = identityOf(principal);
      const cache = new Map<string, boolean>();
      const out: HistoryEntry[] = [];
      for (const e of entries) {
        if (!e.classes?.length) {
          out.push(stripTurnExecution(e, viewer));
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
        out.push(ok ? stripClasses(e, viewer) : restricted(e));
      }
      return out;
    },
    async reasoningTarget(conversationId, cursor, options) {
      const { viewer, isOwner } = await authorize(conversationId, options?.principal, "member");
      const pos = parseCursor(cursor);
      if (pos === undefined) throw new InvalidCursorError();
      const head = await reader.headGeneration(conversationId);
      if (head === undefined || pos.g > head) throw new ConversationNotFoundError(conversationId);
      const ev = (
        await readRangeOf(eventStore, generationId(conversationId, pos.g), pos.seq, pos.seq)
      )[0];
      const rec = ev === undefined ? undefined : recordOf(ev);
      if (ev === undefined || rec === undefined || rec.role !== "assistant") {
        throw new ConversationNotFoundError(conversationId);
      }
      if (shared !== undefined) {
        // The turn's reasoning carries what the ASKER's turn saw; the per-viewer filter is not designed to
        // classify free text, so nobody but the asker and the conversation's OWNER (owner ruling
        // 2026-10-20) gets it.
        const isAsker = viewer !== undefined && sameIdentity(rec.asker, viewer);
        if (!isAsker && !isOwner) {
          throw new ConversationNotFoundError(conversationId);
        }
        if (rec.turnExecutionId === undefined) throw new ConversationNotFoundError(conversationId);
        return { executionId: rec.turnExecutionId };
      }
      const decisionId = (ev.payload as { decisionId?: unknown } | null)?.decisionId;
      const loop = typeof decisionId === "string" ? /^(conv#o\d+):reply$/.exec(decisionId) : null;
      if (loop === null) throw new ConversationNotFoundError(conversationId);
      return { executionId: ev.executionId, stepPrefix: `${loop[1]}#` };
    },
    async isParticipant(conversationId, principal) {
      try {
        await authorize(conversationId, principal, "member");
        return true;
      } catch (err) {
        if (err instanceof ConversationNotFoundError) return false;
        throw err;
      }
    },
    async isOwner(conversationId, principal) {
      try {
        return (await authorize(conversationId, principal, "member")).isOwner;
      } catch (err) {
        if (err instanceof ConversationNotFoundError) return false;
        throw err;
      }
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
      if (isService(identity))
        throw new InvalidTurnError("that identity is reserved for the service principal");
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
function stripClasses(e: HistoryEntry, viewer: Identity | undefined): HistoryEntry {
  const { classes: _classes, ...rest } = e;
  return stripTurnExecution(rest, viewer);
}

/** The turn execution's id is the ASKER's: another viewer is not handed a handle on it. */
function stripTurnExecution(e: HistoryEntry, viewer: Identity | undefined): HistoryEntry {
  if (e.turnExecutionId === undefined || sameIdentity(e.asker, viewer)) return e;
  const { turnExecutionId: _t, ...rest } = e;
  return rest;
}
