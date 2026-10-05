import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "@loom/core";
import type { PrincipalChain } from "@loom/effect-runtime";
import type {
  ResumeAuthenticator,
  ResumeEvent,
  ResumeVerdict,
  ResumeVerificationContext,
} from "./types";

/**
 * R13 (ADR 0117) — the first-party reference {@link ResumeAuthenticator}.
 *
 * Loom shipped the SPI and no implementation, so with none wired ANY caller of `resume()`
 * approved anything. This one answers "who approved": the approver signs the resume event with a
 * per-actor secret; the runtime verifies it and records `APPROVAL_GRANTED { actor, verifiedBy }`.
 *
 * Wire shape. The approver's payload carries `proof: { actor, sig, exp }`:
 *   sig = HMAC-SHA256(secret(actor), canonicalJson({ eventType, payload-without-proof,
 *                       discardLegacyAnswers, actor, exp, executionId, parkedAtSequence }))
 * So the signature covers the WHOLE event — the answer, the echoed `viewDigest` (what the
 * approver saw), any `discardLegacyAnswers` override — AND the park it answers: the execution id
 * and the sequence of the parking `EXECUTION_SUSPENDED` (the runtime hands both to `verify`).
 * Sign with {@link signResume}, passing the execution id and `runtime.parkedAtSequence(id)`.
 *
 * What that buys, and what it does not:
 *  - SINGLE USE per park. An approval cannot be replayed at another execution (a fork of this
 *    one included — it has its own id and copies the parent's park), nor at a LATER park of the
 *    same gate in the same execution (a loop), nor read out of one execution's log and reused.
 *  - `exp` is REQUIRED: a signature that never expires is a standing credential for as long as
 *    that park stays open. Keep it short. The park binding, not `exp`, is what stops replay.
 *  - The signed `actor` must match the principal the call arrived with, when it carries one
 *    (override with `requireActor`). The recorded actor is the one whose key signed.
 *  - Secrets are at least {@link MIN_SECRET_BYTES} bytes; shorter ones are refused when the
 *    authenticator is built (a record) or when an actor is looked up (a function).
 *  - The secret store and role model are yours: `keys` resolves an actor to a secret — or to
 *    several, for rotation — and `authorize` adds a role/grant check.
 *  - Events for gates not listed in `gates` are `not-applicable` (timer wakes, recovery).
 */
export interface SignedResumeOptions {
  /** The gate (resume event) names that carry approval semantics. Everything else is `not-applicable`. */
  gates: readonly string[];
  /**
   * actor → shared secret(s). A record (own keys only) or a lookup over your key store. Return
   * several to rotate: a signature made with ANY of them verifies, so add the new key, re-issue
   * signers, then drop the old one.
   */
  keys:
    | Readonly<Record<string, string | readonly string[]>>
    | ((actor: string) => string | readonly string[] | undefined);
  /** Optional role/grant check, run only after the signature verifies. */
  authorize?: (actor: string, event: ResumeEvent) => boolean;
  /**
   * Does the signing actor match the caller? Run after the signature verifies. Default: when
   * the call carries a principal with an `actor`, it must equal the proof's actor; a call with
   * no principal (or no actor on it) is accepted — the proof is then the only identity, which
   * is what a non-strict runtime has. A strict runtime always has a principal.
   */
  requireActor?: (actor: string, principal: PrincipalChain | undefined) => boolean;
  /** Clock for `exp`. Default `Date.now`. */
  now?: () => number;
}

export const SIGNED_RESUME_VERIFIED_BY = "hmac-sha256";
/** Shortest secret accepted. An empty or tiny one is a guessable credential. */
export const MIN_SECRET_BYTES = 16;

interface Proof {
  actor?: unknown;
  sig?: unknown;
  exp?: unknown;
}

function message(
  event: ResumeEvent,
  payload: Record<string, unknown>,
  actor: string,
  exp: number,
  executionId: string,
  parkedAtSequence: number
) {
  return canonicalJson({
    eventType: event.eventType,
    payload,
    discardLegacyAnswers: event.discardLegacyAnswers ?? null,
    actor,
    exp,
    executionId,
    parkedAtSequence,
  });
}

const hmac = (secret: string, msg: string): Buffer =>
  createHmac("sha256", secret).update(msg).digest();

