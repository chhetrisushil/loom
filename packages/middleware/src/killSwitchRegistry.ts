import type { EffectContext, EffectMiddleware } from "@loom/effect-runtime";
import { SafetyViolationError } from "./safety";

// ── Scoped kill switch (R9 — autonomy envelope) ──────────────────────────────
//
// `killSwitch(isTripped)` (safety.ts) is a synchronous per-process predicate over NOTHING:
// it cannot say WHICH tenant to stop, and an operator has no handle to reach it. A runaway
// agent for one tenant needed either a redeploy or stopping everyone.
//
// This adds the missing scopes and an admin handle:
//   system   — every effect in every tenant stops
//   tenant   — every effect whose principal chain names that tenant stops
//   workflow — every effect of that flow (the "stop this agent" case)
//
// It is consulted BEFORE each effect (outermost middleware) and refuses with a typed
// `KillSwitchEngagedError`. What it does NOT do — and cannot, in a 1P middleware — is
// reach an effect already in flight, or cancel a running execution's children: that is the
// kernel's cancel cascade. A stopped execution fails at its NEXT effect; a flow that
// catches the refusal and carries on to a non-effect finish is not interrupted.
//
// The registry is an SPI so a deployment can back the flags with a shared store (a DB row,
// a feature-flag service) and stop a tenant across processes; `InMemoryKillSwitch` is the
// single-process implementation and the reference. `check` may be async — a networked
// registry should cache with a short TTL, since it sits on every effect.

export type KillScope = "system" | "tenant" | "workflow";

/** Why an effect is being refused. */
export interface KillVerdict {
  scope: KillScope;
  /** The tenant / workflow id (absent for `system`). */
  key?: string;
  reason: string;
}

/**
 * Where the stop flags live. Return `undefined` to let the effect run. Must be cheap — it is
 * consulted before EVERY effect — and must fail CLOSED or open as the deployment prefers;
 * a throw is treated as a refusal (fail closed) by {@link killSwitchMiddleware}.
 */
export interface KillSwitchRegistry {
  /**
   * Where the stop flags live, DECLARED by the registry. Optional and additive (no SPI version
   * bump: an absent field changes nothing for any existing registry).
   *
   *  - `"process"` — the flags live in this process's memory ({@link InMemoryKillSwitch}); a stop
   *    issued in another process is invisible here.
   *  - `"shared"` — the flags live in a store every process reads (a DB row, a feature-flag
   *    service), so a stop issued anywhere applies here.
   *
   * Tooling that runs your effects OUTSIDE the long-running app (`loom resume` / `loom start`)
   * reads this and is FAIL-CLOSED: only a registry that affirmatively declares `"shared"` is
   * trusted to carry an operator stop across processes. Absent, or anything else, is treated as
   * process-local. A wrapper or subclass must re-declare it: forwarding is the wrapper's claim.
   */
  readonly scope?: "process" | "shared";
  check(ctx: EffectContext): KillVerdict | undefined | Promise<KillVerdict | undefined>;
}

export class KillSwitchEngagedError extends SafetyViolationError {
  readonly scope: KillScope;
  readonly key: string | undefined;
  /** A stop is a decision, not a fault: retrying it just repeats the refusal. */
  readonly retryable = false;
  constructor(verdict: KillVerdict) {
    super(
      "kill-switch",
      `${verdict.scope}${verdict.key !== undefined ? ` "${verdict.key}"` : ""} stopped: ${verdict.reason}`,
      "kill-switch"
    );
    this.name = "KillSwitchEngagedError";
    this.scope = verdict.scope;
    this.key = verdict.key;
  }
}

/** Single-process registry with the operator-facing admin API. */
export class InMemoryKillSwitch implements KillSwitchRegistry {
  /** Declares itself process-local (see {@link KillSwitchRegistry.scope}). */
  readonly scope = "process" as const;
  private system: string | undefined;
  private readonly tenants = new Map<string, string>();
  private readonly workflows = new Map<string, string>();

  /** Stop every effect in the process. */
  stopAll(reason = "system stop"): void {
    this.system = reason;
  }
  resumeAll(): void {
    this.system = undefined;
  }
  /** Stop every effect whose principal chain names `tenant`. */
  stopTenant(tenant: string, reason = "tenant stop"): void {
    this.tenants.set(tenant, reason);
  }
  resumeTenant(tenant: string): void {
    this.tenants.delete(tenant);
  }
  /** Stop every effect of one flow (one agent). */
  stopWorkflow(workflowId: string, reason = "workflow stop"): void {
    this.workflows.set(workflowId, reason);
  }
  resumeWorkflow(workflowId: string): void {
    this.workflows.delete(workflowId);
  }

  /** What is currently stopped, for an operator console. */
  status(): {
    system?: string;
    tenants: Record<string, string>;
    workflows: Record<string, string>;
  } {
    return {
      ...(this.system !== undefined && { system: this.system }),
      tenants: Object.fromEntries(this.tenants),
      workflows: Object.fromEntries(this.workflows),
    };
  }

  check(ctx: EffectContext): KillVerdict | undefined {
    if (this.system !== undefined) return { scope: "system", reason: this.system };
    const tenant = ctx.principal?.tenant;
    if (tenant !== undefined) {
      const reason = this.tenants.get(tenant);
      if (reason !== undefined) return { scope: "tenant", key: tenant, reason };
    }
    const wf = this.workflows.get(ctx.workflowId);
    if (wf !== undefined) return { scope: "workflow", key: ctx.workflowId, reason: wf };
    return undefined;
  }
}

/**
 * Refuse every effect the registry stops. Place it OUTERMOST so a stopped effect never
 * resolves a secret or spends budget. The refusal is recorded as a durable `SAFETY_BLOCKED`
 * fact (the same audit list the K6 kill-switch validator writes) and thrown as
 * {@link KillSwitchEngagedError}, a `SafetyViolationError` carrying `retryable = false`
 * (which `retryMiddleware`'s default classifier honours), so it fails the step through the
 * existing path and is not retried.
 */
export function killSwitchMiddleware(registry: KillSwitchRegistry): EffectMiddleware {
  return async (ctx, _input, next): Promise<unknown> => {
    let verdict: KillVerdict | undefined;
    try {
      verdict = await registry.check(ctx);
    } catch (err) {
      // A registry that cannot answer fails CLOSED: a kill switch that errors open is a
      // switch that is off exactly when the store it reads is down.
      verdict = {
        scope: "system",
        reason: `kill-switch registry unavailable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (verdict !== undefined) {
      ctx.emit("SAFETY_BLOCKED", {
        stepId: ctx.stepId,
        validatorId: "kill-switch",
        phase: "input",
        reason: verdict.reason,
        category: "kill-switch",
        scope: verdict.scope,
        ...(verdict.key !== undefined && { key: verdict.key }),
      });
      throw new KillSwitchEngagedError(verdict);
    }
    return next();
  };
}
