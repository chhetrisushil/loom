import type { MintRequest } from "./broker";

/** A grant template: a `MintRequest` with the task identity left for the caller (ADR 0150 D9). */
export type GrantTemplate = Pick<MintRequest, "effects" | "leases"> &
  Partial<Omit<MintRequest, "effects" | "leases">>;

/**
 * ADR 0150 D9 (S-R5): a grant TEMPLATE from a flow's reach. Structural only: `reach` is the tool ids
 * (from `reachOf` in `@loomwork/app`); the result is their sorted, de-duplicated set as `effects`. It
 * is the UPPER BOUND for a mint, not a proposal to grant it all. It sets no `leases` (a ceiling is a
 * product decision) and no `reads` (the reach is of effects; resource scopes are the operator's), so a
 * broker that mints it unchanged leases nothing. `extra` adds the fields the caller owns (`ttlMs`,
 * `reads`, `sandbox`, `leases`, ...) and cannot replace `effects`.
 */
export function deriveGrant(
  reach: Iterable<string>,
  extra: Partial<Omit<MintRequest, "effects">> = {}
): GrantTemplate {
  return { ...extra, leases: extra.leases ?? {}, effects: [...new Set(reach)].sort() };
}
