import { createHash } from "node:crypto";

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

/** Encode a value to bytes for the content store (JSON — the only codec today). */
export function encodeValue(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** Decode content-store bytes back to the original value. */
export function decodeValue(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes));
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
  const out = shallowCopy(root);
  for (const path of paths) {
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
