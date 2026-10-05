import type { PrincipalChain } from "@loom/effect-runtime";
import type {
  ExecutionAuthorizer,
  ExecutionAuthzRequest,
  ExecutionAuthzVerdict,
  ExecutionOp,
} from "./types";

/**
 * R3 (1P half) — the first-party reference {@link ExecutionAuthorizer}.
 *
 * Loom shipped the SPI and no implementation, so every app hand-wrote one (or none). This is
 * the small policy most apps want: who may start, and — for an execution that already exists —
 * who may resume / cancel / query it. Pair it with `executionAuthz: { requirePrincipal: true }`
 * (`security.strict` does) so a call that carries no principal reaches it and is refused.
 *
 * WHAT IT ENFORCES TODAY, AND WHAT IT CANNOT
 *
 * The kernel does not yet record WHO started an execution (R3 kernel half, ADR 0111), so this
 * policy remembers it. Ownership is recorded in {@link ExecutionAuthorizer.committed} — once the
 * runtime has made the start durable — NEVER in `authorize("start")`, which a refused start
 * (duplicate id, invalid input, storage error) also passes through: recording there let a caller
 * whose start FAILED take the id of an execution someone else owns or is about to own. First
 * writer wins. Consequences, stated plainly:
 *  - Ownership is NOT durable. After a process restart an execution's owner is unknown, and
 *    with the default `unknownOwner: "deny"` its owner/tenant-scoped ops are refused. Supply
 *    `resolveOwner` to answer from your own durable record (a table, the execution id's own
 *    convention) — it is consulted first. `unknownOwner: "allow"` is UNSAFE without a
 *    `resolveOwner`: every execution this process did not itself see start is open to anyone
 *    who can name its id.
 *  - The owner table never evicts (an evicted victim would be taken over under `"allow"`, and
 *    refused under `"deny"`). At `maxTracked` the policy REFUSES further starts, loudly; size it
 *    for the executions you keep, or answer ownership from `resolveOwner` instead.
 *  - A start that carries no principal of its own (a supervisor's child, a kernel-internal
 *    fork) inherits its parent's owner when the runtime names the parent. A schedule
 *    occurrence or a timer wake has no parent and no principal: it has NO owner, so
 *    owner/tenant-scoped ops on it are refused unless `resolveOwner` answers for it.
 *  - A principal-less caller is refused unless `allowAnonymous: true` (default false).
 *  - Kernel-internal callers (timers, recovery, supervisor, local worker) never reach this:
 *    they present the runtime's system grant and bypass the authorizer.
 */
export interface ExecutionOwner {
  actor?: string;
  tenant?: string;
}

/**
 * Who may perform an op, relative to the execution's owner:
 *  - `"owner"`  — the same actor (and the same tenant, when the owner has one);
 *  - `"tenant"` — any actor in the owner's tenant (both tenant-less counts as the same tenant);
 *  - `"any"`    — any identified principal (an actor), owner not consulted;
 *  - `"deny"`   — no one (the op is closed to the public edge).
 */
export type ExecutionScope = "owner" | "tenant" | "any" | "deny";

export interface ExecutionAccessOptions {
  /** Scope per op. Defaults: `start: "any"`, `resume`/`cancel`/`query`: `"tenant"`. */
  rules?: Partial<Record<ExecutionOp, ExecutionScope>>;
  /** When set, only these workflow ids may be started/resumed/cancelled/queried; others are denied. */
  allowWorkflows?: readonly string[];
  /** Require `principal.tenant` on every call. Default false. */
  requireTenant?: boolean;
  /** Let a principal-less call through. Default false — the escape hatch is explicit. */
  allowAnonymous?: boolean;
  /**
   * Answer ownership from your own durable record. Consulted before the in-process map.
   * Synchronous (the SPI verdict is). Return `undefined` when unknown.
   */
  resolveOwner?: (executionId: string) => ExecutionOwner | undefined;
  /** What to do with an owner/tenant-scoped op on an execution whose owner is unknown. Default "deny". */
  unknownOwner?: "deny" | "allow";
  /**
   * Upper bound on remembered owners. Default 100_000. Owners are NEVER evicted: at the bound
   * a further `start` is refused (see the class comment) — a policy that silently forgot an
   * owner would hand the execution to whoever named its id next.
   */
  maxTracked?: number;
}

