// ADR 0152 D1 (EVENT_SCHEMA 1.27.0, owner ruling R11) - `variables._seenOrigins`: the distinct taint origins of
// every tainted value that has crossed INTO this execution. The fold side: it only UNIONS the lists the journal
// recorded on the event's metadata at commit (`origins`, `originsOverflow`; see seenOriginsRecord.ts) and advances
// `through`, so it never opens a payload and replay never rescans. INERT unless `EXECUTION_STARTED` carries the
// `seenOriginsLimits` stamp or a carried set: an untracked run folds no key and is byte-identical to 1.26.0.
import type { EventEnvelope, ExecutionState } from "@loomwork/core";
import { chainIdentity, isPlain } from "./eventHandlers";

/** A consumer MUST treat this origin as "unknown, treat as foreign". */
export const SEEN_ORIGINS_OVERFLOW = "unknown:seen-origins-overflow";
export const SEEN_ORIGINS_KEY = "_seenOrigins";
/** The fixed per-origin cap (characters); a longer origin is replaced BEFORE dedupe and count. */
export const SEEN_ORIGIN_MAX_CHARS = 256;
export const SEEN_ORIGINS_DEFAULTS = { maxOrigins: 64, maxScanNodes: 10_000 } as const;
const RANGES = { maxOrigins: [1, 1024], maxScanNodes: [100, 100_000] } as const;

export interface SeenOriginsLimits {
  maxOrigins: number;
  maxScanNodes: number;
}
export interface SeenOriginsKey {
  v: 1;
  limits: SeenOriginsLimits;
  origins: string[];
  overflow?: true;
  through?: number;
}

function limitsOf(raw: unknown): SeenOriginsLimits {
  const pick = (name: keyof SeenOriginsLimits): number => {
    const v = isPlain(raw) ? raw[name] : undefined;
    const [lo, hi] = RANGES[name];
    return Number.isSafeInteger(v) && (v as number) >= lo && (v as number) <= hi
      ? (v as number)
      : SEEN_ORIGINS_DEFAULTS[name];
  };
  return { maxOrigins: pick("maxOrigins"), maxScanNodes: pick("maxScanNodes") };
}

/** fnv1a-64 (hex, 16 digits) of the UTF-8 bytes of `s`; deterministic, non-cryptographic. */
function fnv1a64(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(s))
    h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return h.toString(16).padStart(16, "0");
}

/** The origin as stored: over 256 characters becomes `unknown:truncated:<digest of the full origin>`. */
export function capOrigin(o: string): string {
  return o.length > SEEN_ORIGIN_MAX_CHARS ? `unknown:truncated:${fnv1a64(o)}` : o;
}

export function validKey(k: unknown): k is SeenOriginsKey {
  return (
    isPlain(k) &&
    k.v === 1 &&
    Array.isArray(k.origins) &&
    isPlain(k.limits) &&
    Number.isSafeInteger(k.limits.maxOrigins) &&
    Number.isSafeInteger(k.limits.maxScanNodes)
  );
}

/** Union a per-event (sorted) origin list into the key, copy-on-write. Overflow is sticky. */
function union(key: SeenOriginsKey, found: readonly string[]): SeenOriginsKey {
  let origins = key.origins;
  for (const o of found) {
    if (origins.includes(o)) continue;
    if (origins.length >= key.limits.maxOrigins) return { ...key, origins, overflow: true };
    if (origins === key.origins) origins = [...origins];
    origins.push(o);
  }
  return origins === key.origins ? key : { ...key, origins };
}

/** A validated carried set (`continuedFrom.carried.seenOrigins`); `undefined` when absent or malformed. */
export function seedSeenOrigins(
  raw: unknown,
  limits: SeenOriginsLimits
): SeenOriginsKey | undefined {
  if (!isPlain(raw) || !Array.isArray(raw.origins)) return undefined;
  const seen = new Set<string>();
  let overflow = raw.overflow === true;
  for (const o of raw.origins) if (typeof o === "string") seen.add(capOrigin(o));
  const origins = [...seen];
  if (origins.length > limits.maxOrigins) {
    origins.length = limits.maxOrigins;
    overflow = true;
  }
  return { v: 1, limits, origins, ...(overflow && { overflow: true as const }) };
}

