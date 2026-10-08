import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { PrincipalChain } from "@loom/effect-runtime";
import { DuplicateSequenceError, type EventStore, headOf, readRangeOf } from "@loom/event-runtime";

// ── Who a conversation belongs to, and who else may take part (ADR 0122 D8, D10) ────────────────────
//
// IDENTITY. The same bounded subset ADR 0111 records and `runtime.send` stamps on a message:
// `{ tenant?, actor, onBehalfOf? }`. Two principals are the same identity iff ALL THREE fields are
// equal (an absent field equals only an absent field). A delegated principal acting `onBehalfOf` someone
// is therefore a DIFFERENT identity from that someone: delegation narrows authority, it never widens
// who counts as the owner. A credential (a delegation token) is not part of identity.

export interface Identity {
  tenant?: string;
  actor: string;
  onBehalfOf?: string;
}

/** The identity of a principal, or `undefined` when it names no actor (it cannot own or join anything). */
export function identityOf(principal: PrincipalChain | undefined): Identity | undefined {
  if (principal === undefined) return undefined;
  const actor = principal.actor;
  if (typeof actor !== "string" || actor.trim() === "") return undefined;
  return {
    actor,
    ...(typeof principal.tenant === "string" && { tenant: principal.tenant }),
    ...(typeof principal.onBehalfOf === "string" && { onBehalfOf: principal.onBehalfOf }),
  };
}

/** A stable key for an identity. */
export function identityKey(i: Identity): string {
  return JSON.stringify([i.tenant ?? null, i.actor, i.onBehalfOf ?? null]);
}

export function sameIdentity(a: Identity | undefined, b: Identity | undefined): boolean {
  return a !== undefined && b !== undefined && identityKey(a) === identityKey(b);
}

/** Validate an untrusted value as an identity (log content, a request body). */
export function parseIdentity(v: unknown): Identity | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.actor !== "string" || o.actor.trim() === "" || o.actor.length > 256)
    return undefined;
  for (const k of ["tenant", "onBehalfOf"] as const) {
    if (o[k] !== undefined && (typeof o[k] !== "string" || (o[k] as string).length > 256)) {
      return undefined;
    }
  }
  return {
    actor: o.actor,
    ...(typeof o.tenant === "string" && { tenant: o.tenant }),
    ...(typeof o.onBehalfOf === "string" && { onBehalfOf: o.onBehalfOf }),
  };
}

/**
 * The key the kernel dedupes a message on (`MESSAGE_CONSUMED.messageId`, ADR 0110 D6): SHA-256 of
 * `[tenant, actor, onBehalfOf, messageId]` for the SENDER the runtime recorded. The client stamps it into
 * the payload so a barge-in watcher can tell a sender's own retry from someone else replaying the id.
 */
export function senderKey(
  sender: { tenant?: string; actor?: string; onBehalfOf?: string },
  messageId: string
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([sender.tenant ?? "", sender.actor ?? "", sender.onBehalfOf ?? "", messageId])
    )
    .digest("hex");
}

// ── Host-signed envelopes (shared mode) ───────────────────────────────────────────────────────────
//
// In shared mode the asker is named INSIDE the message, because the sender the runtime records is the
// host. The inbox is writable by anything the runtime's policy admits, so the body accepts an asker only
// from an envelope signed with the host's key: a colleague who can raw-`send` cannot speak as someone else.

function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x !== null && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as object).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x
  );
}

/** The domain every inbox envelope is signed under, so a MAC made for another purpose with the same key is not one. */
export const ENVELOPE_DOMAIN = "loom/conversation/envelope/v1";

/**
 * HMAC-SHA-256 of the canonical body under `key`, separated by `domain` (empty = none: the turn-id derivation
 * keeps its original input so ids of in-flight turn executions do not move).
 */
export function sign(key: string, body: Record<string, unknown>, domain = ""): string {
  const input = domain === "" ? canonical(body) : `${domain}\u0000${canonical(body)}`;
  return createHmac("sha256", key).update(input).digest("hex");
}

