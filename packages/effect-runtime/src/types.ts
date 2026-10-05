import type { EffectKind, EffectMode } from "@loom/core";
import type { PrincipalChain } from "./authz";

export type { EffectKind, EffectMode };

/**
 * A tool was invoked from the wrong side of the determinism boundary — an
 * `ambient` effect inside an execution, or a `journaled` effect transiently.
 *
 * This is a contract violation, not an authorization denial: it is thrown
 * plainly rather than recorded as an EFFECT_DENIED fact, because the caller used
 * the wrong entry point (a programming error) rather than lacking authority.
 */
export class EffectModeViolationError extends Error {
  readonly toolId: string;
  readonly declared: EffectMode;
  /** The seam the call actually came through. */
  readonly attempted: "journaled" | "ambient";
  constructor(toolId: string, declared: EffectMode, attempted: "journaled" | "ambient") {
    super(
      declared === "ambient"
        ? `Effect "${toolId}" is declared ambient and must not be invoked inside an execution — its result would be journaled, and a call whose count/order is user-driven poisons replay. Use EffectRuntime.invokeTransient (ADR 0066).`
        : `Effect "${toolId}" is declared journaled and must not be invoked transiently — a transient call has zero durable footprint, so the durable fact the caller expected would silently not exist. Use ctx.execute inside an execution.`
    );
    this.name = "EffectModeViolationError";
    this.toolId = toolId;
    this.declared = declared;
    this.attempted = attempted;
  }
}

/**
 * Running resource totals for the owning execution (Loom 2.0 K3). Threaded into
 * each effect's context so accounting/quota middleware can meter usage and enforce
 * budgets. Accumulated durably in `variables._resources` via RESOURCE_METERED, so
 * the snapshot is deterministic on replay.
 */
export interface ResourceSnapshot {
  tokens: number;
  costUsd: number;
  ms: number;
  count: number;
  // ADR 0032 (R1) — additional dimensions; present only once something meters them.
  memBytes?: number;
  wallMs?: number;
  netBytes?: number;
  /** Set once a quota has been exceeded. */
  exceeded?: boolean;
}

export interface EffectContext {
  executionId: string;
  stepId: string;
  workflowId: string;
  attempt: number;
  /**
   * The resolved effect id for this invocation. The runtime sets it on the view
   * of the context the MIDDLEWARE chain receives (additive — hand-built contexts
   * simply leave it unset, and the effect itself still receives the caller's
   * context unchanged). Lets cross-cutting middleware key per-tool configuration
   * — e.g. claim-check digest declarations — without a lookup side channel.
   */
  readonly toolId?: string;
  /**
   * L30 — set only on a transient call stamped as an execution (`ctx.decide`'s
   * scope). Several such calls share `(executionId, stepId = toolId)`, so a site
   * that mints an id from those two (A2A task id, redaction secret-ref id) MUST
   * append this when present, or two calls collide. Undefined on durable steps
   * (their stepId is unique) and on bare transient calls.
   */
  readonly callKey?: string;
  emit(eventType: string, payload: unknown): void;
  /**
   * Cooperative cancellation for this effect. Aborts when the owning execution is
   * cancelled. Long-running/I/O effects (LLM, tool, A2A) should forward it to
   * `fetch`/providers and check it at await points. Optional and undefined by
   * default, so non-cancellable effects pay nothing.
   */
  readonly signal?: AbortSignal;
  /**
   * Running resource totals for this execution BEFORE this effect (K3). Undefined
   * when accounting is not wired, so effects/middleware that don't meter pay nothing.
   */
  readonly resources?: ResourceSnapshot;
  /**
   * K9.2 — deterministic idempotency key for this effect invocation:
   * `executionId:stepId` (no attempt component — the folded attempt counter
   * advances on crash-recovery re-execution, which is exactly when the key must
   * stay stable). Recovery re-runs of the same logical attempt therefore carry
   * the SAME key, so tool authors can deduplicate at the provider. A fresh key
   * (`executionId:stepId:rN`) is minted only by a durable new-logical-attempt
   * fact — an EFFECT_INDOUBT "retry-fresh" verdict.
   */
  readonly idempotencyKey?: string;
  /**
   * Scheduling priority for this effect (M6), used when the EffectRuntime routes
   * effects through a Scheduler with a finite concurrency cap. A `@loom/scheduler`
   * Priority value (0 = Immediate … 3 = Idle). Undefined ⇒ Normal.
   */
  readonly priority?: number;
  /**
   * K12.1 — the authenticated principal chain for the owning execution, carried
   * opaquely and handed to the K2 authorizer. Set at the trust boundary
   * (start/resume). Undefined ⇒ no principal (today's behavior).
   */
  readonly principal?: PrincipalChain;
}

