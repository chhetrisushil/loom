import { type KeyObject, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import type { ChainSigner, ChainVerifier } from "./hashChain";

// ── Third-party verifiable signing (#382) ─────────────────────────────────────
//
// Ed25519 from `node:crypto` — no dependency, no parameter choices to get wrong, and small
// signatures (64 bytes) for something stamped onto every event.
//
// Loom makes no trust-root decision here. It signs with the key you hand it, exactly as it
// HMACs with the secret you hand it; publishing the public key, and deciding whose key an
// auditor should trust, is a deployment concern that does not belong in a runtime.
//
// The key-lifecycle objection that keeps asymmetric DELEGATION deferred (#381) does not
// apply to an audit trail, and the difference is worth stating: a delegation token is a live
// capability that must be revocable, whereas an audit entry is a historical fact. Verifying
// a two-year-old entry against the key that signed it is CORRECT, so rotation is a `keyId`
// and there is no revocation problem to solve.

/** Accepts anything `node:crypto` can turn into a key: PEM, JWK, DER, or a KeyObject. */
export type KeyLike = KeyObject | string | Buffer;

/**
 * Sign chain hashes with an Ed25519 private key.
 *
 * `keyId` is stamped beside the signature so a verifier can select the right public key —
 * rotate by signing new entries with a new key while keeping the old public key published.
 */
export function ed25519Signer(privateKey: KeyLike, keyId: string): ChainSigner {
  const key = toPrivateKey(privateKey);
  if (keyId.length === 0) throw new Error("ed25519Signer: keyId must not be empty");
  return {
    keyId,
    sign(hash: string): string {
      // Ed25519 takes no digest algorithm — it hashes internally, so `null` is the contract.
      return sign(null, Buffer.from(hash, "utf8"), key).toString("base64");
    },
  };
}

/**
 * Verify chain signatures against published Ed25519 public keys, by `keyId`.
 *
 * Holding this cannot produce a signature. That is the property the whole issue is about:
 * an auditor handed a verifier is, cryptographically, no longer indistinguishable from the
 * system that wrote the log.
 *
 * A signature naming a key this verifier does not know is REJECTED, never skipped — an entry
 * whose authorship cannot be checked has not been checked.
 */
export function ed25519Verifier(publicKeys: Record<string, KeyLike>): ChainVerifier {
  const keys = new Map<string, KeyObject>();
  for (const [id, value] of Object.entries(publicKeys)) keys.set(id, toPublicKey(value));
  if (keys.size === 0) {
    throw new Error("ed25519Verifier: at least one public key is required to verify anything");
  }
  return {
    verify(hash: string, sig: string, keyId: string | undefined): boolean {
      // No keyId: nothing names which key to use, so there is no check to perform.
      if (keyId === undefined) return false;
      const key = keys.get(keyId);
      if (key === undefined) return false;
      let signature: Buffer;
      try {
        signature = Buffer.from(sig, "base64");
      } catch {
        return false;
      }
      // Ed25519 signatures are exactly 64 bytes; anything else cannot be one.
      if (signature.length !== 64) return false;
      try {
        return verify(null, Buffer.from(hash, "utf8"), key, signature);
      } catch {
        // A malformed signature must be a `false`, never a throw that aborts a sweep
        // partway through a log.
        return false;
      }
    },
  };
}

function isKeyObject(value: KeyLike): value is KeyObject {
  return typeof value === "object" && value !== null && "asymmetricKeyType" in value;
}

function toPrivateKey(value: KeyLike): KeyObject {
  const key = isKeyObject(value) ? value : createPrivateKey(value);
  assertEd25519(key, "private");
  return key;
}

function toPublicKey(value: KeyLike): KeyObject {
  const key = isKeyObject(value) ? toPublic(value) : createPublicKey(value);
  assertEd25519(key, "public");
  return key;
}

/** A private KeyObject verifies nothing; derive its public half rather than failing late. */
function toPublic(key: KeyObject): KeyObject {
  return key.type === "private" ? createPublicKey(key) : key;
}

function assertEd25519(key: KeyObject, kind: "private" | "public"): void {
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `audit-chain: expected an ed25519 ${kind} key, got ${key.asymmetricKeyType ?? "an unusable key"}`
    );
  }
}