const secretsOf = (v: string | readonly string[] | undefined): readonly string[] =>
  v === undefined ? [] : typeof v === "string" ? [v] : v;

const isStrong = (secret: unknown): secret is string =>
  typeof secret === "string" && Buffer.byteLength(secret, "utf8") >= MIN_SECRET_BYTES;

/**
 * Sign a resume event as `actor`, for ONE park: `executionId` and `parkedAtSequence`
 * (`runtime.parkedAtSequence(executionId)`, or the `state.sequence` of the state the park
 * returned) go into the MAC. `exp` is an absolute ms epoch, required. Returns a new event whose
 * payload carries the `proof`.
 */
export function signResume(
  event: ResumeEvent,
  signer: {
    actor: string;
    secret: string;
    exp: number;
    executionId: string;
    parkedAtSequence: number;
  }
): ResumeEvent {
  if (!isStrong(signer.secret)) {
    throw new Error(`signResume: the secret must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  const { proof: _replaced, ...payload } =
    event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const sig = hmac(
    signer.secret,
    message(event, payload, signer.actor, signer.exp, signer.executionId, signer.parkedAtSequence)
  ).toString("hex");
  return {
    ...event,
    payload: { ...payload, proof: { actor: signer.actor, sig, exp: signer.exp } },
  };
}

export function signedResumeAuthenticator(options: SignedResumeOptions): ResumeAuthenticator {
  const gates = new Set(options.gates);
  const now = options.now ?? Date.now;
  const k = options.keys;
  if (typeof k !== "function") {
    for (const [actor, v] of Object.entries(k)) {
      for (const secret of secretsOf(v)) {
        if (!isStrong(secret)) {
          throw new Error(
            `signedResumeAuthenticator: the secret for "${actor}" is empty or shorter than ${MIN_SECRET_BYTES} bytes`
          );
        }
      }
    }
  }
  const secretsFor = (actor: string): readonly string[] => {
    if (typeof k === "function") return secretsOf(k(actor));
    return Object.hasOwn(k, actor) ? secretsOf(k[actor]) : [];
  };
  const actorMatches =
    options.requireActor ??
    ((actor: string, principal: PrincipalChain | undefined) =>
      typeof principal?.actor !== "string" || principal.actor === actor);
  const reject = (reason: string): ResumeVerdict => ({ status: "rejected", reason });

  return {
    verify(event: ResumeEvent, context?: ResumeVerificationContext): ResumeVerdict {
      if (!gates.has(event.eventType)) return { status: "not-applicable" };
      if (context === undefined || context.parkedAtSequence === undefined) {
        return reject(
          "approval cannot be bound to a park (no execution context, or the execution is not parked)"
        );
      }
      const p = event.payload;
      if (p === null || typeof p !== "object" || Array.isArray(p)) {
        return reject("approval carries no signed proof (payload is not an object)");
      }
      const { proof, ...rest } = p as Record<string, unknown>;
      const { actor, sig, exp } = (proof ?? {}) as Proof;
      if (typeof actor !== "string" || actor.trim() === "") {
        return reject("approval names no actor — an approval nobody made cannot be attributed");
      }
      if (typeof sig !== "string") return reject("approval carries no signature");
      if (typeof exp !== "number" || !Number.isFinite(exp)) {
        return reject("approval carries no expiry (exp is required)");
      }
      const secrets = secretsFor(actor);
      if (secrets.length === 0) return reject(`"${actor}" is not a known approver`);
      const given = Buffer.from(sig, "hex");
      const msg = message(event, rest, actor, exp, context.executionId, context.parkedAtSequence);
      let matched = false;
      for (const secret of secrets) {
        if (!isStrong(secret)) continue;
        const expected = hmac(secret, msg);
        if (given.length === expected.length && timingSafeEqual(given, expected)) matched = true;
      }
      if (!matched) {
        return reject(
          "signature does not verify — the event was altered, signed with another key, or signed for another execution or park"
        );
      }
      if (now() > exp) return reject("approval has expired");
      if (!actorMatches(actor, context.principal)) {
        return reject(`"${actor}" is not the principal making this call`);
      }
      if (options.authorize !== undefined && !options.authorize(actor, event)) {
        return reject(`"${actor}" is not authorized to approve this gate`);
      }
      return { status: "verified", actor, verifiedBy: SIGNED_RESUME_VERIFIED_BY };
    },
  };
}
