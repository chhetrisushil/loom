// ADR 0145 - the app-owned retention policy VALUE.
//
// A plain, frozen, validated object the app keeps in its own module and hands to the retention
// passes that already exist (`LogLifecycle.applyRetention` / `evaluate` / `pruneSnapshots`,
// `sweepUnpinnedContent`, `loom retention run --policy`). It carries no behaviour: nothing here
// schedules anything. Omitted, every pass behaves exactly as before.

/** Which retention rules an app has chosen. Library API is milliseconds. */
export interface RetentionPolicy {
  /** Keep a terminal execution this long after its last event, then reclaim it. */
  terminalTtlMs: number;
  /**
   * Snapshot pruning: keep the newest N snapshots of an execution. There is deliberately no age
   * clock - a compacted execution's checkpoint snapshot IS its state.
   */
  snapshots?: { keepLatest: number };
  /**
   * Content GC: reclaim a claim-check ref only once its effective citation time is this old. Must
   * be `>= terminalTtlMs`. Per ADR 0055 only a claim-check envelope's own ref the app marked
   * `reclaimable` is TTL-reclaimable (readers tolerate it; `resolveClaimCheck` returns null) -
   * retained blobs and bare refs are never TTL-reclaimed while cited. Per ADR 0146 the sweep ages a
   * terminal execution's citations from its END (never earlier than the citation), the instant
   * retention measures from (ADR 0140 D6), so with this rule a reclaimable blob outlives the log
   * citing it; a running execution keeps the citation clock. It holds only when `retention run`
   * and `sweep content` use the same policy (no bare `--ttl`).
   */
  content?: { unpinnedAfterMs: number };
}

/** A retention policy broke a rule; the message names the field and the fix. */
export class RetentionPolicyError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "RetentionPolicyError";
  }
}

const TOP_KEYS = new Set(["terminalTtlMs", "snapshots", "content"]);

function reject(message: string): never {
  throw new RetentionPolicyError(`retention policy: ${message}`);
}

function checkSection(
  name: string,
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject(`${name} must be an object with ${keys.map((k) => `"${k}"`).join(", ")}`);
  }
  for (const k of Object.keys(value)) {
    if (!keys.includes(k)) {
      reject(
        `unknown key "${name}.${k}" (expected ${keys.join(", ")}) - a typo would silently disable a rule`
      );
    }
  }
  return value as Record<string, unknown>;
}

/**
 * Read each field of `p` exactly once into plain objects, then validate THAT snapshot (so a
 * getter that answers differently on a second read cannot pass a rule-breaking value).
 */
function snapshotPolicy(p: unknown): RetentionPolicy {
  if (typeof p !== "object" || p === null || Array.isArray(p)) {
    reject("must be an object like { terminalTtlMs: 2_592_000_000 }");
  }
  for (const k of Object.keys(p)) {
    if (!TOP_KEYS.has(k)) {
      reject(
        `unknown key "${k}" (expected terminalTtlMs, snapshots, content) - a typo would silently disable a rule`
      );
    }
  }
  const o = p as Record<string, unknown>;
  const ttl = o.terminalTtlMs;
  const snapshots = o.snapshots;
  const content = o.content;
  if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 0) {
    reject(`terminalTtlMs must be a finite integer >= 0 (milliseconds); got ${String(ttl)}`);
  }
  const out: {
    terminalTtlMs: number;
    snapshots?: { keepLatest: number };
    content?: { unpinnedAfterMs: number };
  } = { terminalTtlMs: ttl };
  if (snapshots !== undefined) {
    const s = checkSection("snapshots", snapshots, ["keepLatest"]);
    const k = s.keepLatest;
    if (typeof k !== "number" || !Number.isInteger(k) || k < 1) {
      reject(
        `snapshots.keepLatest must be an integer >= 1 (the latest snapshot is never pruned: a compacted execution's checkpoint IS its state); got ${String(k)}`
      );
    }
    out.snapshots = { keepLatest: k };
  }
  if (content !== undefined) {
    const c = checkSection("content", content, ["unpinnedAfterMs"]);
    const u = c.unpinnedAfterMs;
    if (typeof u !== "number" || !Number.isInteger(u) || u <= 0) {
      reject(
        `content.unpinnedAfterMs must be a finite integer > 0 (milliseconds); got ${String(u)}`
      );
    }
    if (u < ttl) {
      reject(
        `content.unpinnedAfterMs (${u}) must be >= terminalTtlMs (${ttl}): the advisory consistency rule (ADR 0145 D2) - a reclaimable-telemetry ref should outlive the logs that cite it`
      );
    }
    out.content = { unpinnedAfterMs: u };
  }
  return out;
}

/**
 * Validate a retention policy. Throws {@link RetentionPolicyError}. Every pass that RECEIVES a
 * policy calls this, so a plain object literal cannot bypass the rules. This is an assertion
 * only: it does not return the value it checked - use {@link retentionPolicy} for that.
 */
export function assertRetentionPolicy(p: unknown): asserts p is RetentionPolicy {
  snapshotPolicy(p);
}

/**
 * Snapshot, validate and deeply freeze a retention policy. Returns a new object built from the
 * validated snapshot (each input field is read once); the input is not mutated.
 */
export function retentionPolicy(spec: RetentionPolicy): Readonly<RetentionPolicy> {
  const snap = snapshotPolicy(spec);
  return Object.freeze({
    terminalTtlMs: snap.terminalTtlMs,
    ...(snap.snapshots !== undefined && { snapshots: Object.freeze(snap.snapshots) }),
    ...(snap.content !== undefined && { content: Object.freeze(snap.content) }),
  });
}
