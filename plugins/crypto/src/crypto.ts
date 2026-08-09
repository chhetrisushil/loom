import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { expandPaths, hasWildcard } from "@loom/classify";

// ── K10.2 — field-level AES-256-GCM envelope ─────────────────────────────────
//
// Only fields marked sensitive are encrypted (A4 — field-level, opt-in: an
// unmarked payload is stored verbatim, zero overhead). The ciphertext replaces
// the field value in place with a self-describing envelope; a random IV per
// value means encryption is at APPEND time (live) and never enters the fold —
// replay decrypts the stored ciphertext back to identical plaintext (P2).

const ENC_TAG = "loom/aes-256-gcm";

interface EncEnvelope {
  __loomEnc: typeof ENC_TAG;
  iv: string;
  tag: string;
  data: string;
}

function isEnvelope(v: unknown): v is EncEnvelope {
  return (
    typeof v === "object" && v !== null && (v as { __loomEnc?: unknown }).__loomEnc === ENC_TAG
  );
}

export function encryptValue(key: Buffer, value: unknown): EncEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value ?? null), "utf-8");
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    __loomEnc: ENC_TAG,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

export function decryptValue(key: Buffer, envelope: unknown): unknown {
  if (!isEnvelope(envelope)) return envelope; // not encrypted — passthrough
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf-8")) as unknown;
}

/** True if any path in `obj` still holds an encryption envelope. */
export function hasEnvelope(obj: unknown): boolean {
  if (isEnvelope(obj)) return true;
  if (Array.isArray(obj)) return obj.some(hasEnvelope);
  if (typeof obj === "object" && obj !== null) {
    return Object.values(obj).some(hasEnvelope);
  }
  return false;
}

// ── dot-path transform (structural sharing, so inputs are never mutated) ──────

function shallowCopy(v: object): Record<string, unknown> {
  return (Array.isArray(v) ? [...v] : { ...v }) as Record<string, unknown>;
}

/**
 * Return `root` with `transform` applied at each dot-path that exists — inputs
 * are never mutated. Missing paths are skipped (a field a given event doesn't
 * carry).
 *
 * Structural sharing, not a full deep clone: only the objects on the SPINE to
 * each marked path are copied (shallowly); every untouched subtree is shared by
 * reference. So a 100 KB payload with two marked fields copies ~two small
 * objects instead of JSON-round-tripping the whole thing. Safe because the
 * copied spine is the only structure written to, and callers treat the result
 * as immutable (the transform replaces leaf values, e.g. encrypt/decrypt).
 */
export function mapPaths(
  root: unknown,
  paths: readonly string[],
  transform: (value: unknown) => unknown
): unknown {
  if (paths.length === 0 || typeof root !== "object" || root === null) return root;
  // `[]` segments are resolved against the concrete value first, so a mark inside an array
  // element reaches every element (#260). Paths without one pass through untouched.
  const targets = hasWildcard(paths) ? expandPaths(root, paths) : paths;
  const out = shallowCopy(root);
  for (const path of targets) {
    const segs = path.split(".");
    let src = root as Record<string, unknown>; // reads from the ORIGINAL
    let dst = out; // writes into the copied spine
    let reachable = true;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i] as string;
      const child = src[seg];
      if (typeof child !== "object" || child === null) {
        reachable = false;
        break;
      }
      // Copy this spine node once (first path to reach it); later paths sharing
      // the prefix descend into the already-copied node (dst[seg] !== src[seg]).
      if (dst[seg] === child) dst[seg] = shallowCopy(child);
      src = child as Record<string, unknown>;
      dst = dst[seg] as Record<string, unknown>;
    }
    const leaf = segs[segs.length - 1] as string;
    if (reachable && Object.hasOwn(src, leaf)) {
      dst[leaf] = transform(src[leaf]);
    }
  }
  return out;
}