/**
 * Options for a transient (non-durable) effect invocation — {@link
 * EffectRuntime.invokeTransient}. Every field is optional; the empty case is a
 * bare one-shot call with no cancellation and no principal.
 *
 * There is deliberately no `executionId`/`stepId`/`attempt`/`emit` here: those
 * are the internal {@link EffectContext} shape the façade OWNS and synthesizes,
 * so a caller never couples to it (R2). None of these fields is ever persisted —
 * a transient invocation writes nothing (R1).
 */
export interface TransientInvokeOptions {
  /**
   * Optional cooperative cancellation (R5). Forwarded verbatim as
   * `EffectContext.signal`, so it propagates to the effect's `fetch`/sandbox/
   * provider and aborts the in-flight call. Lets a caller bound a transient
   * invocation with a deadline.
   */
  readonly signal?: AbortSignal;
  /**
   * Optional authenticated principal chain. If an authorizer is wired on the
   * runtime (K2 protection ring), it is still enforced transiently — an
   * unauthorized effect never runs. Undefined ⇒ no principal (today's behavior).
   */
  readonly principal?: PrincipalChain;
  /**
   * A trace/metric tag, never persisted (there is nothing to persist to).
   * Defaults to the `toolId`. Without `as` it is NOT only a tag: it becomes the
   * synthetic context's `executionId` (`transient:<label>`), which the authorizer
   * and middleware see — a `GrantTable`/`PolicyAuthorizer` configured to grant
   * per execution decides on it. Wrappers that memoise must key on it.
   */
  readonly label?: string;
  /**
   * L30 — run AS an existing execution instead of the throwaway `transient`
   * identity: the synthesized {@link EffectContext} carries this `workflowId`/
   * `executionId`, so the K2 authorizer's flow-scoped grants, delegation checks and
   * trace/middleware correlation see the deciding execution. It changes only WHAT
   * IS CLAIMED, never what is written: the call is still transient (R1-R5
   * unchanged — no journal, no-op `emit`, same middleware chain, `ambient`
   * effect-mode check). `stepId` defaults to the toolId, exactly as a bare call, so
   * stepId-keyed per-tool configuration (redaction, pricing, retry) matches.
   *
   * Trust model: this is the transient analogue of the EffectContext a holder of
   * the runtime can already hand-build via `execute`; it is NOT a capability check.
   * `ctx.decide`'s scope is the only thing flow code is handed, and it pre-stamps
   * the identity, so flow code cannot choose one. Do not forward untrusted input
   * into `as`.
   *
   * Because the identity is an AUTHORIZATION INPUT (`GrantTable` keys on
   * `workflowId`), any wrapper that memoises, dedupes or caches transient calls
   * MUST key on the identity (`as`) as well as `[principal, input]` — and on
   * `label` too, which names the transient execution when `as` is absent (the
   * simplest safe key is every option except `signal`) — otherwise a result
   * produced under one execution's grants can be served to another's.
   */
  readonly as?: TransientIdentity;
  /**
   * Running resource totals of the execution the call is stamped as, so metering /
   * `nestedBudget` ADMISSION control can refuse an over-budget execution. The
   * CHARGE is not recorded: `emit` is the no-op sink, so a transient call's spend
   * never reaches the fold (a decider's LLM spend is invisible to the budget).
   */
  readonly resources?: ResourceSnapshot;
}

/** The execution identity a transient invocation is stamped with (L30). */
export interface TransientIdentity {
  readonly workflowId: string;
  readonly executionId: string;
  /** Defaults to the toolId. Keep it that way if per-tool config is keyed by stepId. */
  readonly stepId?: string;
  /**
   * Disambiguates calls that share `(executionId, stepId)` (several calls to one
   * tool within an execution): surfaces as {@link EffectContext.callKey}.
   */
  readonly callKey?: string;
}

/**
 * Advisory pre-warm hook (M6). Called off the durable path before an effect runs so a
 * backend can keep a model/connection/cache hot. It is latency-only — it MUST NOT emit
 * events or influence outcomes (P10 advisory plane). A failed/absent warm just means a
 * cold call.
 */
export interface Warmer {
  warm(toolId: string): void;
}

/**
 * Minimal structural view of a Zod schema's `safeParse` — kept structural so
 * `@loom/effect-runtime` stays zod-free (the same dependency-light idiom as
 * core's AgentSkillDef). A `Record<string, z.ZodSchema>` satisfies it directly.
 */