export interface ExecutionAccessPolicy extends ExecutionAuthorizer {
  /** The remembered (or resolved) owner of an execution. */
  ownerOf(executionId: string): ExecutionOwner | undefined;
  /**
   * Record an owner out of band (e.g. re-adopt executions after a restart). First writer wins
   * unless `force`. Returns `false` when the owner was NOT recorded (the table is full, or the
   * id already has an owner and `force` is not set).
   */
  adopt(executionId: string, owner: ExecutionOwner, force?: boolean): boolean;
  /** Number of owners currently remembered. */
  readonly tracked: number;
}

const DEFAULT_RULES: Record<ExecutionOp, ExecutionScope> = {
  start: "any",
  resume: "tenant",
  cancel: "tenant",
  query: "tenant",
};

const deny = (reason: string): ExecutionAuthzVerdict => ({ allowed: false, reason });
const allow: ExecutionAuthzVerdict = { allowed: true };

export function executionAccessPolicy(options: ExecutionAccessOptions = {}): ExecutionAccessPolicy {
  const rules = { ...DEFAULT_RULES, ...options.rules };
  const maxTracked = options.maxTracked ?? 100_000;
  if (!Number.isSafeInteger(maxTracked) || maxTracked < 1) {
    throw new Error("executionAccessPolicy: `maxTracked` must be an integer >= 1");
  }
  const workflows =
    options.allowWorkflows !== undefined ? new Set(options.allowWorkflows) : undefined;
  const owners = new Map<string, ExecutionOwner>();

  const ownerOf = (executionId: string): ExecutionOwner | undefined =>
    options.resolveOwner?.(executionId) ?? owners.get(executionId);

  const adopt = (executionId: string, owner: ExecutionOwner, force = false): boolean => {
    const known = owners.has(executionId);
    if (known && !force) return false;
    if (!known && owners.size >= maxTracked) return false; // never evict: see `maxTracked`
    owners.set(executionId, owner);
    return true;
  };

  const sameTenant = (p: PrincipalChain, o: ExecutionOwner): boolean => p.tenant === o.tenant;

  return {
    authorize(request: ExecutionAuthzRequest): ExecutionAuthzVerdict {
      const { op, executionId, workflowId, principal } = request;
      if (
        principal === undefined ||
        (principal.actor === undefined && principal.tenant === undefined)
      ) {
        return options.allowAnonymous === true
          ? allow
          : deny("an authenticated principal is required (anonymous calls are refused)");
      }
      if (principal.actor === undefined) return deny("the principal names no actor");
      if (options.requireTenant === true && principal.tenant === undefined) {
        return deny("the principal names no tenant");
      }
      if (workflows !== undefined && !workflows.has(workflowId)) {
        return deny(`workflow "${workflowId}" is not permitted`);
      }
      const scope = rules[op] ?? "deny";
      if (scope === "deny") return deny(`"${op}" is not permitted`);
      // A start has no owner yet, so every non-"deny" scope means "any identified principal".
      // Ownership is NOT recorded here (see `committed`): this verdict can still be followed by
      // a refused start. Refuse up front when there will be no room to record the owner.
      if (op === "start") {
        if (owners.size >= maxTracked && !owners.has(executionId)) {
          return deny(
            `the execution owner table is full (maxTracked ${maxTracked}); no further execution can be started`
          );
        }
        return allow;
      }
      if (scope === "any") return allow;
      const owner = ownerOf(executionId);
      if (owner === undefined) {
        return options.unknownOwner === "allow"
          ? allow
          : deny("the execution's owner is unknown to this policy");
      }
      if (!sameTenant(principal, owner)) return deny("the execution belongs to another tenant");
      if (scope === "owner" && (owner.actor === undefined || owner.actor !== principal.actor)) {
        // An owner that names no actor cannot be matched, so "owner" must refuse — falling back
        // to the tenant would widen the rule the integrator wrote.
        return deny("only the execution's owner may do this");
      }
      return allow;
    },
    committed(request: ExecutionAuthzRequest): void {
      if (request.op !== "start") return;
      const { principal, executionId, parentExecutionId } = request;
      if (principal?.actor !== undefined) {
        adopt(executionId, {
          actor: principal.actor,
          ...(principal.tenant !== undefined && { tenant: principal.tenant }),
        });
        return;
      }
      // No principal of its own (a supervisor's child): inherit the parent's owner, when known.
      const parent = parentExecutionId !== undefined ? ownerOf(parentExecutionId) : undefined;
      if (parent !== undefined) adopt(executionId, { ...parent });
    },
    ownerOf,
    adopt,
    get tracked() {
      return owners.size;
    },
  };
}
