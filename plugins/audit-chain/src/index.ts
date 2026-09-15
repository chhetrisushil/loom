// @loom/plugin-audit-chain — tamper-evident, hash-chained EventStore wrapper.
//
// Each event carries H(prevHash ‖ canonical(event)) in its metadata (plus an optional
// signature), so any edit/insert/reorder/drop in the durable log is detectable
// out-of-band via `verifyChain`. Sign with an HMAC secret for tamper-evidence, or with an
// Ed25519 key (#382) for third-party VERIFIABILITY — where the auditor who can check the
// log is no longer someone who could also have written it. The chain lives entirely in metadata, which the fold
// ignores — replay is byte-identical whether or not chaining is wired (G1/G2).

export { ed25519Signer, ed25519Verifier, type KeyLike } from "./ed25519";
export {
  type ChainMetadata,
  type ChainSigner,
  type ChainVerifier,
  type ChainVerification,
  type HashChainOptions,
  type HashChainedEventStore,
  hashChainedEventStore,
  canonicalize,
} from "./hashChain";