export interface ErrorChannelSchema {
  safeParse(
    input: unknown
  ): { success: true; data: unknown } | { success: false; error: { message: string } };
}

export interface Effect<TIn = unknown, TOut = unknown> {
  kind: EffectKind;
  /**
   * K9.3 — the effect's declared delivery semantic. `false` marks a mutating,
   * non-idempotent effect: recovery refuses to silently re-run an attempt in an
   * unknown state (it parks the execution at EFFECT_INDOUBT for an operator
   * verdict). `true` asserts re-runs are safe (dedupe at the provider via
   * `EffectContext.idempotencyKey`). Undeclared (`undefined`) keeps the legacy
   * at-least-once re-run — existing effects behave byte-identically (G2).
   */
  readonly idempotent?: boolean;
  /**
   * DE-4 (ADR 0060) — the effect's declared failure channels (channel name →
   * payload schema). Like `idempotent`, a declaration the kernel reads from the
   * registry: a `TypedFailure` thrown on a declared channel is recorded as a
   * typed STEP_FAILED and substituted on replay. A step-level `errors:`
   * declaration wins over this registry fallback. Undeclared channels keep the
   * legacy untyped at-least-once failure semantics (G2).
   */
  readonly errors?: Record<string, ErrorChannelSchema>;
  /**
   * Which invocation seam this effect belongs to — `"journaled"` (inside an
   * execution) or `"ambient"` (transient only). Like `idempotent`, a declaration
   * the runtime reads from the registry: `execute` refuses an `ambient` effect
   * and `invokeTransient` refuses a `"journaled"` one, both with
   * {@link EffectModeViolationError}. Undeclared keeps today's behaviour on both
   * paths (G2).
   *
   * This is a boundary check, not a journaling mode: an `ambient` effect is not
   * "an effect that skips its journal" — it is one that may not enter an
   * execution at all, so there remains exactly one replay model.
   */
  readonly mode?: EffectMode;
  /**
   * R12 — the sub-resource one call of this effect targets, for per-resource authorization.
   * ONE registered effect can front many resources (`mcp.invoke` fronts every tool on an MCP
   * server); an authorizer that only sees the effect id can allow all of them or none. When
   * declared, the runtime evaluates it on the call's input and puts the result on
   * `CapabilityRequest.resource`, so a grant or policy can name `<effectId>:<resource>`.
   *
   * Pure and cheap — it runs before the effect, on the raw (pre-redaction) input. Returning
   * `undefined` (or throwing) means "no resource": only an effect-wide grant then applies, so a
   * per-resource grant fails CLOSED rather than matching nothing-in-particular.
   */
  resourceOf?(input: TIn): string | undefined;
  /**
   * Advisory pre-warm (latency-only, off the durable path). If present, the
   * kernel may call it BEFORE the effect is needed to spin up a cold resource
   * the effect depends on — a K7 isolated child process, an LLM provider
   * connection/model cache, a remote worker. Like the {@link Warmer} seam it is
   * strictly latency: it MUST NOT emit events or influence outcomes (P10), and a
   * failure is a silent no-op → the first real call just runs cold. Idempotent
   * and safe to call repeatedly.
   */
  warm?(): void | Promise<void>;
  execute(input: TIn, ctx: EffectContext): Promise<TOut>;
}

/**
 * Invokes the downstream middleware, or finally the effect itself. Call `next()`
 * to pass this middleware's input through unchanged; call `next(override)` to
 * feed a TRANSFORMED input to the effect (e.g. K10.3 redaction resolving secret
 * references). The override flows to the effect body, not back to the log.
 */
export type EffectNext = (input?: unknown) => Promise<unknown>;

/**
 * Wraps a single effect execution — the cross-cutting seam (retries, logging,
 * tracing, idempotency) around every tool/LLM/human/a2a call.
 *
 * Replay-safety: middleware runs ONLY when an effect actually executes. Completed
 * steps short-circuit in `WorkflowContext.run` before `EffectRuntime.execute` is
 * called, so replayed/resumed runs never re-invoke middleware for work already in
 * the log. The one in-flight step that re-runs on crash-recovery re-runs its
 * middleware too, so any middleware with external side effects must tolerate
 * at-least-once (prefer emitting durable events via `ctx.emit`).
 *
 * Ordering is static (fixed at `EffectRuntime` construction) so it is
 * deterministic across replay: `middleware[0]` is outermost.
 */
export type EffectMiddleware = (
  ctx: EffectContext,
  input: unknown,
  next: EffectNext
) => Promise<unknown>;
