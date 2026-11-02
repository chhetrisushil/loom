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
   * Content GC: reclaim a claim-check ref only once its latest citation is this old. Must be
   * `>= terminalTtlMs`, so a kept log never names bytes that are gone.
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
 * Validate a retention policy. Throws {@link RetentionPolicyError}. Every pass that RECEIVES a
 * policy calls this, so a plain object literal cannot bypass the rules.
 */
export function assertRetentionPolicy(p: unknown): asserts p is RetentionPolicy {
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
  if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 0) {
    reject(`terminalTtlMs must be a finite integer >= 0 (milliseconds); got ${String(ttl)}`);
  }
  if (o.snapshots !== undefined) {
    const s = checkSection("snapshots", o.snapshots, ["keepLatest"]);
    const k = s.keepLatest;
    if (typeof k !== "number" || !Number.isInteger(k) || k < 1) {
      reject(
        `snapshots.keepLatest must be an integer >= 1 (the latest snapshot is never pruned: a compacted execution's checkpoint IS its state); got ${String(k)}`
      );
    }
  }
  if (o.content !== undefined) {
    const c = checkSection("content", o.content, ["unpinnedAfterMs"]);
    const u = c.unpinnedAfterMs;
    if (typeof u !== "number" || !Number.isInteger(u) || u <= 0) {
      reject(
        `content.unpinnedAfterMs must be a finite integer > 0 (milliseconds); got ${String(u)}`
      );
    }
    if (u < ttl) {
      reject(
        `content.unpinnedAfterMs (${u}) must be >= terminalTtlMs (${ttl}): content must outlive the logs that cite it, or a kept log names bytes that are gone`
      );
    }
  }
}

/** Validate and freeze a retention policy (deeply). Returns a new object; the input is not mutated. */
export function retentionPolicy(spec: RetentionPolicy): Readonly<RetentionPolicy> {
  assertRetentionPolicy(spec);
  return Object.freeze({
    terminalTtlMs: spec.terminalTtlMs,
    ...(spec.snapshots !== undefined && { snapshots: Object.freeze({ ...spec.snapshots }) }),
    ...(spec.content !== undefined && { content: Object.freeze({ ...spec.content }) }),
  });
}
