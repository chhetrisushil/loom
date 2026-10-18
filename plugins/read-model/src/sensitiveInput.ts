import { REDACTED, expandPaths, maskPaths } from "@loom/classify";
import type { EventEnvelope } from "@loom/core";
import {
  type Lifted,
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

/**
 * The event a handler is given: every effective sensitive path replaced by `"[redacted]"` and any
 * cipher envelope elsewhere replaced the same way. Always a FRESH deep copy (never the shared
 * envelope), so a handler that mutates it cannot affect another model or a row extractor.
 * Also returns the scalar values found under the sensitive paths of the ORIGINAL event, built only
 * through `isLiftable`, which `assertStateClean` checks the new state against.
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
  const strings = new Set<string>();
  const numbers = new Set<number>();
  const paths = sensitivePathsFor(event, declared);
  let payload = event.payload;
  if (paths.length > 0 && typeof payload === "object" && payload !== null) {
    for (const path of expandPaths(payload, paths)) {
      const at = valueAt(payload, path);
      if (at === undefined || isCipherEnvelope(at)) continue; // nothing to lift from ciphertext
      const done = walkBounded(at, (leaf) => {
        if (!isLiftable(leaf)) return;
        if (typeof leaf === "string") strings.add(leaf);
        else numbers.add(leaf);
      });
      if (!done) throw new SensitiveStateError(ctx, "unverifiable", `payload.${path}`);
    }
    payload = maskPaths(payload, paths);
  }
  // Ciphertext anywhere else (a raw at-rest read, or a path nobody declared) never reaches a handler.
  let sealed = false;
  const complete = walkBounded(payload, (v) => {
    if (isCipherEnvelope(v)) sealed = true;
  });
  if (!complete) throw new SensitiveStateError(ctx, "unverifiable", "payload");
  if (sealed) {
    payload = JSON.parse(JSON.stringify(payload, (_k, v) => (isCipherEnvelope(v) ? REDACTED : v)));
  }
  // maskPaths shares unmasked subtrees with the original: deep-copy so nothing is shared.
  return { event: structuredClone({ ...event, payload }), lifted: { strings, numbers } };
}
