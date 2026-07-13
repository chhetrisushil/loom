// ── ADR 0046 — loud on absence (the generalized PAYLOAD_SHREDDED contract) ─────
//
// A fold that needs an externalized value whose bytes were erased (or never stored) must fail
// LOUDLY — never silently substitute a default and diverge (G1). This mirrors the crypto
// plugin's `PayloadShreddedError`: the value is gone, so replay of it cannot proceed.

export class ContentMissingError extends Error {
  constructor(
    readonly contentAddress: string,
    readonly executionId?: string
  ) {
    super(
      `externalized content "${contentAddress}"${
        executionId ? ` (execution "${executionId}")` : ""
      } is missing: the bytes were erased or never stored, so replay cannot restore this value`
    );
    this.name = "ContentMissingError";
  }
}
