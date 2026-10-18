import { REDACTED, expandPaths, maskPaths } from "@loom/classify";
import type { EventEnvelope } from "@loom/core";
import {
  GUARD_WALK_BUDGET,
  type Lifted,
  type SensitiveStateContext,
  SensitiveStateError,
  isCipherEnvelope,
  isLiftable,
  walkBounded,
} from "./sensitiveState";
import type { SensitiveMap } from "./types";

// ── ADR 0132 D11 — the fold-input half of the sensitive-state guard (pure) ────

/** Declared paths for the event's type, plus the `EVENT_TYPE.path` entries of its own `metadata.seal` marker. */
export function sensitivePathsFor(event: EventEnvelope, declared: SensitiveMap): string[] {
  const out = new Set<string>(declared[event.eventType] ?? []);
  const covers = (event.metadata as { seal?: { covers?: unknown } } | undefined)?.seal?.covers;
  if (Array.isArray(covers)) {
    const prefix = `${event.eventType}.`;
    for (const c of covers) {
      if (typeof c === "string" && c.startsWith(prefix)) out.add(c.slice(prefix.length));
    }
  }
  return [...out].sort();
}

function valueAt(root: unknown, path: string): unknown {
  let v = root;
  for (const seg of path.split(".")) {
    if (typeof v !== "object" || v === null || !Object.hasOwn(v, seg)) return undefined;
    v = (v as Record<string, unknown>)[seg];
  }
  return v;
}

/** Drop duplicates and any path that has a strict ancestor in the set (maskPaths cannot mask both). */
function pruneOverlap(paths: readonly string[]): string[] {
  const set = new Set(paths);
  return [...set].filter((p) => {
    for (const q of set) if (q !== p && p.startsWith(`${q}.`)) return false;
    return true;
  });
}

/** Lift scalars AND object keys under a sensitive value, never descending into a cipher envelope. */
function liftFrom(
  at: unknown,
  ctx: SensitiveStateContext,
  path: string,
  lifted: MutableLifted
): void {
  const add = (v: unknown): void => {
    if (!isLiftable(v)) return;
    if (typeof v === "string") lifted.strings.add(v);
    else lifted.numbers.add(v);
  };
  const queue: unknown[] = [at];
  for (let i = 0; i < queue.length; i++) {
    if (queue.length > GUARD_WALK_BUDGET)
      throw new SensitiveStateError(ctx, "unverifiable", `payload.${path}`);
    const v = queue[i];
    add(v);
    if (typeof v !== "object" || v === null || isCipherEnvelope(v)) continue;
    if (Array.isArray(v)) {
      for (const c of v) queue.push(c);
      continue;
    }
    for (const [k, c] of Object.entries(v)) {
      add(k);
      queue.push(c);
    }
  }
}

interface MutableLifted {
  strings: Set<string>;
  numbers: Set<number>;
}

const sealReplacer = (_k: string, v: unknown): unknown => (isCipherEnvelope(v) ? REDACTED : v);

/**
 * The event a handler is given: every effective sensitive path replaced by `"[redacted]"` and any
 * cipher envelope elsewhere replaced the same way. Always a FRESH JSON-shaped copy (never the shared
 * envelope), so a handler that mutates it cannot affect another model or a row extractor, and a live
 * event folds exactly like its catch-up (JSON) twin. Also returns the scalar values and object keys
 * found under the sensitive paths of the ORIGINAL event, built only through `isLiftable`, which
 * `assertStateClean` checks the new state against.
 */
export function foldView(
  modelId: string,
  event: EventEnvelope,
  declared: SensitiveMap
): { event: EventEnvelope; lifted: Lifted } {
  const ctx = {
    modelId,
    executionId: event.executionId,
    eventType: event.eventType,
    sequence: event.sequence,
  };
  const unverifiable = (where = "payload"): SensitiveStateError =>
    new SensitiveStateError(ctx, "unverifiable", where);
  // Bound the WHOLE payload first, so a huge wildcard array fails closed before any expansion.
  if (!walkBounded(event.payload, () => {})) throw unverifiable();
  let norm: unknown;
  try {
    norm = event.payload === undefined ? undefined : JSON.parse(JSON.stringify(event.payload));
  } catch {
    throw unverifiable(); // not JSON-representable (cycle, BigInt, ...)
  }
  const lifted: MutableLifted = { strings: new Set<string>(), numbers: new Set<number>() };
  let payload = norm;
  const declaredPaths = sensitivePathsFor(event, declared);
  if (declaredPaths.length > 0 && typeof norm === "object" && norm !== null) {
    const paths = pruneOverlap(expandPaths(norm, declaredPaths));
    const present: string[] = [];
    for (const path of paths) {
      const at = valueAt(norm, path);
      if (at === undefined) continue;
      present.push(path);
      liftFrom(at, ctx, path, lifted);
    }
    // Mask under a wrapper: maskPaths leaves an array root untouched, but paths address it.
    const masked = (
      maskPaths(
        { p: norm },
        present.map((p) => `p.${p}`)
      ) as { p: unknown }
    ).p;
    for (const path of present) {
      if (valueAt(masked, path) !== REDACTED) throw unverifiable(`payload.${path}`);
    }
    payload = masked;
  }
  // Ciphertext anywhere else never reaches a handler; the round trip also copies everything.
  let view: EventEnvelope;
  try {
    view = JSON.parse(JSON.stringify({ ...event, payload }, sealReplacer));
  } catch {
    throw unverifiable();
  }
  return { event: view, lifted };
}
