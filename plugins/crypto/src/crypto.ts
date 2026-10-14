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

/** The algorithm id every sealed envelope carries; the `cipher` of a `metadata.seal` marker (ADR 0130 residuals D7). */
export const CIPHER_ID = ENC_TAG;

/**
 * Where a deterministic cipher seam is asked for an IV: the stream, the envelope's sequence and the
 * sealed path (a wildcard path that seals several values is asked once per value, suffixed `#n`).
 * The seam itself ({@link IvSource}) is exported only from `@loom/plugin-crypto/testing`.
 */
export interface IvContext {
  readonly streamId: string;
  readonly sequence: number;
  readonly path: string;
}

/**
 * An IV source for the deterministic cipher seam (testing only; see `@loom/plugin-crypto/testing`).
 * Nominal: only {@link brandIvSource} (reachable from the `/testing` subpath alone) mints one, so a
 * plain function does not type-check AND is refused at run time ({@link assertIvSourceAllowed}).
 */
export type IvSource = ((ctx: IvContext) => Uint8Array) & { readonly __loomTestingIvSource: true };

/** Module-private: the IV sources minted by the testing subpath. A plain function is never in it. */
const BRANDED_IV_SOURCES = new WeakSet<object>();

/** Mint an {@link IvSource}. NOT exported from the main entry; only `testing.ts` calls it. */
export function brandIvSource(fn: (ctx: IvContext) => Uint8Array): IvSource {
  const branded = ((ctx: IvContext) => fn(ctx)) as IvSource;
  BRANDED_IV_SOURCES.add(branded);
  return branded;
}

interface EncEnvelope {
  __loomEnc: typeof ENC_TAG;
  iv: string;
  tag: string;
  data: string;
  /**
   * Optional, self-describing AAD marker: the VERSION of the context binding this envelope was
   * sealed with. Present iff the sealer passed `aad`; the bound context itself (never stored)
   * is supplied again on open. Absent on every field-level envelope (no AAD, as before).
   */
  aad?: string;
}

/** AES-GCM additional authenticated data: a versioned tag plus the context it binds. */
export interface EnvelopeAad {
  /** Format version tag, stored in the envelope (`aad`). */
  v: string;
  /** The bound context (not stored): authenticated, so a moved envelope fails to open. */
  bind: string;
}

function isEnvelope(v: unknown): v is EncEnvelope {
  return (
    typeof v === "object" && v !== null && (v as { __loomEnc?: unknown }).__loomEnc === ENC_TAG
  );
}

function aadBytes(v: string, bind: string): Buffer {
  return Buffer.from(`${v}|${bind}`, "utf-8");
}

export function encryptValue(
  key: Buffer,
  value: unknown,
  aad?: EnvelopeAad,
  ivOverride?: Uint8Array,
): EncEnvelope {
  // Production default: a fresh random IV per value. `ivOverride` exists only for the deterministic
  // cipher seam (testing subpath); a reused IV under AES-GCM breaks confidentiality.
  const iv = ivOverride === undefined ? randomBytes(12) : Buffer.from(ivOverride);
  if (iv.length !== 12) throw new RangeError("an AES-GCM IV must be exactly 12 bytes");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad !== undefined) cipher.setAAD(aadBytes(aad.v, aad.bind));
  const plaintext = Buffer.from(JSON.stringify(value ?? null), "utf-8");
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    __loomEnc: ENC_TAG,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
    ...(aad !== undefined && { aad: aad.v }),
  };
}

/** The AAD marker of an envelope (`undefined` when it was sealed without AAD). */
export function envelopeAad(envelope: unknown): string | undefined {
  return isEnvelope(envelope) && typeof envelope.aad === "string" ? envelope.aad : undefined;
}

/**
 * Open an envelope. `bind` is the context an AAD-sealed envelope was bound to; an envelope that
 * carries the marker but is opened without one (or with another) fails authentication. An
 * envelope with no marker ignores `bind` (the field-level path).
 */
export function decryptValue(key: Buffer, envelope: unknown, bind?: string): unknown {
  if (!isEnvelope(envelope)) return envelope; // not encrypted — passthrough
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  if (envelope.aad !== undefined) {
    if (bind === undefined) throw new Error("envelope is AAD-bound but no context was supplied");
    decipher.setAAD(aadBytes(envelope.aad, bind));
  }
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

/**
 * The deterministic cipher seam is for simulation only: a reused or predictable IV under AES-GCM
 * breaks confidentiality. A custom IV source is refused unless branded by the testing subpath AND running under test.
 */
export function assertIvSourceAllowed(ivSource: IvSource | undefined, who: string): void {
  if (ivSource === undefined) return;
  // Fail CLOSED: the seam is allowed only for a value the testing subpath minted, and only inside a
  // test run (NODE_ENV "test" or a vitest process). An unset NODE_ENV is not "not production".
  if (typeof ivSource !== "function" || !BRANDED_IV_SOURCES.has(ivSource)) {
    throw new Error(
      `${who}: \`ivSource\` must be minted by @loom/plugin-crypto/testing (seededIvSource); a plain function is refused (a deterministic IV breaks AES-GCM confidentiality).`
    );
  }
  if (
    process.env.NODE_ENV === "production" ||
    (process.env.NODE_ENV !== "test" && process.env.VITEST === undefined)
  ) {
    throw new Error(
      `${who}: a custom \`ivSource\` is allowed only in a test run (NODE_ENV "test" or VITEST set, and never NODE_ENV "production"); it is refused here (a deterministic IV breaks AES-GCM confidentiality). It exists for seeded simulation only; see @loom/plugin-crypto/testing.`
    );
  }
}
