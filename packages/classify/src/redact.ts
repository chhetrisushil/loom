// ── K10-R6 — the shared egress-masking primitive ──────────────────────────────
//
// One structural path-masker, used by every egress surface (telemetry adapters, agent-surface
// surfaces, the CLI). It replaces the value at each dot-path with a mask, copying only the
// spine it touches (structural sharing elsewhere) and never mutating the caller's object.
// Absent paths are skipped, so masking a payload that doesn't carry a marked field is a
// no-op on that field. Lives here in `@loom/classify` — the neutral home the classification
// consumers already depend on — so no surface package depends on another.

/** The value an egress-masked field is replaced by (structure kept, value gone). */
export const REDACTED = "[redacted]" as const;

/**
 * Return a copy of `root` with each dot-path's value replaced by `mask`. A dot-path always
 * roots at an object (an array/primitive root has nothing to address), so those are returned
 * as-is. Paths are applied independently; a shared prefix is copied once.
 */
export function maskPaths(
  root: unknown,
  paths: readonly string[],
  mask: unknown = REDACTED
): unknown {
  if (typeof root !== "object" || root === null || Array.isArray(root)) return root;
  const out: Record<string, unknown> = { ...(root as Record<string, unknown>) };
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
      // Copy this spine node once (first path to reach it); later paths sharing the prefix
      // descend into the already-copied node.
      if (dst[seg] === child) dst[seg] = { ...(child as Record<string, unknown>) };
      src = child as Record<string, unknown>;
      dst = dst[seg] as Record<string, unknown>;
    }
    const leaf = segs[segs.length - 1] as string;
    if (reachable && Object.hasOwn(src, leaf)) dst[leaf] = mask;
  }
  return out;
}
