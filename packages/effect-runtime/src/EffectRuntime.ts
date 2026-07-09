import { Priority, type Scheduler } from "@loom/scheduler";
import {
  type CapabilityAuthorizer,
  CapabilityDeniedError,
  type EffectRuntimeOptions,
} from "./authz";
import type { Effect, EffectContext, EffectMiddleware, EffectNext, Warmer } from "./types";

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
    // Protection ring first: an unauthorized effect never runs, and its denial is a
    // durable, auditable fact (P9). Checked before registry lookup so probing for
    // unregistered effects is denied too.
    if (this.authorizer !== undefined) {
      const decision = this.authorizer.authorize({
        toolId,
        executionId: ctx.executionId,
        workflowId: ctx.workflowId,
        stepId: ctx.stepId,
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
    let chain: EffectNext = () => effect.execute(input, ctx);
    for (let i = this.middleware.length - 1; i >= 0; i--) {
      const mw = this.middleware[i]!;
      const downstream = chain;
      chain = () => mw(ctx, input, downstream);
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

  has(toolId: string): boolean {
    return this.registry.has(toolId);
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
}
