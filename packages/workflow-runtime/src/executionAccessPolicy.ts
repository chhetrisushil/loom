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
 * OWNERSHIP IS DURABLE (R3k, ADR 0111 D5)
 *
 * The kernel records the principal that started an execution on sequence 0 of its log and hands
 * the policy that owner on every request for an execution that already exists
 * (`ExecutionAuthzRequest.owner`). The policy keeps no table: ownership survives a restart, a
 * second node, recovery and a remote worker. A fork's owner is the forker. Consequences:
 *  - An execution with NO recorded owner — a legacy log started before EVENT_SCHEMA 1.23.0, an
 *    anonymous start (`allowAnonymous`), a supervisor child with no principal, a schedule
 *    occurrence, a shredded or unrestorable record — has an UNKNOWN owner. With the default
 *    `unknownOwner: "deny"` its owner/tenant-scoped ops are refused. `resolveOwner` is consulted
 *    only when the kernel supplied no owner (legacy logs); `unknownOwner: "allow"` is UNSAFE
 *    without it: anyone who can name such an id can act on it.
 *  - A SUPERVISED child's lifecycle (query/cancel/resume — never `actAsOwner`) is also reachable by
 *    its parent's owner: the kernel reads the nearest recorded owner up the child's trusted
 *    `parent` chain (`ExecutionAuthzRequest.parentOwner`, at most 8 hops, cycle-safe) and the
 *    policy accepts a match on the child's own owner OR on `parentOwner`. That covers a
 *    principal-less child (no own owner) and a delegated one (own owner = its child id). Only the
 *    lifecycle; the child's effects stay anonymous / under their attenuated delegation (D6).
 *    Note resume is included: under the default "tenant" scope a same-tenant principal can
 *    approve a gate inside a supervised child.
 *  - A principal-less caller is refused unless `allowAnonymous: true` (default false).
 *  - Kernel-internal callers (timers, recovery, supervisor, local worker) never reach this:
 *    they present the runtime's system grant and bypass the authorizer. The effects of those
 *    paths run as the recorded owner, not as the system.
 *  - `fork(…, { actAs: "owner" })` is a separate op, `"actAsOwner"`, and is DENIED by default.
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
  /**
   * Scope per op. Defaults: `start: "any"`, `resume`/`cancel`/`query`: `"tenant"`,
   * `actAsOwner: "deny"` (a fork acts as the forker unless this is opened, ADR 0111 D7), and
   * `send: "tenant"` (ADR 0110 D1: a message steers an agent, so the sender is judged against the
   * chain head's owner like a resume), `annotate: "owner"` (ADR 0116: a late reward steers policy learning, so only the
   * recorded owner may write one; a tenant-wide reward pipeline opts in with `annotate: "tenant"`),
   * `discard: "deny"` (ADR 0110 amendment: an operator's skip of unconsumed inbox messages destroys
   * messages a sender was told were accepted, so it is closed until the integrator opens it for its
   * operators: `discard: "tenant"` for a tenant's operators, `"any"` for a platform operator).
   */
  rules?: Partial<Record<ExecutionOp, ExecutionScope>>;
  /** When set, only these workflow ids may be started/resumed/cancelled/queried; others are denied. */
  allowWorkflows?: readonly string[];
  /** Require `principal.tenant` on every call. Default false. */
  requireTenant?: boolean;
  /** Let a principal-less call through. Default false — the escape hatch is explicit. */
  allowAnonymous?: boolean;
  /**
   * Answer ownership for an execution the kernel supplied NO owner for (a legacy log, written
   * before the principal was durable). Consulted only then; the recorded owner always wins.
   * Synchronous (the SPI verdict is). Return `undefined` when unknown.
   */
  resolveOwner?: (executionId: string) => ExecutionOwner | undefined;
  /** What to do with an owner/tenant-scoped op on an execution whose owner is unknown. Default "deny". */
  unknownOwner?: "deny" | "allow";
}

