import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "@loom/core";
import type { ResumeAuthenticator, ResumeEvent, ResumeVerdict } from "./types";

/**
 * R13 (ADR 0117) — the first-party reference {@link ResumeAuthenticator}.
 *
 * Loom shipped the SPI and no implementation, so with none wired ANY caller of `resume()`
 * approved anything. This one answers "who approved": the approver signs the resume event with a
 * per-actor secret; the runtime verifies it and records `APPROVAL_GRANTED { actor, verifiedBy }`.
 *
 * Wire shape. The approver's payload carries `proof: { actor, sig, exp? }`:
 *   sig = HMAC-SHA256(secret(actor), canonicalJson({ eventType, payload-without-proof,
 *                                                     discardLegacyAnswers, actor, exp }))
 * So the signature covers the WHOLE event — the answer, the echoed `viewDigest` (what the
 * approver saw), and any `discardLegacyAnswers` override — which the SPI requires of a verifier.
 * Sign with {@link signResume}.
 *
 * What it does NOT do, stated plainly:
 *  - It does not know the execution id (the SPI hands `verify` the event only). Bind a signature
 *    to one execution by signing a payload that names it — a gate that declares a `viewDigest`
 *    already does (`approvalViewDigest` includes the gate key, which includes the execution id).
 *  - No replay window beyond `exp`: a signed event stays valid for the same gate until it
 *    expires. Set `exp`.
 *  - The secret store and role model are yours: `keys` resolves an actor to a secret (a record
 *    or a function over your own store); `authorize` adds a role/grant check.
 *  - Events for gates not listed in `gates` are `not-applicable` (timer wakes, recovery).
 */
export interface SignedResumeOptions {
  /** The gate (resume event) names that carry approval semantics. Everything else is `not-applicable`. */
  gates: readonly string[];
  /** actor → shared secret. A record (own keys only) or a lookup over your key store. */
  keys: Readonly<Record<string, string>> | ((actor: string) => string | undefined);
  /** Optional role/grant check, run only after the signature verifies. */
  authorize?: (actor: string, event: ResumeEvent) => boolean;
  /** Clock for `exp`. Default `Date.now`. */
  now?: () => number;
}

export const SIGNED_RESUME_VERIFIED_BY = "hmac-sha256";

interface Proof {
  actor?: unknown;
  sig?: unknown;
  exp?: unknown;
}

function message(
  event: ResumeEvent,
  payload: Record<string, unknown>,
  actor: string,
  exp: unknown
) {
  return canonicalJson({
    eventType: event.eventType,
    payload,
    discardLegacyAnswers: event.discardLegacyAnswers ?? null,
    actor,
    exp: exp ?? null,
  });
}

const hmac = (secret: string, msg: string): Buffer =>
  createHmac("sha256", secret).update(msg).digest();

/** Sign a resume event as `actor`. Returns a new event whose payload carries the `proof`. */
export function signResume(
  event: ResumeEvent,
  signer: { actor: string; secret: string; exp?: number }
): ResumeEvent {
  const { proof: _replaced, ...payload } =
    event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const sig = hmac(signer.secret, message(event, payload, signer.actor, signer.exp)).toString(
    "hex"
  );
  return {
    ...event,
    payload: {
      ...payload,
      proof: { actor: signer.actor, sig, ...(signer.exp !== undefined && { exp: signer.exp }) },
    },
  };
}

export function signedResumeAuthenticator(options: SignedResumeOptions): ResumeAuthenticator {
  const gates = new Set(options.gates);
  const now = options.now ?? Date.now;
  const secretOf = (actor: string): string | undefined => {
    const k = options.keys;
    if (typeof k === "function") return k(actor);
    return Object.hasOwn(k, actor) ? k[actor] : undefined;
  };
  const reject = (reason: string): ResumeVerdict => ({ status: "rejected", reason });

  return {
    verify(event: ResumeEvent): ResumeVerdict {
      if (!gates.has(event.eventType)) return { status: "not-applicable" };
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
      if (exp !== undefined && (typeof exp !== "number" || !Number.isFinite(exp))) {
        return reject("approval expiry is malformed");
      }
      const secret = secretOf(actor);
      if (secret === undefined) return reject(`"${actor}" is not a known approver`);
      const expected = hmac(secret, message(event, rest, actor, exp));
      const given = Buffer.from(sig, "hex");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return reject(
          "signature does not verify — the event was altered or signed with another key"
        );
      }
      if (typeof exp === "number" && now() > exp) return reject("approval has expired");
      if (options.authorize !== undefined && !options.authorize(actor, event)) {
        return reject(`"${actor}" is not authorized to approve this gate`);
      }
      return { status: "verified", actor, verifiedBy: SIGNED_RESUME_VERIFIED_BY };
    },
  };
}
