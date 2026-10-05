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
 * policy remembers it: every `start` it authorizes records `executionId → { actor, tenant }`
 * (first writer wins) in a bounded in-process map. Consequences, stated plainly:
 *  - Ownership is NOT durable. After a process restart (or an eviction past `maxTracked`) an
 *    execution's owner is unknown, and with the default `unknownOwner: "deny"` its
 *    owner/tenant-scoped ops are refused. Supply `resolveOwner` to answer from your own
 *    durable record (a table, the execution id's own convention) — it is consulted first.
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
  /** Upper bound on remembered owners (FIFO eviction). Default 100_000. */
  maxTracked?: number;
}

export interface ExecutionAccessPolicy extends ExecutionAuthorizer {
  /** The remembered (or resolved) owner of an execution. */
  ownerOf(executionId: string): ExecutionOwner | undefined;
  /** Record an owner out of band (e.g. re-adopt executions after a restart). First writer wins unless `force`. */
  adopt(executionId: string, owner: ExecutionOwner, force?: boolean): void;
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

  const adopt = (executionId: string, owner: ExecutionOwner, force = false): void => {
    if (!force && owners.has(executionId)) return;
    owners.delete(executionId); // re-insert at the tail so eviction is true FIFO-by-write
    owners.set(executionId, owner);
    if (owners.size > maxTracked) {
      const oldest = owners.keys().next();
      if (!oldest.done) owners.delete(oldest.value);
    }
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
      if (scope === "any" || op === "start") {
        if (op === "start") {
          // First writer wins: a later start naming a known id is refused by the runtime
          // (ExecutionAlreadyExistsError), and must not be able to re-assign its owner.
          adopt(executionId, {
            actor: principal.actor,
            ...(principal.tenant !== undefined && { tenant: principal.tenant }),
          });
        }
        return allow;
      }
      const owner = ownerOf(executionId);
      if (owner === undefined) {
        return options.unknownOwner === "allow"
          ? allow
          : deny("the execution's owner is unknown to this policy");
      }
      if (!sameTenant(principal, owner)) return deny("the execution belongs to another tenant");
      if (scope === "owner" && owner.actor !== undefined && owner.actor !== principal.actor) {
        return deny("only the execution's owner may do this");
      }
      return allow;
    },
    ownerOf,
    adopt,
    get tracked() {
      return owners.size;
    },
  };
}
