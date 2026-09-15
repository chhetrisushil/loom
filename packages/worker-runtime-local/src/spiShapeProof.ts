import type {
  ExecutionAuthorizerLike,
  ResumeAuthenticatorLike,
  TimerDispatcherLike,
} from "@loom/conformance";
import type {
  ExecutionAuthorizer,
  ResumeAuthenticator,
  TimerDispatcher,
} from "@loom/workflow-runtime";

// ── Compile-time proof: the conformance kits still describe the real SPIs ────
//
// `@loom/conformance` declares `ExecutionAuthorizerLike` / `TimerDispatcherLike`
// structurally, because importing the real interfaces there would close a cycle
// (workflow-runtime dev-depends on plugin-sqlite, which depends on conformance).
//
// Structural duplication drifts unless something fails when it does. This package is the
// only one that depends on BOTH, so the proof lives here: if either SPI gains a method or
// changes a signature, these assignments stop compiling and the build fails — rather than
// the kit quietly certifying a contract loom no longer has.
//
// Type-only: nothing is emitted, and no runtime dependency is created.

/** A real authorizer must satisfy the kit's expectation of one. */
export type ExecutionAuthorizerStillMatches = ExecutionAuthorizer extends ExecutionAuthorizerLike
  ? true
  : never;

/** ...and vice versa, so the kit cannot quietly expect LESS than the SPI requires. */
export type KitExpectsTheRealAuthorizer = ExecutionAuthorizerLike extends ExecutionAuthorizer
  ? true
  : never;

export type TimerDispatcherStillMatches = TimerDispatcher extends TimerDispatcherLike
  ? true
  : never;

export type KitExpectsTheRealDispatcher = TimerDispatcherLike extends TimerDispatcher
  ? true
  : never;

// `never` fails assignment, so drift in either direction is a build error here.
const _authorizerProof: [ExecutionAuthorizerStillMatches, KitExpectsTheRealAuthorizer] = [
  true,
  true,
];
const _dispatcherProof: [TimerDispatcherStillMatches, KitExpectsTheRealDispatcher] = [true, true];

/**
 * The third pair, and the one that justifies the whole file: this kit's first draft declared
 * the verdict as `{ ok: boolean }`. The real `ResumeVerdict` is a three-way union whose third
 * status (`not-applicable`) means "not mine to judge" — so the draft would have shipped a kit
 * certifying a contract loom does not have, and a plugin author would have written to it.
 */
export type ResumeAuthenticatorStillMatches = ResumeAuthenticator extends ResumeAuthenticatorLike
  ? true
  : never;
export type KitExpectsTheRealAuthenticator = ResumeAuthenticatorLike extends ResumeAuthenticator
  ? true
  : never;
const _authenticatorProof: [ResumeAuthenticatorStillMatches, KitExpectsTheRealAuthenticator] = [
  true,
  true,
];
void _authenticatorProof;
void _authorizerProof;
void _dispatcherProof;
