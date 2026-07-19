/**
 * Structural input + report types for pre-flight runtime verification.
 *
 * `@loom/verify` is deliberately dependency-free: it operates on a `VerifyInput`
 * that is a *structural projection* of a resolved Loom config (flows, grants,
 * dispatcher targets, metered dimensions, schema versions). A thin adapter maps
 * a real `defineConfig(...)` + compiler manifest onto this shape, so the engine
 * stays pure and testable and does not couple to evolving config types.
 */

/** Finding severity. Only `error` makes a report `!ok`. */
export type Severity = "error" | "warn" | "info";

/** Wiring mode. `off` is the default and is byte-identical to not wiring verify (G2). */
export type VerifyMode = "off" | "warn" | "error";

/** The pre-flight rules. Each is independent and read-only. */
export type RuleName =
  | "determinism"
  | "replay-safety"
  | "suspension-safety"
  | "capability-compat"
  | "placement-compat"
  | "resource-compat";

export interface Finding {
  readonly rule: RuleName;
  readonly severity: Severity;
  readonly message: string;
  /** Where the finding applies — usually a flow id, or `flowId:stepId`/`flowId:toolId`. */
  readonly location?: string;
}

export interface VerificationReport {
  /** True iff there are no `error`-severity findings. */
  readonly ok: boolean;
  readonly findings: readonly Finding[];
  readonly checked: readonly RuleName[];
}

/** A call the compiler flagged as non-deterministic (e.g. `Date.now`, `Math.random`, bare `fetch`). */
export interface NonDeterministicCall {
  readonly callee: string;
  /** True if the call is inside a `ctx.decide`/`ctx.execute` boundary (so its result is logged). */
  readonly insideDecide: boolean;
  readonly location?: string;
}

/**
 * A `ctx.run`/`ctx.execute` inside a loop whose step id cannot vary per iteration
 * (ADR 0061 — the step-identity rule). Flagged by the compiler's
 * `analyzeLoopIdentity`; frames are keyed by id, so a reused id is served
 * iteration 0's memoized output — silent replay corruption.
 */
export interface LoopIdentityCall {
  readonly callee: string;
  readonly loopKind: string;
  readonly reason: string;
  readonly location?: string;
}

export interface SuspendPoint {
  readonly id?: string;
  readonly correlationKey?: string;
  /** A timed suspend (`sleep`/`sleepUntil`/`suspend({ timeout })`). */
  readonly timed?: boolean;
  /** Whether a durable `wakeAt` is recorded (required for a timed suspend to fire across a restart, T1). */
  readonly wakeAt?: boolean;
}

export interface EffectRef {
  readonly toolId: string;
  /** The capability this effect requires (matched against the GrantTable, K2). */
  readonly capability: string;
  /** Optional effect kind (step/llm/tool/…) used for placement compatibility. */
  readonly kind?: string;
}

export interface BudgetSpec {
  readonly dimensions: readonly string[];
  readonly ceilings?: Readonly<Record<string, number>>;
}

export interface FlowSpec {
  readonly id: string;
  /** K11 content hash; absent means the flow cannot be pinned to a code version. */
  readonly flowHash?: string;
  readonly nonDeterministicCalls?: readonly NonDeterministicCall[];
  /** ADR 0061 loop-identity findings (absent ⇒ no findings; G2). */
  readonly loopIdentityCalls?: readonly LoopIdentityCall[];
  readonly suspends?: readonly SuspendPoint[];
  readonly effects?: readonly EffectRef[];
  /** `ExecutionPolicy.computeTarget`, if the flow pins a placement lane. */
  readonly computeTarget?: string;
  readonly budget?: BudgetSpec;
  /** Whether the flow uses approval/resume (needs a `ResumeAuthenticator`, K12). */
  readonly usesApproval?: boolean;
}

export interface GrantSpec {
  /** principal → granted capabilities, or `"*"` for all (mirrors K2 `GrantTable`). */
  readonly grants: Readonly<Record<string, readonly string[] | "*">>;
  /** Maps a flow id to its principal; defaults to the flow id (the `GrantTable` default). */
  readonly principalOf?: (flowId: string) => string;
}

export interface PlacementSpec {
  readonly targets: readonly string[];
  /** Optional: target → supported effect kinds. */
  readonly supportedKinds?: Readonly<Record<string, readonly string[]>>;
}

export interface VerifyInput {
  readonly flows: readonly FlowSpec[];
  /** K2 grants. Absent means no `GrantTable` is wired — capability-compat is skipped (G2). */
  readonly grants?: GrantSpec;
  /** Registered `PlacementDispatcher` targets. Absent means default local placement. */
  readonly placement?: PlacementSpec;
  /** Dimensions the wired `meteringMiddleware` covers (e.g. `["tokens","costUsd","ms"]`). */
  readonly meteredDimensions?: readonly string[];
  readonly resumeAuthenticatorWired?: boolean;
  /** The app's `EVENT_SCHEMA_VERSION` (K5). */
  readonly eventSchemaVersion?: string;
  /** The schema version of a prior log this app may resume, if known. */
  readonly resumeLogSchemaVersion?: string;
}

export interface VerifyOptions {
  /** Subset of rules to run; defaults to all in canonical order. */
  readonly rules?: readonly RuleName[];
}
