import type { TaintedValue } from "@loomwork/classify";
import { type GrantKeys, type TaskGrant, sealKeys, verifyTaskGrant } from "./grant";

/** ADR 0150 D7: the taint origin of content a grant-holder wrote is `lineage:<rootId>`. */
export const LINEAGE_ORIGIN_PREFIX = "lineage:";
/** The kernel truncates an origin label past 256 chars (`unknown:truncated:...`): a longer lineage origin cannot be compared. */
export const LINEAGE_ORIGIN_MAX = 256;
/**
 * What `lineageOrigin` returns for a verified grant whose `lineage:<rootId>` would exceed {@link LINEAGE_ORIGIN_MAX}: an
 * `unknown:` label, which `directedBy` treats as FOREIGN, so the content is still marked (fail closed) rather than untagged.
 */
export const LINEAGE_TOO_LONG = "unknown:lineage-too-long";

/** The slice of a principal a writer's lineage is read from (structural: no kernel dependency). */
export interface LineagePrincipal {
  actor?: string;
  tenant?: string;
  taskGrant?: unknown;
}

/**
 * ADR 0150 D7 / S-R1. Returns `principal => "lineage:<rootId>" | undefined`. The rootId comes ONLY from a grant
 * whose signature verifies under `secret` and whose `issuedTo` is the presenting actor: never from a value the
 * caller supplied. No verified grant => `undefined` (the writer is simply not tagged; a tag is never invented).
 * The grant's tenant must equal the principal's (absent = absent), as the authorizer requires. A rootId whose origin would
 * exceed {@link LINEAGE_ORIGIN_MAX} yields {@link LINEAGE_TOO_LONG} (foreign), never a label the kernel would truncate.
 * Pass the AUTHENTICATED principal only (the one the transport or effect context resolved), never one the caller built.
 * Expiry is not checked: provenance of what was written stays true after the grant lapses.
 */
export function lineageOrigin(
  secret: GrantKeys
): (principal: LineagePrincipal | undefined) => string | undefined {
  const sealed = sealKeys(secret);
  return (principal) => {
    try {
      const claimed = principal?.taskGrant as TaskGrant | undefined;
      if (claimed === undefined) return undefined;
      const g = verifyTaskGrant(sealed, claimed);
      if (g === undefined || g.issuedTo !== principal?.actor) return undefined;
      if (g.tenant !== principal?.tenant) return undefined;
      const origin = `${LINEAGE_ORIGIN_PREFIX}${g.rootId}`;
      return origin.length > LINEAGE_ORIGIN_MAX ? LINEAGE_TOO_LONG : origin;
    } catch {
      return undefined;
    }
  };
}

/**
 * Wrap `value` as written by `origin`. UNLIKE `tainted()`, an already-tainted value is NOT returned as is: the
 * lineage wrapper goes on the OUTSIDE and the inner wrapper (say `mcp:x`) is kept, so neither origin is lost
 * (`tainted()` would keep only the original, dropping the lineage a reader needs). Idempotent per origin.
 */
export function wrapLineage<T>(value: T, origin: string): TaintedValue<T> {
  const mark = (value as { __loomTainted?: { origin?: unknown } } | null)?.__loomTainted;
  if (typeof mark === "object" && mark !== null && mark.origin === origin)
    return value as TaintedValue<T>;
  return { __loomTainted: { origin }, value };
}

/** `(principal, value) => value` tagged with the writer's verified lineage, or `value` untouched without one. */
export function lineageTainter(
  secret: GrantKeys
): <T>(principal: LineagePrincipal | undefined, value: T) => T | TaintedValue<T> {
  const originOf = lineageOrigin(secret);
  return (principal, value) => {
    const o = originOf(principal);
    return o === undefined ? value : wrapLineage(value, o);
  };
}

/**
 * Inbox-send helper: `runtime.send` with the payload wrapped as the SENDER's lineage (the sender being the
 * principal that authenticated the call). The reader gets `lineage:<rootId>` plus the kernel's own `inbox:<topic>`.
 */
export function lineageSend<R extends { send: (...a: never[]) => Promise<unknown> }>(
  runtime: R,
  secret: GrantKeys
): (
  executionId: string,
  message: { topic: string; payload: unknown; messageId?: string },
  options: { principal: LineagePrincipal } & Record<string, unknown>
) => Promise<unknown> {
  const tag = lineageTainter(secret);
  return (executionId, message, options) =>
    (runtime.send as unknown as (...a: unknown[]) => Promise<unknown>)(
      executionId,
      { ...message, payload: tag(options.principal, message.payload) },
      options
    );
}