/** The key `EXECUTION_STARTED` seeds, or `undefined` for an untracked run (no stamp, no carried set). */
export function startKey(event: EventEnvelope): SeenOriginsKey | undefined {
  const p = event.payload as { seenOriginsLimits?: unknown; continuedFrom?: unknown } | undefined;
  if (!isPlain(p)) return undefined;
  const meta = event.metadata;
  const forkChain = chainIdentity(meta?.forkChain);
  const from = p.continuedFrom;
  let carriedRaw: unknown;
  let continued = false;
  if (isPlain(from)) {
    if (forkChain !== undefined) {
      continued = true; // a fork follows `forkResources`
      if (isPlain(from.carried)) carriedRaw = from.carried.seenOrigins;
    } else if (
      chainIdentity(p) !== undefined &&
      typeof from.executionId === "string" &&
      (from.carried === undefined || isPlain(from.carried))
    ) {
      continued = true;
      if (isPlain(from.carried)) carriedRaw = from.carried.seenOrigins;
    }
  }
  const stamped = p.seenOriginsLimits !== undefined;
  const limits = limitsOf(p.seenOriginsLimits);
  const carried = seedSeenOrigins(carriedRaw, limits);
  if (carried !== undefined) return { ...carried, through: 0 };
  if (!stamped) return undefined;
  // A successor of a keyless predecessor cannot prove a clean past.
  return { v: 1, limits, origins: [], ...(continued && { overflow: true as const }), through: 0 };
}

/** The channels (ADR table): the events whose value crosses into the run. Only these carry or honour a record. */
export const CHANNELS: ReadonlySet<string> = new Set([
  "STEP_COMPLETED",
  "MESSAGE_CONSUMED",
  "EXECUTION_RESUMED",
  "DECISION_RECORDED",
  "STEP_FAILED",
  "PARALLEL_COMPLETED",
  "EXECUTION_MIGRATED",
  "EXECUTION_STARTED",
]);

/**
 * The fold hook, called after each handler. It never opens a payload: a tracked run unions the RECORDED
 * `metadata.origins` (channel events only) and advances `through` on every event. Untracked runs pay one
 * property read. A key WITHOUT `through` (unproven) is never re-validated: it stays overflow until a rescan replaces it.
 */
export function trackSeenOrigins(state: ExecutionState, event: EventEnvelope): ExecutionState {
  let key: unknown = state.variables[SEEN_ORIGINS_KEY];
  let seeded = false;
  if (key === undefined) {
    if (event.eventType !== "EXECUTION_STARTED") return state;
    key = startKey(event);
    if (key === undefined) return state;
    seeded = true;
  }
  const fail = (limits: SeenOriginsLimits, origins: string[]): ExecutionState =>
    withKey(state, { v: 1, limits, origins, overflow: true });
  // A malformed key fails closed (overflow, unproven); an unproven key is left as it is.
  if (!validKey(key)) return fail(limitsOf(undefined), []);
  if (key.through === undefined) return state;
  // Defence for a path that did not normalize the snapshot: a key not advanced to the prior sequence is unproven.
  if (!seeded && key.through !== state.sequence) return fail(key.limits, key.origins);
  let k: SeenOriginsKey = key;
  if (k.overflow !== true && CHANNELS.has(event.eventType)) {
    const m = event.metadata;
    if (m?.originsOverflow === true) k = { ...k, overflow: true };
    else if (Array.isArray(m?.origins)) {
      k = union(
        k,
        (m.origins as unknown[]).filter((o): o is string => typeof o === "string")
      );
    } else k = { ...k, overflow: true }; // R13: no record on a channel event of a tracked run = not scanned = fail closed
  }
  return withKey(state, { ...k, through: event.sequence });
}

function withKey(state: ExecutionState, k: SeenOriginsKey): ExecutionState {
  state.variables = { ...state.variables, [SEEN_ORIGINS_KEY]: k };
  return state;
}

/**
 * Read-only staleness (ADR 0152 D1): a key whose `through` is not `state.sequence` was left behind by a fold that
 * did not advance it (a 1.26 node). It reads as overflow with `through` dropped (the "unproven" marker). O(1), pure.
 */
export function staleSeenOrigins<T extends Partial<ExecutionState>>(state: T): T {
  const key = state.variables?.[SEEN_ORIGINS_KEY];
  if (key === undefined) return state;
  if (
    validKey(key) &&
    (key.through === undefined ? key.overflow === true : key.through === state.sequence)
  ) {
    return state;
  }
  const base = validKey(key)
    ? key
    : { v: 1 as const, limits: limitsOf(undefined), origins: [] as string[] };
  const next: SeenOriginsKey = { v: 1, limits: base.limits, origins: base.origins, overflow: true };
  return { ...state, variables: { ...state.variables, [SEEN_ORIGINS_KEY]: next } };
}

/**
 * The carried set of a predecessor (`carriedOf`): `{ origins, overflow? }`, or `undefined` when the run is untracked.
 * A stale or unproven key carries overflow (a successor never inherits a "clean" it cannot prove).
 */
export function carrySeenOrigins(
  state: Partial<ExecutionState>
): { origins: string[]; overflow?: true } | undefined {
  const key = staleSeenOrigins(state).variables?.[SEEN_ORIGINS_KEY];
  if (!validKey(key)) return key === undefined ? undefined : { origins: [], overflow: true };
  return { origins: key.origins, ...(key.overflow === true && { overflow: true as const }) };
}