export type ExecutionAccessPolicy = ExecutionAuthorizer & {
  /**
   * The resolved scope of every op (the defaults merged with `rules`). READ-ONLY, for a layer that must
   * know whether the policy it sits on is owner-scoped before it trusts it (`@loom/conversation` refuses a
   * policy that admits a tenant peer to query / send / cancel a conversation). Informational: it is not
   * consulted by `authorize`, and changing it changes nothing.
   */
  readonly scopes: Readonly<Record<ExecutionOp, ExecutionScope>>;
};

const DEFAULT_RULES: Record<ExecutionOp, ExecutionScope> = {
  start: "any",
  resume: "tenant",
  cancel: "tenant",
  query: "tenant",
  actAsOwner: "deny",
  send: "tenant",
  annotate: "owner",
  discard: "deny",
};

const deny = (reason: string): ExecutionAuthzVerdict => ({ allowed: false, reason });
const allow: ExecutionAuthzVerdict = { allowed: true };

export function executionAccessPolicy(options: ExecutionAccessOptions = {}): ExecutionAccessPolicy {
  const rules = { ...DEFAULT_RULES, ...options.rules };
  const workflows =
    options.allowWorkflows !== undefined ? new Set(options.allowWorkflows) : undefined;

  const sameTenant = (p: PrincipalChain, o: ExecutionOwner): boolean => p.tenant === o.tenant;

  return {
    scopes: Object.freeze({ ...rules }),
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
      if (typeof principal.actor !== "string" || principal.actor.length === 0) {
        return deny("the principal names no actor");
      }
      if (options.requireTenant === true && principal.tenant === undefined) {
        return deny("the principal names no tenant");
      }
      if (workflows !== undefined && !workflows.has(workflowId)) {
        return deny(`workflow "${workflowId}" is not permitted`);
      }
      const scope = rules[op] ?? "deny";
      if (scope === "deny") return deny(`"${op}" is not permitted`);
      // A start has no owner yet, so every non-"deny" scope means "any identified principal".
      if (op === "start") return allow;
      if (scope === "any") return allow;
      // The recorded owner (read by the kernel from sequence 0) is authoritative; `resolveOwner`
      // answers only for a log that recorded none.
      // An owner naming neither tenant nor actor is no owner at all (an anonymous start).
      const recorded =
        request.owner !== undefined &&
        (request.owner.actor !== undefined || request.owner.tenant !== undefined)
          ? request.owner
          : undefined;
      // R3k rounds 2-3 (D6) — an execution started at a TRUSTED lineage (a supervised child) is
      // also reachable through its parent's owner: the kernel supplies `parentOwner`, the nearest
      // recorded owner up the trusted `parent` chain, for an anonymous child AND for an
      // identified/delegated one (whose own owner is its child id). Owner match on the child's
      // own recorded owner OR on `parentOwner`; either suffices. NEVER for `actAsOwner`: a child's
      // effects stay under its own (anonymous or attenuated) authority, so there is no owner
      // authority to act as. `resolveOwner` answers only when the kernel supplied neither.
      const parentOwner =
        op !== "actAsOwner" &&
        request.parentOwner !== undefined &&
        (request.parentOwner.actor !== undefined || request.parentOwner.tenant !== undefined)
          ? request.parentOwner
          : undefined;
      const candidates: ExecutionOwner[] = [];
      if (recorded !== undefined) candidates.push(recorded);
      if (parentOwner !== undefined) candidates.push(parentOwner);
      if (candidates.length === 0) {
        const resolved = options.resolveOwner?.(executionId);
        if (resolved !== undefined) candidates.push(resolved);
      }
      if (candidates.length === 0) {
        return options.unknownOwner === "allow"
          ? allow
          : deny("the execution's owner is unknown to this policy");
      }
      let refusal = "";
      for (const owner of candidates) {
        if (!sameTenant(principal, owner)) {
          refusal ||= "the execution belongs to another tenant";
          continue;
        }
        // An owner that names no actor cannot be matched, so "owner" must refuse — falling back
        // to the tenant would widen the rule the integrator wrote.
        if (scope === "owner" && (owner.actor === undefined || owner.actor !== principal.actor)) {
          refusal ||= "only the execution's owner may do this";
          continue;
        }
        return allow;
      }
      return deny(refusal);
    },
  };
}
