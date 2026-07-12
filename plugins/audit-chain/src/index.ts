// @loom/plugin-audit-chain — tamper-evident, hash-chained EventStore wrapper.
//
// Each event carries H(prevHash ‖ canonical(event)) in its metadata (plus an optional
// HMAC signature), so any edit/insert/reorder/drop in the durable log is detectable
// out-of-band via `verifyChain`. The chain lives entirely in metadata, which the fold
// ignores — replay is byte-identical whether or not chaining is wired (G1/G2).

export {
  type ChainMetadata,
  type ChainVerification,
  type HashChainOptions,
  type HashChainedEventStore,
  hashChainedEventStore,
  canonicalize,
} from "./hashChain";
