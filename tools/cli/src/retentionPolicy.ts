import {
  type RetentionPolicy,
  RetentionPolicyError,
  assertRetentionPolicy,
} from "@loom/workflow-runtime";
import { UsageError } from "./args";
import { loadModuleExports } from "./stores";

// ADR 0145 - `--policy <module>`: the app's own retention policy VALUE, imported by path.
// The module exports it as the named export `retention` or as its default export. Whatever it
// exports is validated again here (`assertRetentionPolicy`), so a plain object literal that
// never went through `retentionPolicy()` cannot bypass the rules.

/** A broken policy is a refusal (exit 2), not a runtime failure: the operator fixes the module or the flag. */
function validate(value: unknown): asserts value is RetentionPolicy {
  try {
    assertRetentionPolicy(value);
  } catch (err) {
    if (err instanceof RetentionPolicyError) throw new UsageError(err.message);
    throw err;
  }
}

/** Load and validate the policy exported by `modulePath` (`retention`, else `default`). */
export async function loadRetentionPolicy(modulePath: string): Promise<RetentionPolicy> {
  const mod = await loadModuleExports(modulePath);
  // A CJS-compiled default export can arrive as { default: { default: value } } - unwrap one level.
  const candidate = mod.retention ?? mod.default;
  const value =
    candidate !== undefined &&
    typeof candidate === "object" &&
    candidate !== null &&
    "retention" in candidate &&
    !("terminalTtlMs" in candidate)
      ? (candidate as { retention: unknown }).retention
      : candidate;
  if (value === undefined) {
    throw new UsageError(
      `--policy ${modulePath}: the module exports no retention policy - export it as \`export const retention = retentionPolicy({ terminalTtlMs: ... })\` (or as the default export)`
    );
  }
  validate(value);
  return value;
}

/**
 * Apply an explicit CLI override on top of a loaded policy and re-validate the result, so
 * `--ttl` can never produce a combination the rules forbid (e.g. a log TTL longer than the
 * content TTL). Returns a fresh object.
 */
export function overridePolicy(
  policy: RetentionPolicy,
  override: { terminalTtlMs?: number; unpinnedAfterMs?: number }
): RetentionPolicy {
  const next: RetentionPolicy = {
    ...policy,
    ...(override.terminalTtlMs !== undefined && { terminalTtlMs: override.terminalTtlMs }),
    ...(override.unpinnedAfterMs !== undefined && {
      content: { unpinnedAfterMs: override.unpinnedAfterMs },
    }),
  };
  validate(next);
  return next;
}
