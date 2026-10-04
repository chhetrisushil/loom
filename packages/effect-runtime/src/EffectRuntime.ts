import { Priority, type Scheduler } from "@loom/scheduler";
import {
  type CapabilityAuthorizer,
  CapabilityDeniedError,
  type EffectRuntimeOptions,
} from "./authz";
import { EffectModeViolationError } from "./types";
import type {
  Effect,
  EffectContext,
  EffectMiddleware,
  EffectNext,
  ErrorChannelSchema,
  TransientInvokeOptions,
  Warmer,
} from "./types";

export class EffectRuntime {
  private readonly registry = new Map<string, Effect>();
  private readonly middleware: readonly EffectMiddleware[];
  private readonly authorizer: CapabilityAuthorizer | undefined;
  private readonly scheduler: Scheduler | undefined;
  private readonly warmer: Warmer | undefined;

  /**
   * @param middleware Cross-cutting middleware applied around every effect
   * execution, in order — `middleware[0]` is outermost. The list is fixed here
   * (static ⇒ deterministic across replay). An empty list (the default) makes
   * `execute` behave identically to a bare effect call.
   * @param options Optional `authorizer` (K2 protection ring), `scheduler` (M6 —
   * route effects through it for bounded concurrency + priority), and `warmer` (M6 —
   * advisory off-log pre-warm). All omittable; the empty case is the zero-overhead
   * direct path with today's behaviour.
   */
  constructor(middleware: readonly EffectMiddleware[] = [], options: EffectRuntimeOptions = {}) {
    this.middleware = middleware;
    this.authorizer = options.authorizer;
    this.scheduler = options.scheduler;
    this.warmer = options.warmer;
  }

  register(toolId: string, effect: Effect): void {
    this.registry.set(toolId, effect);
  }

  async execute<TIn = unknown, TOut = unknown>(
    toolId: string,
    input: TIn,
    ctx: EffectContext
  ): Promise<TOut> {
    return this.runSeam<TIn, TOut>(toolId, input, ctx, "journaled");
  }

  // The shared execute path for both seams. `seam` records which entry point the
  // caller came through, so the effect-mode boundary is enforced in exactly one
  // place and cannot be spoofed by hand-building a context that merely *looks*
  // transient. Everything else — K2 authz, the middleware chain, K8 cancellation
  // — is identical on both paths.
  private async runSeam<TIn = unknown, TOut = unknown>(
    toolId: string,
    input: TIn,
    ctx: EffectContext,
    seam: "journaled" | "ambient"
  ): Promise<TOut> {
    // Protection ring first: an unauthorized effect never runs, and its denial is a
    // durable, auditable fact (P9). Checked before registry lookup so probing for
    // unregistered effects is denied too.
    if (this.authorizer !== undefined) {
      const decision = this.authorizer.authorize({
        toolId,
        executionId: ctx.executionId,
        workflowId: ctx.workflowId,
        stepId: ctx.stepId,
        ...(ctx.principal !== undefined && { principal: ctx.principal }),
      });
      if (!decision.allowed) {
        const reason = decision.reason ?? "not authorized";
        ctx.emit("EFFECT_DENIED", { toolId, stepId: ctx.stepId, reason });
        throw new CapabilityDeniedError(toolId, reason);
      }
    }

    const effect = this.registry.get(toolId);
    if (!effect) {
      throw new Error(`No effect registered for toolId: "${toolId}"`);
    }

    // The determinism-boundary check (ADR 0073). A declared mode pins the effect
    // to one seam: `ambient` reads (pagination, drill-down, a surface refetch)
    // must never append to the log, and a `journaled` effect invoked transiently
    // would silently produce no durable fact. Undeclared effects are unaffected,
    // so this is byte-identical for everything that has not opted in (G2).
    if (effect.mode !== undefined && effect.mode !== seam) {
      throw new EffectModeViolationError(toolId, effect.mode, seam);
    }

    // K8 — a cancelled/deadline-breached execution never starts another effect:
    // fail fast before the middleware chain rather than relying on every effect
    // body to check the signal.
    if (ctx.signal?.aborted === true) {
      throw ctx.signal.reason instanceof Error
        ? ctx.signal.reason
        : new Error(`effect "${toolId}" aborted before start`);
    }

    // Build the effect+middleware chain as a single thunk. Fold right-to-left so
    // middleware[0] ends up outermost (its `next` runs middleware[1], … the effect last).
    // `next(override?)` threads an optional transformed input down the chain
    // (K10.3 redaction resolves secret references into the value the effect sees);
    // middleware that pass their received input unchanged just call `next()`.
    // Middleware see the resolved toolId on their context view (per-tool config,
    // e.g. claim-check digests); the effect receives the caller's ctx unchanged.
    const mwCtx: EffectContext =
      this.middleware.length > 0 && ctx.toolId === undefined ? { ...ctx, toolId } : ctx;
    let chain: EffectNext = (inp: unknown = input) => effect.execute(inp, ctx);
    for (let i = this.middleware.length - 1; i >= 0; i--) {
      const mw = this.middleware[i]!;
      const downstream = chain;
      chain = (inp: unknown = input) =>
        mw(mwCtx, inp, (override?: unknown) => downstream(override ?? inp));
    }

    // Advisory pre-warm (M6) — off the durable path, fire-and-forget, no event.
    this.warmer?.warm(toolId);

    // M6 — route through the scheduler for bounded concurrency + priority ordering
    // when configured; otherwise the zero-overhead direct path (unchanged).
    if (this.scheduler !== undefined) {
      const priority = (ctx.priority ?? Priority.Normal) as Priority;
      return this.scheduler.schedule(() => chain(), {
        priority,
        label: toolId,
        ...(ctx.signal !== undefined && { signal: ctx.signal }),
      }) as Promise<TOut>;
    }
    return chain() as Promise<TOut>;
  }

