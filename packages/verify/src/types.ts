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
  | "resource-compat"
  | "classification-reachability"
  | "effect-class";

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
  /** EF — the effect's declared class, from the app's `effectClasses` ordering. */
  readonly effectClass?: string;
}

/**
 * An effect a flow reaches through `scope.invokeTransient(…)` inside a `ctx.decide`
 * decider (L31). Carried separately from `effects` (which these are also merged into, so
 * capability-compat / effect-class see them) because the decider seam adds a constraint
 * `ctx.run` does not: a `journaled` effect is refused on a transient call.
 */
export interface DeciderEffectRef {
  readonly toolId: string;
  /** The effect's declared determinism-boundary mode, read from the real registry. */
  readonly mode?: "journaled" | "ambient";
}

export interface BudgetSpec {
  readonly dimensions: readonly string[];
  readonly ceilings?: Readonly<Record<string, number>>;
}

/**
 * A `secret()`/`sensitive()`/`internal()` mark the dot-path sinks cannot address (K10-R1).
 * Produced by `collectUnreachableMarks` in `@loom/classify`; the mark is silently inert —
 * masking, field encryption and externalization all address scalar dot-paths, and none of
 * them descend into array elements.
 */
export interface UnreachableMarkRef {
  /** Where the mark sits, e.g. `byId.<record>.ssn` — a location, not an addressable path. */
  readonly path: string;
  readonly dataClass: string;
  /** The container that strands it: `record`, `union`, `tuple`, `intersection`, … */
  readonly container: string;
  /** Which schema it was declared on. */
  readonly stepId: string;
  readonly channel: "input" | "output";
}

/**
 * A `ctx.run`/`ctx.suspend` target in the runner body that static analysis could
 * not resolve — an imported binding, a minted step (`mcpInvoke$("…")`), an
 * element access. Produced by `@loom/compiler`'s `analyzeRunnerReach`.
 *
 * It exists so the reach-bounded rules can say "partially verified" instead of
 * reporting clean. Reachability is what `capability-compat`, `effect-class` and
 * `suspension-safety` are all bounded by, and silence about the bound is what
 * makes a green report overclaim.
 */
export interface UnresolvedReachRef {
  readonly expr: string;
  readonly kind: "step" | "suspend";
  readonly location?: string;
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
  /** L31 — effects reached via a `ctx.decide` scope (a subset of `effects`, with their mode). */
  readonly deciderEffects?: readonly DeciderEffectRef[];
  /**
   * EF-1 — the flow's declared effect-class CEILING. A value from the app's
   * `effectClasses` ordering; absent ⇒ the effect-class rule skips this flow (G2).
   */
  readonly effectClass?: string;
  /** `ExecutionPolicy.computeTarget`, if the flow pins a placement lane. */
  readonly computeTarget?: string;
  readonly budget?: BudgetSpec;
  /** Whether the flow uses approval/resume (needs a `ResumeAuthenticator`, K12). */
  readonly usesApproval?: boolean;
  /** K10-R1 marks that no egress sink can reach (absent ⇒ none; G2). */
  readonly unreachableMarks?: readonly UnreachableMarkRef[];
  /**
   * Runner-body `ctx.run`/`ctx.suspend` targets that could not be resolved.
   * Absent or empty ⇒ reach analysis was complete for this flow (or was never
   * run, which is the same thing from the rules' point of view: no claim either
   * way — see `reachAnalyzed`).
   */
  readonly unresolvedReach?: readonly UnresolvedReachRef[];
  /**
   * Whether runner-body reach analysis ran for this flow at all. Distinguishes
   * "analyzed, everything resolved" from "never analyzed", which
   * `unresolvedReach: []` alone cannot. Without it, an app that never wired the
   * compiler would look maximally verified.
   */
  readonly reachAnalyzed?: boolean;
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
  /**
   * EF — the app's effect-class vocabulary, **ascending severity** (e.g.
   * `["read-only","local-write","external-write","irreversible"]`).
   *
   * Loom owns the mechanism, never the taxonomy: what the classes ARE is a
   * product decision, so the list is supplied by the app (ADR 0083). Absent ⇒
   * the effect-class rule is a no-op.
   */
  readonly effectClasses?: readonly string[];
  /** K2 grants. Absent means no `GrantTable` is wired — capability-compat is skipped (G2). */
  readonly grants?: GrantSpec;
  /** Registered `PlacementDispatcher` targets. Absent means default local placement. */
  readonly placement?: PlacementSpec;
  /** Dimensions the wired `meteringMiddleware` covers (e.g. `["tokens","costUsd","ms"]`). */
  readonly meteredDimensions?: readonly string[];
  readonly resumeAuthenticatorWired?: boolean;
  /**
   * Whether a `TimerStore` is wired. When it is, `WorkflowRuntime` derives
   * `wakeAt` from a suspend's `timeout`, so a timeout without an explicit wakeAt
   * is correct rather than a defect.
   */
  readonly timerStoreWired?: boolean;
  /** The app's `EVENT_SCHEMA_VERSION` (K5). */
  readonly eventSchemaVersion?: string;
  /** The schema version of a prior log this app may resume, if known. */
  readonly resumeLogSchemaVersion?: string;
}

export interface VerifyOptions {
  /** Subset of rules to run; defaults to all in canonical order. */
  readonly rules?: readonly RuleName[];
}
