import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

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
    typeof v === "object" &&
    v !== null &&
    (v as { __loomEnc?: unknown }).__loomEnc === ENC_TAG
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

// ── dot-path get/set (structural clone on write, so inputs are never mutated) ─

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/**
 * Return a deep copy of `root` with `transform` applied at each dot-path that
 * exists. Missing paths are skipped (a field a given event doesn't carry). Only
 * the marked paths are touched; everything else is copied verbatim.
 */
export function mapPaths(
  root: unknown,
  paths: readonly string[],
  transform: (value: unknown) => unknown
): unknown {
  if (paths.length === 0 || typeof root !== "object" || root === null) return root;
  const out = clone(root) as Record<string, unknown>;
  for (const path of paths) {
    const segs = path.split(".");
    let cursor: Record<string, unknown> | undefined = out;
    for (let i = 0; i < segs.length - 1; i++) {
      const child: unknown = cursor?.[segs[i] as string];
      cursor =
        typeof child === "object" && child !== null ? (child as Record<string, unknown>) : undefined;
      if (cursor === undefined) break;
    }
    const leaf = segs[segs.length - 1] as string;
    if (cursor !== undefined && Object.hasOwn(cursor, leaf)) {
      cursor[leaf] = transform(cursor[leaf]);
    }
  }
  return out;
}