  /**
   * Run a single registered effect ONCE, off the durable path — the supported
   * façade over the already-blessed transient invocation (DE-series eval; ADR
   * 0065 "don't make it a run until something durable happens"). It is exactly
   * {@link execute}, but the framework owns the {@link EffectContext} instead of
   * every caller hand-rolling one.
   *
   * What it does NOT do — the load-bearing guarantee (R1): nothing is written.
   * The EffectRuntime holds no event store, no journal, and no fence, so a
   * transient invocation produces zero envelopes, no `EXECUTION_STARTED`, no
   * `STEP_*`, and no snapshot — structurally, not by convention. This is the
   * sanctioned side of the ADR 0065 line: no execution, no fold, no recovery.
   *
   * Middleware contract (R3): the SAME statically configured effect-runtime
   * middleware chain that a durable step's effect call runs also runs here —
   * retry/backoff and the K2 authorizer are effect-local and remain in force.
   * What is bypassed is everything ABOVE this layer: the workflow interpreter's
   * journaling/durability (fold, `ExecutionJournal`, fencing, snapshots) is not
   * EffectRuntime middleware at all, so there is nothing to opt out of.
   *
   * `ctx.emit` is a no-op sink (R4): an effect that emits transiently has the
   * event DROPPED by construction — never buffered, never later flushed. Do not
   * author a transient effect that relies on emitting durable state.
   *
   * The synthesized identity is throwaway: `idempotencyKey` is left unset, so do
   * NOT rely on provider-side dedup across transient calls (they carry no stable
   * key — a transient read path is expected to be retry-on-client).
   *
   * L30: `opts.as` stamps the call with an existing execution's identity (used by
   * `ctx.decide`'s scope); it changes the claimed identity only, not R1-R5.
   *
   * @param opts optional {@link TransientInvokeOptions} — `signal` (cancellation,
   * R5), `principal` (authz still enforced if wired), `label` (trace tag only).
   */
  async invokeTransient<TIn = unknown, TOut = unknown>(
    toolId: string,
    input: TIn,
    opts: TransientInvokeOptions = {}
  ): Promise<TOut> {
    // Synthesize the throwaway context the caller must never build (R2). The ids
    // are meaningful only for the lifetime of this call: `executionId` carries
    // the trace label for middleware correlation, `stepId` the toolId. `emit` is
    // the drop sink (R4) — including the authz-denial emit, which still throws.
    const ctx: EffectContext = {
      executionId: opts.as?.executionId ?? `transient:${opts.label ?? toolId}`,
      stepId: opts.as?.stepId ?? toolId,
      workflowId: opts.as?.workflowId ?? "transient",
      attempt: 1,
      emit: () => {},
      ...(opts.as?.callKey !== undefined && { callKey: opts.as.callKey }),
      ...(opts.resources !== undefined && { resources: opts.resources }),
      ...(opts.signal !== undefined && { signal: opts.signal }),
      ...(opts.principal !== undefined && { principal: opts.principal }),
    };
    return this.runSeam<TIn, TOut>(toolId, input, ctx, "ambient");
  }

  has(toolId: string): boolean {
    return this.registry.has(toolId);
  }

  /**
   * Advisory pre-warm for a capability, ahead of when it's needed (latency-only,
   * off the durable path). Spins up the registered effect's own cold resource
   * (`Effect.warm` — e.g. a K7 child process or an LLM connection) AND fires the
   * configured {@link Warmer} seam. Never throws: an unregistered toolId is a
   * no-op and a warm failure is swallowed (the real call just runs cold). Does
   * NOT authorize, meter, emit, or touch the fold — warming a capability is not
   * invoking it (P10).
   */
  warm(toolId: string): void {
    const effect = this.registry.get(toolId);
    if (effect?.warm !== undefined) {
      try {
        void Promise.resolve(effect.warm()).catch(() => {});
      } catch {
        // advisory — a synchronous warm failure is a silent no-op
      }
    }
    this.warmer?.warm(toolId);
  }

  /**
   * K9.3 — a registered effect's declared delivery semantic
   * (`new ToolEffect(fn, { idempotent })` / `tool$({ idempotent })`). `false`
   * means recovery must not silently re-run an attempt in an unknown state;
   * `undefined` (undeclared, or no such effect) keeps the legacy at-least-once
   * re-run. Pure/synchronous so the recovery decision is deterministic.
   */
  declaredIdempotence(toolId: string): boolean | undefined {
    return this.registry.get(toolId)?.idempotent;
  }

  /**
   * DE-4 — a registered effect's declared failure channels (`Effect.errors`).
   * The kernel's registry fallback when the invoking step declares no `errors:`
   * map of its own; `undefined` (undeclared, or no such effect) means every
   * TypedFailure from this effect degrades to the legacy untyped failure. Pure/
   * synchronous so the replay decision is deterministic.
   */
  declaredErrors(toolId: string): Record<string, ErrorChannelSchema> | undefined {
    return this.registry.get(toolId)?.errors;
  }

  /**
   * A registered effect's declared determinism-boundary mode (ADR 0073), for tooling —
   * `@loom/verify` reads it to flag a `journaled` effect reached from a `ctx.decide`
   * scope, which the transient seam refuses. `undefined` when undeclared or unregistered.
   */
  modeOf(toolId: string): Effect["mode"] | undefined {
    return this.registry.get(toolId)?.mode;
  }

  /** The registered effect's kind (`tool` / `llm` / `human` / `a2a`), for tooling. */
  kindOf(toolId: string): Effect["kind"] | undefined {
    return this.registry.get(toolId)?.kind;
  }
}
