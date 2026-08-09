import { createHash } from "node:crypto";
import { expandPaths, hasWildcard } from "@loom/classify";

// ── ADR 0046 — content-addressed references ───────────────────────────────────
//
// A payload field can be *externalized*: its value is stored in a content store and the log
// keeps only a reference. The reference is content-ADDRESSED — the address is `hash(bytes)`,
// a pure function of the content — which is what preserves determinism (replay reproduces the
// same address), gives natural dedup (identical values collapse to one blob), and yields the
// refcount key for free (forks that copy a prefix share the same address).

/** A content-addressed reference standing in for an externalized value in the log. */
export interface ContentRef {
  /** The content address, e.g. `"sha256:<hex>"`. Uniquely and deterministically names the bytes. */
  readonly __loomContent: string;
  /** Byte length of the stored content (informational). */
  readonly size?: number;
  /** How the bytes decode back to a value (only `"json"` today). */
  readonly codec?: string;
}

export function isContentRef(value: unknown): value is ContentRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { __loomContent?: unknown }).__loomContent === "string"
  );
}

/** The content address of some bytes: `sha256:<hex>`. Pure — the same bytes always map here. */
export function contentAddress(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

// Stateless for whole-input encode/decode — hoisted (audit nit: decodeValue runs
// per ref occurrence during substitution, incl. the live tail).
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

/** Encode a value to bytes for the content store (JSON — the only codec today). */
export function encodeValue(value: unknown): Uint8Array {
  return UTF8_ENCODER.encode(JSON.stringify(value));
}

/** Decode content-store bytes back to the original value. */
export function decodeValue(bytes: Uint8Array): unknown {
  return JSON.parse(UTF8_DECODER.decode(bytes));
}

/** Whether a payload carries any {@link ContentRef} (the read-side fast path). */
export function hasContentRef(value: unknown): boolean {
  if (isContentRef(value)) return true;
  if (Array.isArray(value)) return value.some(hasContentRef);
  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>).some(hasContentRef);
  }
  return false;
}

/**
 * ADR 0062 — phase 1 of batched resolution: collect every {@link ContentRef} in
 * a payload into `into` (keyed by content address — duplicates collapse), and
 * report whether any was found. One walk replaces the old `hasContentRef`
 * pre-walk + per-ref fetch recursion.
 */
export function collectContentRefs(value: unknown, into: Map<string, ContentRef>): boolean {
  if (isContentRef(value)) {
    if (!into.has(value.__loomContent)) into.set(value.__loomContent, value);
    return true;
  }
  if (Array.isArray(value)) {
    let found = false;
    for (const v of value) if (collectContentRefs(v, into)) found = true;
    return found;
  }
  if (typeof value === "object" && value !== null) {
    let found = false;
    for (const v of Object.values(value as Record<string, unknown>)) {
      if (collectContentRefs(v, into)) found = true;
    }
    return found;
  }
  return false;
}

/**
 * ADR 0062 — phase 2 of batched resolution: pure rebuild substituting each
 * {@link ContentRef} from the fetched bytes. Decoding is deliberately
 * per-OCCURRENCE (the fetch dedupes by address — the expensive part — but two
 * payload sites never alias one decoded object). Ref-free subtrees are returned
 * as-is (structural sharing).
 */
export function substituteContentRefs(
  value: unknown,
  bytesByAddress: ReadonlyMap<string, Uint8Array>
): unknown {
  if (isContentRef(value)) {
    const bytes = bytesByAddress.get(value.__loomContent);
    // Callers guarantee every collected address was fetched; a miss here is a
    // programming error, surfaced loudly.
    if (bytes === undefined) throw new Error(`unfetched content ref: ${value.__loomContent}`);
    return decodeValue(bytes);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const r = substituteContentRefs(v, bytesByAddress);
      if (r !== v) changed = true;
      return r;
    });
    return changed ? out : value;
  }
  if (typeof value === "object" && value !== null) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = substituteContentRefs(v, bytesByAddress);
      out[k] = r;
      if (r !== v) changed = true;
    }
    return changed ? out : value;
  }
  return value;
}

function shallowCopy(value: object): Record<string, unknown> {
  return Array.isArray(value)
    ? ([...value] as unknown as Record<string, unknown>)
    : { ...(value as Record<string, unknown>) };
}

/**
 * Async structural path-mapper — like the crypto plugin's `mapPaths`, but the transform is
 * awaited (a content `put` is async). Copies only the spine it touches (structural sharing
 * elsewhere), never mutates `root`, and skips absent paths.
 */
export async function mapPathsAsync(
  root: unknown,
  paths: readonly string[],
  transform: (value: unknown) => Promise<unknown>
): Promise<unknown> {
  if (paths.length === 0 || typeof root !== "object" || root === null) return root;
  // `[]` segments are resolved against the concrete value first, so a mark inside an array
  // element reaches every element (#260). Paths without one pass through untouched.
  const targets = hasWildcard(paths) ? expandPaths(root, paths) : paths;
  const out = shallowCopy(root);
  for (const path of targets) {
    const segs = path.split(".");
    let src = root as Record<string, unknown>;
    let dst = out;
    let reachable = true;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i] as string;
      const child = src[seg];
      if (typeof child !== "object" || child === null) {
        reachable = false;
        break;
      }
      if (dst[seg] === child) dst[seg] = shallowCopy(child as object);
      src = child as Record<string, unknown>;
      dst = dst[seg] as Record<string, unknown>;
    }
    const leaf = segs[segs.length - 1] as string;
    if (reachable && Object.hasOwn(src, leaf)) dst[leaf] = await transform(src[leaf]);
  }
  return out;
}