/** Verify against `key` and, for a rotation window, any of `previous`. */
export function verifySignature(
  key: string | readonly string[],
  body: Record<string, unknown>,
  sig: unknown,
  domain = ""
): boolean {
  if (typeof sig !== "string" || sig.length !== 64) return false;
  const got = Buffer.from(sig, "hex");
  let ok = false;
  for (const k of typeof key === "string" ? [key] : key) {
    const want = Buffer.from(sign(k, body, domain), "hex");
    // no early exit: the time taken does not say which key matched
    if (got.length === want.length && timingSafeEqual(got, want)) ok = true;
  }
  return ok;
}

// ── Participants ─────────────────────────────────────────────────────────────────────────────────────

export interface ParticipantChange {
  op: "add" | "remove";
  identity: Identity;
  by: Identity;
}

/**
 * The participant set of shared conversations. Reads are consulted on EVERY request (a removal takes
 * effect on the next one) and by the conversation body, inside a recorded decision, when it dequeues a turn.
 */
export interface ParticipantDirectory {
  list(conversationId: string): Promise<Identity[]>;
  apply(conversationId: string, change: ParticipantChange): Promise<void>;
}

export const MAX_PARTICIPANTS = 100;
const MAX_CHANGES = 2000;
const MEMBERS_WORKFLOW = "conversation-participants";

export class ParticipantLimitError extends Error {
  readonly code = "PARTICIPANT_LIMIT";
  constructor() {
    super(`a conversation holds at most ${MAX_PARTICIPANTS} participants`);
    this.name = "ParticipantLimitError";
  }
}

function fold(
  events: readonly { eventType?: string; workflowId?: string; payload: unknown }[]
): Identity[] {
  const set = new Map<string, Identity>();
  for (const e of events) {
    // Anyone who can start an execution under this stream's id can write ITS first event; only our own
    // change events count, whoever else has written there.
    if (e.eventType !== "PARTICIPANT_CHANGED" || e.workflowId !== MEMBERS_WORKFLOW) continue;
    const p = e.payload as { op?: unknown; identity?: unknown } | null;
    const identity = parseIdentity(p?.identity);
    if (identity === undefined) continue;
    if (p?.op === "add") set.set(identityKey(identity), identity);
    else if (p?.op === "remove") set.delete(identityKey(identity));
  }
  return [...set.values()];
}

/**
 * The standard directory: an append-only side stream `conversation-participants:<id>` on the event store,
 * one `PARTICIPANT_CHANGED` event per change, so membership is a durable, ordered, auditable log (who added
 * whom, when) shared by every node that reads the same store. It is NOT the conversation's own log (a
 * sender must never append to the owner's log; ADR 0110 D1) and not a kernel stream.
 */
export function logParticipants(
  store: EventStore,
  now: () => number = Date.now
): ParticipantDirectory {
  const streamOf = (id: string) => `conversation-participants:${id}`;
  return {
    async list(conversationId) {
      const stream = streamOf(conversationId);
      const tip = await headOf(store, stream);
      if (tip === null) return [];
      return fold(await readRangeOf(store, stream, 0, Math.min(tip, MAX_CHANGES)));
    },
    async apply(conversationId, change) {
      const stream = streamOf(conversationId);
      for (let attempt = 0; attempt < 32; attempt++) {
        const tip = await headOf(store, stream);
        const next = (tip ?? -1) + 1;
        if (next >= MAX_CHANGES) throw new Error("participant change log is full; compact it");
        const events = tip === null ? [] : await readRangeOf(store, stream, 0, tip);
        const current = fold(events);
        if (
          change.op === "add" &&
          current.length >= MAX_PARTICIPANTS &&
          !current.some((i) => sameIdentity(i, change.identity))
        ) {
          throw new ParticipantLimitError();
        }
        try {
          await store.append({
            id: `${stream}#${next}`,
            workflowId: MEMBERS_WORKFLOW,
            executionId: stream,
            eventType: "PARTICIPANT_CHANGED",
            sequence: next,
            timestamp: now(),
            payload: change,
          });
          return;
        } catch (err) {
          if (err instanceof DuplicateSequenceError) continue; // another writer took the slot: re-read
          throw err;
        }
      }
      throw new Error("could not record the participant change (contended)");
    },
  };
}
