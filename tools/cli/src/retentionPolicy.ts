import {
  type RetentionPolicy,
  RetentionPolicyError,
  retentionPolicy,
} from "@loom/workflow-runtime";
import { UsageError } from "./args";
import { parseDuration } from "./duration";
import { loadModuleExports } from "./stores";

// ADR 0145 - `--policy <module>`: the app's own retention policy VALUE, imported by path.
// The module exports it as the named export `retention` or as its default export. Whatever it
// exports is validated again here (`assertRetentionPolicy`), so a plain object literal that
// never went through `retentionPolicy()` cannot bypass the rules.

const POLICY_KEYS = new Set(["terminalTtlMs", "snapshots", "content"]);

/**
 * Snapshot, validate and freeze through `retentionPolicy()`. A broken policy is a refusal (exit 2),
 * not a runtime failure: the operator fixes the module or the flag. The caller gets the frozen
 * validated snapshot, never the module's own object (a getter could answer differently later).
 */
function freeze(value: unknown): RetentionPolicy {
  try {
    return retentionPolicy(value as RetentionPolicy);
  } catch (err) {
    if (err instanceof RetentionPolicyError) throw new UsageError(err.message);
    throw err;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Load and validate the policy exported by `modulePath`: the named export `retention` if the
 * module HAS one (even `null`: an explicit empty export is refused, not skipped), else its default
 * export (ES `export default`, TS `exports.default`, or CommonJS `module.exports = { terminalTtlMs }`).
 */
export async function loadRetentionPolicy(modulePath: string): Promise<RetentionPolicy> {
  const mod = await loadModuleExports(modulePath);
  let value: unknown;
  if ("retention" in mod) {
    value = mod.retention;
  } else if ("default" in mod) {
    value = mod.default;
    // A default export that is an object carrying `retention` (and is not itself a policy):
    // e.g. CJS `module.exports = { retention }` seen through an ES default.
    if (isPlainObject(value) && "retention" in value && !("terminalTtlMs" in value)) {
      value = value.retention;
    } else if (
      isPlainObject(value) &&
      !("terminalTtlMs" in value) &&
      Object.keys(value).some((k) => !POLICY_KEYS.has(k))
    ) {
      throw new UsageError(
        `--policy ${modulePath}: the module's default export is not a retention policy (it looks like an app/config); export \`retention\`, e.g. \`export const retention = retentionPolicy({ terminalTtlMs: ... })\``
      );
    }
  } else if ("terminalTtlMs" in mod) {
    // CommonJS `module.exports = { terminalTtlMs: ... }`: the exports object IS the policy.
    value = mod;
  } else {
    throw new UsageError(
      `--policy ${modulePath}: the module exports no retention policy - export it as \`export const retention = retentionPolicy({ terminalTtlMs: ... })\` (or as the default export)`
    );
  }
  if (value === undefined) {
    throw new UsageError(
      `--policy ${modulePath}: the module's retention export is undefined - export \`retention = retentionPolicy({ terminalTtlMs: ... })\``
    );
  }
  return freeze(value);
}

/**
 * Parse a `--ttl` flag to milliseconds, refusing (exit 2) a value that is not a safe finite
 * integer: a 400-digit number parses to `Infinity`, which on main silently kept everything. The
 * `--policy` path refuses the same value; this makes the two consistent (ADR 0145 D6).
 */
export function parseTtlFlag(raw: string, flag = "--ttl"): number {
  const ms = parseDuration(raw);
  if (!Number.isSafeInteger(ms)) {
    throw new UsageError(
      `${flag} "${raw.length > 40 ? `${raw.slice(0, 20)}...` : raw}" is too large: it must be a finite number of milliseconds (<= ${Number.MAX_SAFE_INTEGER})`
    );
  }
  return ms;
}

/**
 * Apply an explicit CLI override on top of a loaded policy and re-validate the result, so
 * `--ttl` can never produce a combination the rules forbid (e.g. a log TTL longer than the
 * content TTL). Returns a fresh frozen object.
 */
export function overridePolicy(
  policy: RetentionPolicy,
  override: { terminalTtlMs?: number; unpinnedAfterMs?: number }
): RetentionPolicy {
  return freeze({
    ...policy,
    ...(override.terminalTtlMs !== undefined && { terminalTtlMs: override.terminalTtlMs }),
    ...(override.unpinnedAfterMs !== undefined && {
      content: { unpinnedAfterMs: override.unpinnedAfterMs },
    }),
  });
}
