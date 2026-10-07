import { createHmac, timingSafeEqual } from "node:crypto";
import type { EventEnvelope } from "@loom/core";
import { fail } from "@loom/core";
import type { PrincipalChain } from "@loom/effect-runtime";
import { signDelegation, verifyDelegation } from "@loom/effect-runtime";
import {
  type ExecutionEnumerable,
  type TimerStore,
  isReservedStream,
  iterateExecutionIds,
  readRangeOf,
} from "@loom/event-runtime";
import { ResumeContendedError, ResumeRefusedError, scheduleRedrive } from "@loom/workflow-runtime";
import type {
  ExecutionContext,
  LineageGrant,
  PinPredicate,
  PrincipalCodec,
  RedriveBackoff,
  Redriver,
  RegisteredFlow,
  SystemGrant,
  WorkflowRuntime,
} from "@loom/workflow-runtime";

// ── Cross-execution orchestration (child workflows) ───────────────────────────
//
// Spawn a child workflow from a parent and durably await its result — WITHOUT a new
// syscall. The primitive is composed from ones that already exist:
//   • `ctx.decide` durably (and replay-safely) fixes the child's id + spec;
//   • `ctx.suspend({ on: CHILD_DONE, correlationKey: childId })` parks the parent;
//   • a supervisor starts the child, and on the child's completion `resume`s the parent
//     with the child's output.
// Each await rides ONE suspend/resume cycle per parent (the single `_resumePayload` slot):
//   • `awaitChild` — spawn ONE child, suspend once, resume once with its output; THROWS
//     `childFailed` if the child fails/cancels.
//   • `awaitChildren` — spawn N children CONCURRENTLY under a shared group correlationKey,
//     suspend once, resume once with a wait-all array of SETTLED `ChildResult`s in input
//     order (the parent weighs partial failure itself).
//   • `awaitAll` — `awaitChildren` for the all-or-nothing path: unwrapped outputs in input
//     order, or THROWS `childFailed` (first failure) if any member didn't complete.
//
// DURABILITY RACE (both paths) — `onEvent` fires synchronously at commit time, before the
// async durable write drains, so a fast/instant child can complete and resume its parent
// before the parent's suspend is readable ("No execution found" → the parent hangs). Two
// guards close it: (a) a child-start gate on the parent reading durably-as-suspended
// (`waitParentDurable`) and (b) a bounded resume retry (`resumeParent`). The parallel path
// multiplies the exposure (N instant children racing ONE suspend); the gate is per-suspend
// so one wait covers the whole group, and `childDurabilityRace.test.ts` exercises both.
//
// No new event type: CHILD_DONE is a resume SIGNAL name (like TIMER_FIRED delivery),
// and the spec rides in the DECISION_RECORDED the supervisor already sees via onEvent.

/** The resume signal a completed child delivers to its waiting parent. */
export const CHILD_DONE = "CHILD_DONE";

/**
 * The settled outcome of one child, as returned (positionally) by `awaitChildren`.
 * A group is wait-all: every member settles into one of these before the parent
 * resumes, so a partial failure is DATA the parent inspects — not an exception and
 * not a hang. (`awaitChild`, awaiting a single result, instead THROWS `childFailed`
 * on a non-`completed` outcome.)
 */
export type ChildResult<TOut = unknown> =
  | { status: "completed"; output: TOut }
  | { status: "failed"; error: string }
  | { status: "cancelled"; reason?: string };

/** The typed-failure channel `awaitChild` throws on when its child fails or is cancelled. */
export const CHILD_FAILED = "childFailed";

const SEP = "::";

/** Deterministic child execution id — `<parentId>::<key>` (stable across replay). */
export function childIdFor(parentId: string, key: string): string {
  // The key must not contain the separator, or `parentOf` (which peels the LAST
  // separator) would resolve the wrong parent and a child completion could resume a
  // different execution. (parentId itself MAY contain the separator — that is exactly
  // how nested children work: parentOf yields the immediate parent.)
  if (key.includes(SEP)) {
    throw new Error(`orchestration: child key must not contain "${SEP}" (got "${key}")`);
  }
  return `${parentId}${SEP}${key}`;
}

/** The parent id embedded in a child id, or undefined if it is not a child id. */
export function parentOf(childId: string): string | undefined {
  const i = childId.lastIndexOf(SEP);
  return i < 0 ? undefined : childId.slice(0, i);
}

/**
 * Orchestration depth of an execution id: 0 for a root, +1 per `::` nesting
 * level. Derived purely from the deterministic child-id scheme, so the depth
 * guard replays identically.
 */
export function depthOf(executionId: string): number {
  let depth = 0;
  for (let i = executionId.indexOf(SEP); i >= 0; i = executionId.indexOf(SEP, i + SEP.length)) {
    depth++;
  }
  return depth;
}

/**
 * R9 — the autonomy envelope for child spawning. Both bounds are OFF when unset (today's
 * behaviour); `@loom/app`'s strict profile sets them. A spawn is the one place a runaway
 * agent multiplies itself, so the caps are enforced at BOTH ends:
 *   - parent side ({@link boundOrchestration}), before anything durable happens, so the
 *     calling flow fails loudly at the call site; and
 *   - supervisor side ({@link SupervisorDeps.limits}), the backstop for a parent that does not
 *     use the bound helpers or passes its own larger `maxDepth`: the child is NEVER started
 *     and the parent is resumed with a failed child, so it does not hang.
 */
export interface SpawnLimits {
  /** Deepest allowed child (root = 0, its child = 1, …). A child deeper than this is refused. */
  maxDepth?: number;
  /** Most children one `awaitChildren`/`awaitAll` group may start. */
  maxFanOut?: number;
}

/**
 * A spawn was refused by the autonomy envelope. The control plane speaking, not a bad draft:
 * non-retryable (`retryable = false`), and recognisable by `name` for classifiers that cannot
 * import this package (loom-ui's `isControlPlaneError`).
 */
export class SpawnLimitExceededError extends Error {
  readonly limit: "maxDepth" | "maxFanOut";
  readonly max: number;
  readonly actual: number;
  readonly retryable = false;
  constructor(limit: "maxDepth" | "maxFanOut", max: number, actual: number, where: string) {
    super(
      `Spawn limit exceeded: ${limit} ${max} (requested ${actual}) for "${where}" — the autonomy envelope refuses this spawn`
    );
    this.name = "SpawnLimitExceededError";
    this.limit = limit;
    this.max = max;
    this.actual = actual;
  }
}

/** The first limit a spawn of `fanOut` children at `childDepth` breaks, or undefined. */
function limitBreach(
  limits: SpawnLimits | undefined,
  childDepth: number,
  fanOut: number,
  where: string
): SpawnLimitExceededError | undefined {
  if (limits?.maxDepth !== undefined && childDepth > limits.maxDepth) {
    return new SpawnLimitExceededError("maxDepth", limits.maxDepth, childDepth, where);
  }
  if (limits?.maxFanOut !== undefined && fanOut > limits.maxFanOut) {
    return new SpawnLimitExceededError("maxFanOut", limits.maxFanOut, fanOut, where);
  }
  return undefined;
}

/**
 * Marker + spec recorded by `awaitChild` and read by the supervisor.
 *
 * `grants` is the capability SUBSET the parent confers on this child (K12.4). It is
 * a list of effect ids — not a token, not a secret, not an identity — because it is
 * written to an append-only log that is archived and retained. The signed
 * `DelegatedGrant` is minted from it at start time and never persisted; see
 * {@link SupervisorDeps.delegation}.
 */
interface SpawnChoice {
  __orchestration: true;
  childId: string;
  flowId: string;
  input: unknown;
  grants?: readonly string[];
  /** Absolute epoch-ms expiry for the minted token. Absolute, so a re-mint on recovery is identical. */
  expiresAt?: number;
  /** ADR 0112 D5 — opts out of the cancel cascade: this child outlives a cancelled parent. */
  detached?: boolean;
}

function asSpawnChoice(value: unknown): SpawnChoice | undefined {
  const c = value as Partial<SpawnChoice> | null;
  return c !== null &&
    c.__orchestration === true &&
    typeof c.childId === "string" &&
    typeof c.flowId === "string"
    ? (c as SpawnChoice)
    : undefined;
}

/** One member of a parallel spawn — a child to start under the shared group id. */
interface GroupMember {
  childId: string;
  flowId: string;
  input: unknown;
  /** The capability subset conferred on THIS member (see {@link SpawnChoice.grants}). */
  grants?: readonly string[];
  expiresAt?: number;
  /** ADR 0112 D5 — see {@link SpawnChoice.detached}. */
  detached?: boolean;
}

/**
 * Marker + spec recorded by `awaitChildren` and read by the supervisor. The whole
 * group rides in ONE `DECISION_RECORDED` (one decision fixes every child id + spec),
 * so the fan-out is replay-deterministic and a recovery re-run re-derives the exact
 * same members instead of spawning a second set.
 */
interface GroupSpawnChoice {
  __orchestrationGroup: true;
  /** The parent's suspend correlationKey — also the group's identity. */
  groupId: string;
  members: GroupMember[];
}

function asGroupChoice(value: unknown): GroupSpawnChoice | undefined {
  const c = value as Partial<GroupSpawnChoice> | null;
  return c !== null &&
    c.__orchestrationGroup === true &&
    typeof c.groupId === "string" &&
    Array.isArray(c.members)
    ? (c as GroupSpawnChoice)
    : undefined;
}

/**
 * From inside a parent flow: spawn `flowId(input)` as a child execution and suspend
 * until it completes, returning its output. Replay-safe — the spawn is fixed by
 * `ctx.decide`, so a resume/recovery re-run never starts a second child.
 *
 * If the child FAILS or is CANCELLED, this throws a typed `childFailed` failure
 * (ADR 0060) carrying `{ childId, status, error?/reason? }`, so the parent can
 * `try/catch` and settle (e.g. spawn a fallback) or let it propagate — an uncaught
 * throw fails the parent, which, if the parent is itself a child, propagates the
 * failure one level up through the very same mechanism. (`awaitChildren` does NOT
 * throw per-child — it returns each member's settled `ChildResult` for the parent
 * to weigh.)
 *
 * `maxDepth` (ADR 0061 D5) bounds recursive re-entry — a self-invoking flow
 * (e.g. a drift-repair loop re-entering its interpreter) must not recurse
 * unboundedly on persistent failure. Exceeding it throws a typed
 * `depthExceeded` failure (ADR 0060) BEFORE anything durable happens, so the
 * calling flow can catch it and settle; uncaught, the run fails loudly.
 */
export async function awaitChild<TOut = unknown>(
  ctx: Pick<ExecutionContext, "executionId" | "decide" | "suspend">,
  spec: {
    key: string;
    flowId: string;
    input: unknown;
    maxDepth?: number;
    /**
     * K12.4 — the capability subset this child may use. Recorded (as plain effect
     * ids) and turned into a signed, holder-bound `DelegatedGrant` by a supervisor
     * wired with `delegation`. Omit for today's behaviour: no token, and the child
     * is authorized by its own flow's grants alone.
     */
    grants?: readonly string[];
    /** Absolute epoch-ms expiry for the conferred authority. Absolute so a re-mint on recovery is identical. */
    expiresAt?: number;
    /**
     * ADR 0112 D5 — opt out of the cancel cascade. By default cancelling this execution cancels
     * the child it is awaiting; a `detached` child is work that must outlive its parent.
     */
    detached?: boolean;
  }
): Promise<TOut> {
  const childId = childIdFor(ctx.executionId, spec.key);
  if (spec.maxDepth !== undefined) {
    const depth = depthOf(childId);
    if (depth > spec.maxDepth) {
      fail("depthExceeded", { childId, depth, maxDepth: spec.maxDepth });
    }
  }
  await ctx.decide(`orchestration:spawn:${spec.key}`, () => ({
    __orchestration: true as const,
    childId,
    flowId: spec.flowId,
    input: spec.input,
    ...(spec.grants !== undefined && { grants: spec.grants }),
    ...(spec.expiresAt !== undefined && { expiresAt: spec.expiresAt }),
    ...(spec.detached === true && { detached: true }),
  }));
  // R8 round 1 — `viewDigest` binds the park to ITS child: a supervisor's resume must echo it, so
  // a stale/duplicate resume (a slow supervisor that read the park earlier) is refused by the
  // runtime BEFORE the append instead of answering the parent's NEXT `awaitChild`.
  const resumed = (await ctx.suspend({
    on: CHILD_DONE,
    correlationKey: childId,
    viewDigest: childId,
  })) as unknown as {
    output?: TOut;
    __childFailed?: Exclude<ChildResult, { status: "completed" }>;
  };
  if (resumed.__childFailed !== undefined) {
    // Replay-deterministic: the failure rides the recorded resume payload, so a parent
    // recovery re-run re-throws it at the same point and re-takes the same catch branch.
    fail(CHILD_FAILED, { childId, ...resumed.__childFailed });
  }
  return resumed.output as TOut;
}

/**
 * From inside a parent flow: spawn every `children[i]` as a child execution CONCURRENTLY
 * and suspend until they ALL settle, returning each member's `ChildResult` positionally
 * aligned with `children` (NOT completion order). Wait-all, allSettled-style: a member
 * that fails or is cancelled becomes a `{ status: "failed" | "cancelled", … }` entry
 * rather than throwing — the parent inspects the array and decides what a partial failure
 * means (retry, fall back, or fail loudly). Still ONE suspend/resume cycle per parent —
 * the supervisor starts the whole group, collects each settled result, and resumes once
 * with the array — so it rides the single `_resumePayload` slot exactly like `awaitChild`.
 *
 * Replay-safe by the same mechanism: a SINGLE `ctx.decide` fixes the entire group
 * (every child id + spec), so a resume/recovery re-run never starts a second fan-out.
 * Child ids are `<parentId>::<group.key>#<i>` — one nesting level deeper than the parent,
 * so `maxDepth` (checked once; all members share the parent's depth + 1) bounds recursion
 * identically to the single-child path. Deterministic ids mean `group.key` and each item's
 * position, not wall-clock, decide identity — so the fan-out is crash-recoverable frame by
 * frame. An empty `children` resolves to `[]` without suspending (no members to await).
 */
export async function awaitChildren<TOut = unknown>(
  ctx: Pick<ExecutionContext, "executionId" | "decide" | "suspend">,
  group: {
    key: string;
    /** `grants`/`expiresAt` are PER MEMBER (K12.4) — a fan-out over heterogeneous children
     *  rarely wants one subset for all of them, and a shared default would be the wrong one. */
    children: readonly {
      flowId: string;
      input: unknown;
      grants?: readonly string[];
      expiresAt?: number;
      /** ADR 0112 D5 — this member outlives a cancelled parent (see `awaitChild`). */
      detached?: boolean;
    }[];
    maxDepth?: number;
  }
): Promise<ChildResult<TOut>[]> {
  if (group.children.length === 0) return [];
  const groupId = childIdFor(ctx.executionId, group.key);
  const members: GroupMember[] = group.children.map((c, i) => ({
    // `#<i>` shares the child-id namespace with `awaitChild` keys; a group `key` must be
    // distinct from any sibling single-child key in the same parent (childIdFor already
    // forbids the `::` separator in the key, which is what protects `parentOf`).
    childId: childIdFor(ctx.executionId, `${group.key}#${i}`),
    flowId: c.flowId,
    input: c.input,
    ...(c.grants !== undefined && { grants: c.grants }),
    ...(c.expiresAt !== undefined && { expiresAt: c.expiresAt }),
    ...(c.detached === true && { detached: true }),
  }));
  if (group.maxDepth !== undefined) {
    const depth = depthOf(members[0]!.childId);
    if (depth > group.maxDepth) {
      fail("depthExceeded", { groupId, depth, maxDepth: group.maxDepth });
    }
  }
  await ctx.decide(`orchestration:spawn-group:${group.key}`, () => ({
    __orchestrationGroup: true as const,
    groupId,
    members,
  }));
  const resumed = (await ctx.suspend({
    on: CHILD_DONE,
    correlationKey: groupId,
    viewDigest: groupId, // see `awaitChild`: the park is bound to this group.
  })) as unknown as {
    settled: ChildResult<TOut>[];
  };
  return resumed.settled;
}

/**
 * `awaitChildren` for the all-or-nothing happy path: fan out, wait for all, and return
 * the outputs UNWRAPPED and positionally aligned with `children` — but if ANY member
 * failed or was cancelled, throw the same typed `childFailed` failure `awaitChild` throws
 * (carrying the FIRST failure, by input index: `{ childId, index, status, error?/reason? }`).
 * So a parent that only wants "all N succeed, give me the values" gets `Promise.all`
 * ergonomics without hand-unwrapping every `ChildResult`; a parent that must weigh partial
 * failure uses `awaitChildren` directly.
 *
 * A thin userspace wrapper — same one suspend/resume cycle, same replay-safety (it awaits
 * `awaitChildren`, then the throw rides the recorded resume payload). Note it still WAITS
 * for every member before throwing (wait-all, not early-abort); it does not cancel the
 * siblings of a failed member.
 */
export async function awaitAll<TOut = unknown>(
  ctx: Pick<ExecutionContext, "executionId" | "decide" | "suspend">,
  group: {
    key: string;
    children: readonly { flowId: string; input: unknown }[];
    maxDepth?: number;
  }
): Promise<TOut[]> {
  const settled = await awaitChildren<TOut>(ctx, group);
  const failedIndex = settled.findIndex((r) => r.status !== "completed");
  if (failedIndex >= 0) {
    const first = settled[failedIndex] as Exclude<ChildResult<TOut>, { status: "completed" }>;
    fail(CHILD_FAILED, {
      childId: childIdFor(ctx.executionId, `${group.key}#${failedIndex}`),
      index: failedIndex,
      ...first,
    });
  }
  return settled.map((r) => (r as { status: "completed"; output: TOut }).output);
}

type SpawnCtx = Pick<ExecutionContext, "executionId" | "decide" | "suspend">;

/**
 * `awaitChild` / `awaitChildren` / `awaitAll` with the envelope applied as the DEFAULT:
 * a spawn that breaks `limits` throws {@link SpawnLimitExceededError} before the spawn
 * decision is recorded, so no child is started and nothing durable is appended. A call's own
 * `maxDepth` still applies on top (its `depthExceeded` typed failure is unchanged); the
 * envelope can only tighten, never loosen, because the supervisor re-checks the same limits.
 */
export function boundOrchestration(limits: SpawnLimits): {
  awaitChild: typeof awaitChild;
  awaitChildren: typeof awaitChildren;
  awaitAll: typeof awaitAll;
} {
  return {
    awaitChild: (ctx: SpawnCtx, spec) => {
      const breach = limitBreach(
        limits,
        depthOf(childIdFor(ctx.executionId, spec.key)),
        1,
        spec.key
      );
      if (breach !== undefined) return Promise.reject(breach);
      return awaitChild(ctx, spec);
    },
    awaitChildren: (ctx: SpawnCtx, group) => {
      const breach =
        group.children.length === 0
          ? undefined
          : limitBreach(
              limits,
              depthOf(childIdFor(ctx.executionId, `${group.key}#0`)),
              group.children.length,
              group.key
            );
      if (breach !== undefined) return Promise.reject(breach);
      return awaitChildren(ctx, group);
    },
    awaitAll: (ctx: SpawnCtx, group) => {
      const breach =
        group.children.length === 0
          ? undefined
          : limitBreach(
              limits,
              depthOf(childIdFor(ctx.executionId, `${group.key}#0`)),
              group.children.length,
              group.key
            );
      if (breach !== undefined) return Promise.reject(breach);
      return awaitAll(ctx, group);
    },
  } as {
    awaitChild: typeof awaitChild;
    awaitChildren: typeof awaitChildren;
    awaitAll: typeof awaitAll;
  };
}

export interface SupervisorDeps {
  runtime: WorkflowRuntime;
  /** Child flows by id, so the supervisor can start them by the recorded flowId. */
  flows: Record<string, RegisteredFlow>;
  /** Fired on a supervision failure (start/resume rejection). */
  onError?: (err: unknown) => void;
  /**
   * K12.4 — mint an attenuated `DelegatedGrant` for children whose spawn conferred
   * a `grants` subset, and start them holding it (`principal.actor = childId`, which
   * is what `DelegationAuthorizer`'s holder-binding check requires).
   *
   * The MINT happens here, not at the spawn decision, so the signed token never
   * enters the log: an append-only, archived, retained log is the wrong place for a
   * bearer credential, and one written there cannot be rotated out of the copies.
   * The log carries the SUBSET (plain effect ids), which is a description of
   * authority rather than a means of exercising it — and a re-mint after recovery is
   * identical, because both inputs (subset, child id) come from the log.
   *
   * Unset ⇒ no token is ever minted and every child starts exactly as before (G2).
   */
  delegation?: { secret: string };
  /**
   * R9 — the autonomy envelope's spawn bounds, enforced where a child is actually started so a
   * parent cannot bypass them by not using {@link boundOrchestration}. A refused spawn starts
   * NO child, reports a {@link SpawnLimitExceededError} through `onError`, and resumes the
   * parent with a failed child (so `awaitChild` throws `childFailed`, `awaitChildren` returns
   * failed entries) — it never leaves the parent suspended forever. Unset ⇒ no bound (G2).
   */
  limits?: SpawnLimits;
  /**
   * ADR 0118 D4 — the LIVE re-driver for a contended resume. When a resume of a parked parent
   * exhausts its conditional-fence attempts ({@link ResumeContendedError}), the supervisor writes a
   * backed-off, due-later row to `timers` and returns; `service` (the `TimerService` polling that
   * same store) fires it through the re-driver registered here, which re-derives the resume from
   * the log (`adopt`). Completion then no longer depends on an app calling `recover()`.
   *
   * Pass `app.redrive` from `defineConfig({ kernel: { features: { redrive: true } } })`, which sets
   * this up only when the flag is on — redrive rows are NOT safe on a fleet that still has a node
   * whose `TimerService` retires them as obsolete. Unset ⇒ a contended resume goes to `onError`
   * and `recover()` re-drives it (today's behaviour).
   */
  redrive?: RedriveWiring;
  /** @internal Timing knobs (milliseconds / counts). Defaults are production values; tests shrink them. */
  tuning?: Partial<SupervisorTuning>;
}

/** What {@link SupervisorDeps.redrive} needs: where the row goes, and who fires it. */
export interface RedriveWiring {
  /** The `TimerStore` the `service` polls. */
  timers: TimerStore;
  /** The `TimerService` that fires re-drive rows; the supervisor registers its re-driver on it. */
  service: { registerRedriver(redriver: Redriver): () => void };
  /** Backoff of the FIRST row (the service uses its own `redriveBackoff` for later ones). */
  backoff?: RedriveBackoff;
}

/** @internal */
export interface SupervisorTuning {
  /** How long a live child start waits for the parent's park to become durable before backing off to `adopt`. */
  durableWaitMs: number;
  /** First delay of the exponential `adopt` backoff after that wait ran out. */
  retryBaseMs: number;
  /** Cap of one backoff delay. */
  retryMaxMs: number;
  /** After this long without the park becoming durable, report a give-up through `onError`. */
  giveUpMs: number;
  /** A park that stays durably on a DIFFERENT key this long is a losing resume's phantom: stop quietly. */
  phantomMs: number;
  /** Period of the sweep that drops state held for parks answered elsewhere. */
  sweepMs: number;
  /** An observed resume with no durable evidence after this long is "unknown" (retried via adopt). */
  observeMs: number;
  /** One state read taking longer than this counts as "unknown". */
  loadTimeoutMs: number;
  /** Bound on the retention-deletion facts held in memory (a miss past an eviction rescans the stream). */
  maxReclaimed: number;
}

/** What one {@link ChildSupervisor.recover} pass found and did. */
export interface RecoverSummary {
  /** Executions enumerated (each costs one fold — see `recover`). */
  scanned: number;
  /** Parents found parked on a `CHILD_DONE` gate. */
  parked: number;
  /** Parents resumed because every child they awaited had already settled. */
  resumed: number;
  /** Children (or group members) started because the log held a spawn but no child. */
  started: number;
  /** ADR 0112 D5 — orphans of a cancelled parent this pass cancelled (non-detached, non-terminal). */
  cascaded: number;
}

export interface ChildSupervisor {
  /** Wire this into `WorkflowRuntimeDeps.onEvent` (it sees every execution's events). */
  onEvent(event: EventEnvelope): void;
  /**
   * R8 — boot catch-up. Enumerate the store, find every execution parked on a `CHILD_DONE`
   * gate, rebuild its spawn spec / group from the log, and: resume it if every child it awaits
   * already settled, start any child the log recorded but nobody started, and otherwise adopt
   * it (a child still running here will complete into the supervisor as usual).
   *
   * Call it once after wiring `onEvent`, and again whenever you like as a sweeper: it is
   * idempotent and safe to run from several supervisors at once (see `superviseChildren`).
   *
   * COST: one `listExecutionsPage` scan of the store plus ONE FOLD per execution (O(store));
   * memory stays O(page) — nothing is retained for executions that are not parked on children.
   * SCOPE: it scans whatever the store enumerates — across TENANTS unless the store is tenant-
   * scoped (use a tenant-scoped store, or pass `source`, to confine a pass). Children whose result
   * was compacted away settle with the fold's outcome but not the error text / cancel reason.
   * Without `listExecutionsPage`/`listExecutions` on the store it throws (nothing to enumerate);
   * the lazy per-event adoption in `onEvent` still works without it. Pass `source` to scan a
   * narrower enumeration (e.g. a candidate list from your own index).
   */
  recover(options?: { source?: ExecutionEnumerable; pageSize?: number }): Promise<RecoverSummary>;
  /**
   * ADR 0118 D3 — is `executionId` a supervised child whose PARENT is non-terminal and durably
   * parked on it (its own `CHILD_DONE` key, or a group that names it)? The parent edge is the
   * child's own recorded `parent` (`EXECUTION_STARTED.parent`, written only through the runtime's
   * lineage grant, so a caller cannot forge it); for a child recorded before R3k, from this
   * supervisor's rebuilt state. Costs two folds and a read of the parent's log; the backing of
   * {@link pinParkedChildren}. A crypto-shredded log answers `false`; any other read failure rejects
   * (the retention run fails and the log is kept).
   */
  parkedOnChild(executionId: string): Promise<boolean>;
  /** @internal Sizes of the supervisor's in-memory maps (a leak check; not a stable API). */
  size(): { specs: number; started: number; groups: number; memberOf: number; reclaimed: number };
}

/**
 * Start options for a child: its fixed execution id, plus — when the spawn conferred a
 * subset AND the supervisor holds the delegation secret — a freshly minted, holder-bound
 * `DelegatedGrant`. `actor` is the child's own execution id, which is what
 * `DelegationAuthorizer` compares against `token.issuedTo` so a captured token cannot be
 * presented by anyone else.
 */
function childStartOptions(
  childId: string,
  spec: { grants?: readonly string[]; expiresAt?: number },
  delegation: { secret: string } | undefined,
  system: { system?: SystemGrant; lineage?: LineageGrant },
  parentExecutionId: string | undefined
): {
  executionId: string;
  principal?: PrincipalChain;
  system?: SystemGrant;
  lineage?: LineageGrant;
  parentExecutionId?: string;
} {
  // R3 — a child start is the supervisor acting, so it presents the system grant (bypasses the
  // execution authorizer only); the delegation principal, when any, still reaches its effects.
  // `parentExecutionId` lets an owner-tracking execution policy give the child its parent's owner.
  const parent = parentExecutionId !== undefined ? { parentExecutionId } : {};
  if (delegation === undefined || spec.grants === undefined) {
    return { executionId: childId, ...system, ...parent };
  }
  const token = signDelegation(delegation.secret, childId, [...spec.grants], spec.expiresAt);
  return {
    executionId: childId,
    principal: { actor: childId, delegation: token },
    ...system,
    ...parent,
  };
}

// ── R3k (ADR 0111 D3/D4) — a supervised child's attenuation survives a crash ───────────────
//
// `childStartOptions` hands the child `{ actor: childId, delegation: token }`. The kernel records
// the principal on the child's `EXECUTION_STARTED` but NEVER the token (a bearer credential in a
// permanent log). Without a restorer, a recovered child would lose the token and fall through to
// the callee's `base` authority: a privilege escalation across a crash. This codec is the
// restorer. Its `ref` is the SUBSET the spawn conferred — plain effect ids, the same description
// the parent's spawn decision already journals — plus the holder and expiry; `fromRef` re-signs
// it with the delegation secret the supervisor holds, so a recovered child gets the SAME
// attenuation back (not a fresh or broader one). The secret never enters the log.

// v2 = MACed. The ref is the only thing the log holds to re-mint a child's attenuation from; were it
// forgeable, anyone able to write a sequence-0 (a caller-chosen id, a restored backup) could
// confer any grant set. The MAC key is DERIVED from the supervisor secret under a distinct label,
// so a ref MAC is never a valid delegation signature (nor the reverse). Unsigned v1 refs never
// shipped (R3k is unreleased) and are refused.
const ORCH_REF_PREFIX = "loom:orch:v2:";
const ORCH_REF_MAC_LABEL = "loom:orch:ref:v1|";
const orchRefKey = (secret: string): Buffer =>
  createHmac("sha256", secret).update("loom:orch:ref-key:v1").digest();
const orchRefMac = (key: Buffer, bodyB64: string): Buffer =>
  createHmac("sha256", key)
    .update(ORCH_REF_MAC_LABEL + bodyB64)
    .digest();
/** A ref longer than this is not produced: the delegation is then unrestorable and the start is refused. */
const ORCH_REF_MAX = 8192;

/**
 * The {@link PrincipalCodec} for supervised children. `superviseChildren` composes it onto its
 * runtime when `delegation` is configured; exported for apps that hand-build a runtime.
 */
export function orchestrationPrincipalCodec(secret: string): PrincipalCodec {
  const key = orchRefKey(secret);
  return {
    toRef(chain) {
      const token = chain.delegation;
      // Only the supervisor's own shape: a holder-bound token on its own actor, no human identity
      // fields (a ref must stay non-identifying). A token that does not verify is NEVER re-signed
      // into a valid one, so it falls through to the default record and is refused (D4).
      if (token === undefined || token === null) return undefined;
      if (typeof chain.actor !== "string" || chain.actor !== token.issuedTo) return undefined;
      if (chain.tenant !== undefined || chain.onBehalfOf !== undefined) return undefined;
      if (!verifyDelegation(secret, token)) return undefined;
      const body = JSON.stringify({
        a: token.issuedTo,
        g: [...token.grants].sort(),
        ...(token.exp !== undefined && { e: token.exp }),
      });
      const bodyB64 = Buffer.from(body, "utf8").toString("base64url");
      const ref = `${ORCH_REF_PREFIX}${bodyB64}.${orchRefMac(key, bodyB64).toString("base64url")}`;
      return ref.length <= ORCH_REF_MAX ? ref : undefined;
    },
    fromRef(ref) {
      if (!ref.startsWith(ORCH_REF_PREFIX)) return undefined; // not ours: another codec's ref
      try {
        const [bodyB64, macB64, ...extra] = ref.slice(ORCH_REF_PREFIX.length).split(".");
        if (bodyB64 === undefined || macB64 === undefined || extra.length > 0) return undefined;
        const given = Buffer.from(macB64, "base64url");
        const want = orchRefMac(key, bodyB64);
        // Verify BEFORE anything is re-signed: a forged ref must never become a valid token.
        if (given.length !== want.length || !timingSafeEqual(given, want)) return undefined;
        const body = JSON.parse(Buffer.from(bodyB64, "base64url").toString("utf8")) as {
          a?: unknown;
          g?: unknown;
          e?: unknown;
        };
        if (
          typeof body.a !== "string" ||
          !Array.isArray(body.g) ||
          !body.g.every((g) => typeof g === "string") ||
          (body.e !== undefined && typeof body.e !== "number")
        ) {
          return undefined;
        }
        return {
          actor: body.a,
          delegation: signDelegation(
            secret,
            body.a,
            body.g as string[],
            body.e as number | undefined
          ),
        };
      } catch {
        return undefined;
      }
    },
  };
}

/** The error a store raised, unwrapped from the `StorageWriteError` the journal puts around it. */
function rootCause(err: unknown): unknown {
  const cause = (err as { name?: unknown; cause?: unknown } | null)?.cause;
  return (err as { name?: unknown } | null)?.name === "StorageWriteError" && cause !== undefined
    ? cause
    : err;
}

const errName = (err: unknown): unknown => (err as { name?: unknown } | null)?.name;

/** A write the store refused because another writer's append took the slot first. */
function isLostRace(err: unknown): boolean {
  const name = errName(rootCause(err));
  return name === "DuplicateSequenceError" || name === "DuplicateEnvelopeIdError";
}

/** A fencing store refused the write: the execution is fenced and this writer holds no (or an old) token. */
function isStaleFence(err: unknown): boolean {
  return errName(rootCause(err)) === "StaleFenceError";
}

/** The lifecycle stream retention journals its `EXECUTION_DELETED` facts to (see `LogLifecycle`). */
const LIFECYCLE_STREAM = "__loom_lifecycle__";

/**
 * ADR 0118 D3 — a retention pin predicate (`retention.pinned`, ADR 0055): a finished child whose
 * parent is still parked on it is "pinned", so `LogLifecycle.applyRetention` cannot delete the log
 * the parent's later `awaitChild` is about to read. It is archivable again once the parent is
 * answered or terminal. Pass a function when the supervisor is created AFTER the config (it needs
 * the config's runtime): the predicate is only consulted at retention time.
 *
 * Compose with an existing predicate by `||`-ing them; `LogLifecycle` consults it only for
 * executions that are otherwise retention-eligible.
 */
export function pinParkedChildren(
  supervisor:
    | Pick<ChildSupervisor, "parkedOnChild">
    | (() => Pick<ChildSupervisor, "parkedOnChild"> | undefined)
): PinPredicate {
  return async (executionId) => {
    const s = typeof supervisor === "function" ? supervisor() : supervisor;
    return s === undefined ? false : s.parkedOnChild(executionId);
  };
}

/**
 * The supervisor that turns spawn intents into running children and their completions
 * into parent resumes. Correlation is store-read-free — the spawn spec comes from the
 * parent's `DECISION_RECORDED` and the child id embeds the parent id, both observed via
 * `onEvent` — so no read is needed to know WHICH parent a child belongs to. The store IS
 * read, however, to gate on durability: `onEvent` fires at commit time, before the async
 * durable write drains, so both starting a child and resuming its parent guard against
 * the parent's suspend not yet being readable (see `resumeParent` and the child-start
 * durability gate below).
 */
export function superviseChildren(deps: SupervisorDeps): ChildSupervisor {
  // R3k (ADR 0111 D4 rule 3) — with a delegation secret the supervisor mints narrowed tokens, so
  // it also composes the codec that restores them after a crash; the supported path needs no
  // configuration, and a runtime that cannot restore a delegation refuses the start instead.
  if (deps.delegation !== undefined) {
    deps.runtime.composePrincipalCodec(orchestrationPrincipalCodec(deps.delegation.secret));
  }
  // childId → spec, learned from DECISION_RECORDED before the parent's suspend lands.
  const specs = new Map<
    string,
    {
      flowId: string;
      input: unknown;
      grants?: readonly string[];
      expiresAt?: number;
      detached?: boolean;
    }
  >();
  // childIds (and groupIds) already started this process (idempotency within the runtime).
  const started = new Set<string>();
  // groupId → live aggregation for a parallel spawn: its members, their SETTLED results
  // collected positionally, and the count still outstanding. Learned from the group
  // DECISION_RECORDED. Wait-all: every member (success OR failure) fills its slot.
  const groups = new Map<
    string,
    {
      parentId: string;
      members: GroupMember[];
      results: ChildResult[];
      remaining: number;
      spawnedAt: number;
    }
  >();
  // member childId → (groupId, index), so a member's terminal event lands in the right slot.
  const memberOf = new Map<string, { groupId: string; index: number }>();
  // ADR 0109 D6 — a CONTINUED child is never a result: "look at the head". Successor id → the child id
  // the parent's park names. A terminal event of the successor settles the ORIGINAL child's slot (or
  // resumes the parent on its id), so a supervised child may rotate any number of times.
  const followed = new Map<string, string>();

  const fail = (err: unknown): void => deps.onError?.(err);
  // Fire-and-forget work (child starts, refusals) that `recover` awaits before it reports.
  const inflight = new Set<Promise<void>>();
  const track = (p: Promise<void>): void => {
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  };
  let resumedTotal = 0;
  let startedTotal = 0;

  // The settled outcome of a child, derived from its terminal event. Completions carry an
  // `output`; failures/cancels flatten to the string the kernel records (EXECUTION_FAILED
  // → `{ error }`, EXECUTION_CANCELLED → `{ reason }`).
  const settle = (event: EventEnvelope): ChildResult => {
    if (event.eventType === "EXECUTION_COMPLETED") {
      return { status: "completed", output: (event.payload as { output?: unknown }).output };
    }
    if (event.eventType === "EXECUTION_CANCELLED") {
      const reason = (event.payload as { reason?: unknown }).reason;
      return { status: "cancelled", ...(reason !== undefined && { reason: String(reason) }) };
    }
    return { status: "failed", error: String((event.payload as { error?: unknown }).error) };
  };

  // Is the parent durably parked on exactly this child/group?
  const parkedOn = (
    st: Awaited<ReturnType<WorkflowRuntime["loadState"]>> | null | undefined,
    key: string
  ): boolean =>
    st?.status === "suspended" &&
    st.suspendedOn?.on === CHILD_DONE &&
    st.suspendedOn.correlationKey === key;

  const tune: SupervisorTuning = {
    durableWaitMs: 1000,
    retryBaseMs: 250,
    retryMaxMs: 5000,
    giveUpMs: 600_000,
    phantomMs: 30_000,
    sweepMs: 30_000,
    observeMs: 60_000,
    loadTimeoutMs: 5000,
    maxReclaimed: 50_000,
    ...deps.tuning,
  };
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  // A background timer must never keep the process alive.
  const sleepUnref = (ms: number): Promise<void> =>
    new Promise((r) => {
      (setTimeout(r, ms) as { unref?: () => void }).unref?.();
    });
  // A store read that hangs reads as "unknown" (undefined), never as an answer.
  const loadParent = (id: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<undefined>((r) => {
      timer = setTimeout(() => r(undefined), tune.loadTimeoutMs);
    });
    return Promise.race([
      deps.runtime.loadState(id, deps.runtime.systemOptions()).catch(() => undefined),
      limit,
    ]).finally(() => clearTimeout(timer));
  };

  // Drop everything the supervisor holds for one park: the parent moved on (resumed here or by
  // another supervisor), so nothing about this key is live any more. Bounds the in-memory maps.
  const forget = (key: string): void => {
    started.delete(key);
    specs.delete(key);
    const g = groups.get(key);
    if (followed.size > 0) {
      const ids = new Set<string>([key, ...(g?.members.map((m) => m.childId) ?? [])]);
      for (const [successor, original] of followed)
        if (ids.has(original)) followed.delete(successor);
    }
    if (g !== undefined) {
      for (const m of g.members) {
        memberOf.delete(m.childId);
        started.delete(m.childId);
      }
      groups.delete(key);
    }
  };

  // Wait until the parent is DURABLY parked on `key` before touching it. onEvent fires
  // synchronously at commit time (ExecutionJournal.commit), BEFORE the async durable write
  // drains — so a fast/instant child could otherwise complete and trigger a resume that re-reads
  // a parent whose suspend has not yet landed ("No execution found" → the parent hangs).
  //
  // R8 round 1 — it must be parked on THIS key, not merely "suspended". A resume that LOST the
  // append race still ran the parent body in memory and emitted a non-durable spawn/suspend for a
  // (possibly non-deterministic) key the log never recorded; the winner's park made the parent
  // read `suspended`, and a status-only check started an orphan child for it. Starts a child
  // only on `parked`; `gone` (terminated) starts nothing, and `timeout` (the ~1s deadline ran
  // out) hands the park to `scheduleAdopt`, which re-derives it from the log with backoff.
  // `loadState` and `resume` read the SAME event store, so `parked` guarantees a later resume
  // finds the parent.
  // Three outcomes — and only one of them is a give-up:
  //   "parked"  the parent is durably parked on `key`: go ahead.
  //   "gone"    the parent terminated: nothing will ever park on `key`.
  //   "timeout" the bound ran out with the park still not visible. That is NOT "never parked": a slow
  //             store (or a long tail on the append queue) shows the park late. The caller backs off
  //             and `adopt`s (see `scheduleAdopt`) rather than abandoning a parent that hangs forever.
  const waitParentDurable = async (
    parentId: string | undefined,
    key: string
  ): Promise<"parked" | "gone" | "timeout"> => {
    if (parentId === undefined) return "parked";
    const deadline = Date.now() + tune.durableWaitMs;
    for (;;) {
      const s = await loadParent(parentId);
      if (parkedOn(s, key)) return "parked";
      if (
        s?.status === "completed" ||
        s?.status === "failed" ||
        s?.status === "cancelled" ||
        s?.status === "continued" // ADR 0109: the CHILD_DONE park belonged to the predecessor
      ) {
        return "gone";
      }
      if (Date.now() >= deadline) return "timeout";
      await sleep(5);
    }
  };

  // Has the parent's DURABLE log both parked on `key` and moved past it? (A parent that is already
  // running its next step reads `running`, which says nothing about WHICH park was answered.)
  const answeredDurably = async (parentId: string, key: string): Promise<boolean> => {
    let parked = false;
    try {
      for (const e of await deps.runtime.events.read(parentId)) {
        if (e.eventType === "EXECUTION_SUSPENDED") {
          const c = (e.payload as { condition?: { correlationKey?: string } }).condition;
          parked = c?.correlationKey === key;
        } else if (e.eventType === "EXECUTION_RESUMED" && parked) {
          return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  };

  // The live path gave up waiting for a durable park (slow store). Retry via `adopt` — idempotent,
  // re-derived from the log — with exponential backoff while the parent is non-terminal; only after
  // `giveUpMs` is the abandonment REPORTED (never silent). One loop per (parent, key).
  const retrying = new Set<string>();
  const scheduleAdopt = (parentId: string, key: string): void => {
    const id = `${parentId}\u0000${key}`;
    if (retrying.has(id)) return;
    retrying.add(id);
    const t0 = Date.now();
    let phantomSince: number | undefined;
    void (async () => {
      try {
        for (let n = 0; ; n++) {
          await sleepUnref(Math.min(tune.retryBaseMs * 2 ** n, tune.retryMaxMs));
          const s = await loadParent(parentId);
          if (
            s?.status === "completed" ||
            s?.status === "failed" ||
            s?.status === "cancelled" ||
            s?.status === "continued"
          ) {
            return;
          }
          if (parkedOn(s, key)) {
            await adopt(parentId);
            return;
          }
          if (s !== null && s !== undefined && (await answeredDurably(parentId, key))) return;
          if (s?.status === "suspended") {
            // durably parked somewhere else: either a losing resume's phantom key (never durable) or
            // a later park not yet visible. A phantom stays like this forever, so stop quietly.
            phantomSince ??= Date.now();
            if (Date.now() - phantomSince >= tune.phantomMs) return;
          } else {
            phantomSince = undefined;
          }
          if (Date.now() - t0 >= tune.giveUpMs) {
            fail(
              new Error(
                `orchestration: gave up supervising "${key}" of execution "${parentId}": its park never became readable within ${tune.giveUpMs}ms; run recover() to retry`
              )
            );
            return;
          }
        }
      } catch (err) {
        fail(err);
      } finally {
        retrying.delete(id);
      }
    })();
  };

  // Gate a live child start / refusal on the parent's durable park. false ⇒ do nothing now (the
  // park is dropped; a slow store is retried through `adopt` instead of being abandoned).
  const gate = async (parentId: string | undefined, key: string): Promise<boolean> => {
    const outcome = await waitParentDurable(parentId, key);
    if (outcome === "parked") return true;
    forget(key);
    if (outcome === "timeout" && parentId !== undefined) scheduleAdopt(parentId, key);
    return false;
  };

  // The spawn the parent's DURABLE log records for `key` — the authority for what to start (the
  // in-memory spec came from a non-durable event and can differ for a losing resume).
  const durableSpawn = async (
    parentId: string,
    key: string
  ): Promise<{
    single: ReturnType<typeof asSpawnChoice>;
    grp: ReturnType<typeof asGroupChoice>;
    /** When the recorded spawn decision was made (a deletion older than this is a prior incarnation's). */
    spawnedAt: number;
  }> => {
    let single: ReturnType<typeof asSpawnChoice>;
    let grp: ReturnType<typeof asGroupChoice>;
    let spawnedAt = 0;
    for (const e of await deps.runtime.events.read(parentId)) {
      if (e.eventType !== "DECISION_RECORDED") continue;
      const choice = (e.payload as { choice?: unknown }).choice;
      const one = asSpawnChoice(choice);
      if (one !== undefined && one.childId === key) {
        single = one;
        spawnedAt = e.timestamp;
      }
      const many = asGroupChoice(choice);
      if (many !== undefined && many.groupId === key) {
        grp = many;
        spawnedAt = e.timestamp;
      }
    }
    return { single, grp, spawnedAt };
  };

  // `resume()` resolves with a handle BEFORE its append is durable, so a failed append surfaces
  // only through the handle (and a flow that then fails is a settled parent, not a failed resume).
  // Resolves null once the resume took effect, or the write failure that says it did not.
  const UNKNOWN = Symbol("resume outcome unknown");
  const observeResume = async (
    handle: Awaited<ReturnType<WorkflowRuntime["resume"]>>,
    parentId: string,
    key: string | undefined
  ): Promise<unknown> => {
    const wrap = (p: Promise<unknown>): Promise<unknown> =>
      p.then(
        () => null,
        (e: unknown) =>
          isLostRace(e) || isStaleFence(e) || errName(e) === "StorageWriteError" ? e : null
      );
    const settled = Promise.race([wrap(handle.waitForSuspend()), wrap(handle.waitForCompletion())]);
    if (key === undefined) return settled;
    let done = false;
    // Durable evidence the park was answered, without waiting for the parent's whole next run
    // (which may be long). A rejected append races this, so give a failure a moment to surface.
    // BOUNDED: with no evidence within `observeMs` (a hung / unreadable store) the outcome is
    // UNKNOWN — the caller must not count it, and re-derives through `adopt` instead.
    const deadline = Date.now() + tune.observeMs;
    const changed = (async (): Promise<unknown> => {
      while (!done) {
        await sleep(5);
        if (Date.now() >= deadline) return UNKNOWN;
        const s = await loadParent(parentId);
        if (s !== null && s !== undefined && !parkedOn(s, key)) {
          return Promise.race([settled, sleep(100).then(() => null)]);
        }
      }
      return null;
    })();
    const out = await Promise.race([settled, changed]);
    done = true;
    return out;
  };

  // Resume the parent, retrying a transient failure. A completed child proves its parent
  // exists and is suspended-on-CHILD_DONE, but under an async event store (e.g. Postgres) a
  // just-written suspend can briefly not be readable when the child completes almost
  // instantly — a read-after-write visibility gap the durability gate bounds but a slower
  // store can still exceed. Without the retry the resume throws and the parent hangs forever.
  // Bounded backoff (~1s) backstops the gate; a genuinely missing parent still surfaces via
  // onError after the retries. `payload` is `{ output }` for a single child or `{ settled }`
  // for a group.
  //
  // TWO shapes of the same gap, both retriable: the parent's log may not be readable at all
  // ("No execution found"), or it may be readable but not yet folded to `suspended` — which
  // the resume ingress gate (#305) now refuses with `reason: "not-suspended"` rather than
  // resuming a still-running parent. Matching on the machine-readable reason, not the
  // message: every other refusal is permanent and retrying it would just delay a real error.
  //
  // R8 — DOUBLE-RESUME SAFETY, in two layers:
  //   • the park is BOUND to its key: `awaitChild`/`awaitChildren` suspend with
  //     `viewDigest: <key>` and this resume echoes it, so the runtime refuses (pre-append,
  //     `view-digest-mismatch`) a resume that read the park earlier and lands after the parent
  //     moved on to its NEXT `awaitChild` — no window, and the journal append is a CAS on
  //     (executionId, sequence), so a stale resume either fails the digest or loses on
  //     `DuplicateSequenceError`. Old parks (recorded without a digest) are unaffected.
  //   • the pre-check below (parked on a different key → drop) is only a fast path.
  // A refused/lost resume is "someone else answered this park": swallowed, not reported.
  //
  // FENCES — a parent that was ever fenced (TimerService, recoverAbandoned, LocalWorkerRuntime)
  // refuses an unfenced write forever with `StaleFenceError`. That is NOT a lost race: the
  // supervisor then takes a fence and retries. It resumes UNFENCED first (a fence supersedes a live
  // holder and a never-fenced parent has none; fencing every supervised parent would also make a
  // manual, unfenced resume of it fail forever after).
  //
  // R8k (ADR 0118) — on `StaleFenceError` the fence is taken with `fenceIfParkedAt`: an
  // acquire-IF-PARKED, atomic in the store on the token AND "no answering event since the park".
  // That closes both windows the unconditional acquire left: a rival's acquire between this one's
  // acquire and append (the loser's resume is a clean `stale`, retried by the runtime on the token
  // the store returned), and a rival's acquire between this one's durable EXECUTION_RESUMED and the
  // read-back, which used to supersede the holder of the ALREADY RUNNING parent body (now refused:
  // an answering event past the park makes the acquire `stale`). A resume the runtime could not
  // fence after its bounded retries is a retryable `ResumeContendedError`: with `deps.redrive` it
  // becomes a backed-off `TimerStore` row fired by the `TimerService`; without it, `onError` and
  // `recover()`. A store without `acquireFenceIf` keeps the previous behaviour (an unconditional
  // acquire, bounded to two per resume, the park re-read before each) and its residual.
  const fenceIfSupported = deps.runtime.events.acquireFenceIf !== undefined;
  const FENCE_IF_TRIES = 3;
  const now = (): number => deps.runtime.clock();
  // Parents whose resume is being driven BY the re-driver: a `contended` outcome there is the
  // re-driver's verdict (it reschedules with a larger backoff), not a new row.
  const redriving = new Set<string>();
  const redriveContended = new Set<string>();
  const onContended = async (parentId: string, err: unknown): Promise<void> => {
    if (redriving.has(parentId)) {
      redriveContended.add(parentId);
      return;
    }
    const wiring = deps.redrive;
    if (wiring === undefined) {
      fail(err);
      return;
    }
    try {
      await scheduleRedrive(wiring.timers, parentId, 0, now(), wiring.backoff);
    } catch (writeErr) {
      fail(writeErr); // the row could not be written: recover() is the backstop
    }
  };
  const resumeParent = async (
    parentId: string,
    payload: unknown,
    opts: { key?: string; adopted?: boolean } = {}
  ): Promise<void> => {
    const key = opts.key;
    const sys = deps.runtime.systemOptions();
    const body = key !== undefined ? { ...(payload as object), viewDigest: key } : payload;
    let fence: number | undefined;
    let fences = 0;
    let fenceIfAt: number | undefined;
    let fenceIfTries = 0;
    try {
      for (let attempt = 0; ; attempt++) {
        if (key !== undefined) {
          const s = await deps.runtime.loadState(parentId, sys).catch(() => null);
          if (s?.status === "suspended" && !parkedOn(s, key)) return; // a later gate: stale.
        }
        let err: unknown;
        try {
          const handle = await deps.runtime.resume(
            parentId,
            { eventType: CHILD_DONE, payload: body },
            {
              ...sys,
              ...(fence !== undefined && { fence }),
              ...(fenceIfAt !== undefined && { fenceIfParkedAt: fenceIfAt }),
            }
          );
          err = await observeResume(handle, parentId, key);
          if (err === null) {
            resumedTotal++;
            return;
          }
          if (err === UNKNOWN) {
            // Neither evidence of the resume nor of its failure: do not count it, do not call it
            // an error — re-derive from the log with backoff (idempotent; the viewDigest guards).
            if (key !== undefined) scheduleAdopt(parentId, key);
            return;
          }
        } catch (e) {
          err = e;
        }
        if (err instanceof ResumeContendedError) {
          await onContended(parentId, err);
          return;
        }
        if (err instanceof ResumeRefusedError) {
          if (err.reason === "gate-mismatch" || err.reason === "view-digest-mismatch") return;
          if (err.reason === "not-suspended") {
            // The parent was not (yet) readable as suspended. Adopted: someone else already answered
            // it. Live: quiet too when the DURABLE log shows this very park answered; otherwise it
            // is the visibility gap, retried below.
            if (opts.adopted === true) return;
            if (key !== undefined && (await answeredDurably(parentId, key))) return;
          }
        }
        const writeFailure =
          isLostRace(err) || isStaleFence(err) || errName(err) === "StorageWriteError";
        if (writeFailure && key !== undefined) {
          const s = await deps.runtime.loadState(parentId, sys).catch(() => null);
          if (s !== null && !parkedOn(s, key)) return; // answered (by us or another): done.
        }
        if (isStaleFence(err) && fenceIfSupported && fenceIfTries < FENCE_IF_TRIES) {
          // The parent was fenced before: answer THIS park under a conditional fence.
          try {
            const cur = await deps.runtime.loadState(parentId, sys).catch(() => null);
            if (key !== undefined && cur !== null && !parkedOn(cur, key)) return; // answered meanwhile.
            const parkSeq = await deps.runtime.parkedAtSequence(parentId, sys);
            if (parkSeq === undefined) return; // no park to answer (answered, compacted, gone).
            fenceIfAt = parkSeq;
            fenceIfTries++;
          } catch (readErr) {
            fail(readErr);
            return;
          }
          continue;
        }
        if (isStaleFence(err) && !fenceIfSupported && fences < 2) {
          try {
            if (key !== undefined) {
              const now = await deps.runtime.loadState(parentId, sys).catch(() => null);
              if (now !== null && !parkedOn(now, key)) return; // answered meanwhile: don't fence it.
            }
            fences++;
            fence = await deps.runtime.acquireFence(parentId, sys);
          } catch (fenceErr) {
            fail(fenceErr);
            return;
          }
          continue;
        }
        const transient =
          (err instanceof Error && /No execution found/.test(err.message)) ||
          (err instanceof ResumeRefusedError && err.reason === "not-suspended") ||
          isLostRace(err);
        if (transient && attempt < 10) {
          await sleep(20 * (attempt + 1));
          continue;
        }
        fail(err);
        return;
      }
    } finally {
      if (key !== undefined) forget(key);
    }
  };

  // Start one child, tolerating a concurrent supervisor having started it first (the durable
  // bootstrap refuses a duplicate id): a start that failed because the child now EXISTS is not
  // an error, it is the race this design expects.
  const startChild = async (
    flow: RegisteredFlow,
    childId: string,
    spec: { input: unknown; grants?: readonly string[]; expiresAt?: number },
    parentId: string | undefined
  ): Promise<void> => {
    try {
      await deps.runtime.start(
        flow,
        spec.input,
        childStartOptions(
          childId,
          spec,
          deps.delegation,
          { ...deps.runtime.systemOptions(), ...deps.runtime.lineageOptions() },
          parentId
        )
      );
      startedTotal++;
    } catch (err) {
      const exists = await deps.runtime
        .loadState(childId, deps.runtime.systemOptions())
        .then((s) => s !== null)
        .catch(() => false);
      if (!exists) fail(err);
    }
  };

  // Spawn handling for a parent's CHILD_DONE suspend on `correlationKey`: start the single
  // child / every unstarted group member, or refuse per the R9 envelope. Called from the live
  // `EXECUTION_SUSPENDED` event and from recovery (for a spawn the log recorded but nobody started).
  const handleSuspend = (correlationKey: string): void => {
    if (started.has(correlationKey)) return;

    // Parallel spawn: one suspend, start every member of the group.
    const group = groups.get(correlationKey);
    if (group !== undefined) {
      // R9 — the envelope, enforced where children actually start. Checked BEFORE the
      // idempotency marker and before any member starts, so a refused group starts none.
      const breach = limitBreach(
        deps.limits,
        depthOf(group.members[0]?.childId ?? correlationKey),
        group.members.length,
        correlationKey
      );
      if (breach !== undefined) {
        for (const m of group.members) memberOf.delete(m.childId);
        groups.delete(correlationKey);
        fail(breach);
        const refused: ChildResult = {
          status: "failed",
          error: `${breach.name}: ${breach.message}`,
        };
        track(
          (async () => {
            if (!(await gate(group.parentId, correlationKey))) return;
            await resumeParent(
              group.parentId,
              { settled: group.members.map(() => refused) },
              { key: correlationKey }
            );
          })()
        );
        return;
      }
      started.add(correlationKey); // idempotency: a replayed suspend won't re-fan-out.
      const runnable = group.members.map((m) => ({ member: m, flow: deps.flows[m.flowId] }));
      for (const { member, flow } of runnable) {
        if (flow === undefined && !started.has(member.childId)) {
          // A member with no registered flow can never start, so the group can never
          // complete and the parent stays suspended (parity with the single-child
          // missing-flow case). Surface it; the other members still run.
          fail(new Error(`orchestration: no flow registered for "${member.flowId}"`));
        }
      }
      // One durability gate covers the whole group — all members share the one parent
      // suspend — then start each member (idempotently) exactly as a single child.
      track(
        (async () => {
          if (!(await gate(group.parentId, correlationKey))) return; // start nothing (yet).
          // The durable group is the authority for what to start (see `durableSpawn`).
          const durable = (await durableSpawn(group.parentId, correlationKey)).grp;
          if (durable === undefined) {
            forget(correlationKey);
            return;
          }
          for (const member of durable.members) {
            const flow = deps.flows[member.flowId];
            if (flow === undefined || started.has(member.childId)) continue;
            started.add(member.childId);
            await startChild(flow, member.childId, member, group.parentId);
          }
        })()
      );
      return;
    }

    // Single child.
    const childId = correlationKey;
    const spec = specs.get(childId);
    if (spec === undefined) return;
    const flow = deps.flows[spec.flowId];
    if (flow === undefined) {
      // Reclaim the spec — this child will never start, so no terminal
      // event will ever arrive to clean it up (audit MEM-LOW, pre-existing).
      specs.delete(childId);
      fail(new Error(`orchestration: no flow registered for "${spec.flowId}"`));
      return;
    }
    // R9 — the envelope, enforced where the child actually starts.
    const breach = limitBreach(deps.limits, depthOf(childId), 1, childId);
    if (breach !== undefined) {
      specs.delete(childId);
      fail(breach);
      const parentOfRefused = parentOf(childId);
      if (parentOfRefused !== undefined) {
        track(
          (async () => {
            if (!(await gate(parentOfRefused, childId))) return;
            await resumeParent(
              parentOfRefused,
              { __childFailed: { status: "failed", error: `${breach.name}: ${breach.message}` } },
              { key: childId }
            );
          })()
        );
      }
      return;
    }
    started.add(childId);
    // Start the child only once the parent's suspend is DURABLE (see waitParentDurable).
    const parentId = parentOf(childId);
    track(
      (async () => {
        if (!(await gate(parentId, childId))) return; // start nothing (yet).
        const durable =
          parentId === undefined ? undefined : (await durableSpawn(parentId, childId)).single;
        const durableFlow = durable === undefined ? undefined : deps.flows[durable.flowId];
        if (durable === undefined || durableFlow === undefined) {
          forget(childId);
          return;
        }
        await startChild(durableFlow, childId, durable, parentId);
      })()
    );
  };

  const TERMINAL = new Set(["EXECUTION_COMPLETED", "EXECUTION_FAILED", "EXECUTION_CANCELLED"]);

  // Executions retention has reclaimed, from the lifecycle stream's `EXECUTION_DELETED` facts
  // (journalled BEFORE the values go — P9 — so "deleted" is distinguishable from "never started").
  // Read incrementally: the stream is reserved and never compacted, so a cursor is sound.
  //
  // The fact is (id → time of the latest deletion), judged against WHEN the spawn was decided: an id
  // can be REUSED (a parent re-started under the same id spawns the same `P::g#0` again), and a
  // deletion older than the spawn belongs to the previous incarnation — it must not fail the new
  // member. BOUNDED (`maxReclaimed`, oldest dropped first): after an eviction a cache miss rescans
  // the stream from the start, so eviction costs time, never correctness (a deleted child must
  // never be mistaken for "never started" and re-run).
  const deleted = new Map<string, number>();
  let evicted = false;
  let lifecycleCursor = 0;
  const noteDeleted = (id: string, at: number): void => {
    deleted.delete(id); // re-insert at the young end
    deleted.set(id, Math.max(at, 0));
    if (deleted.size > tune.maxReclaimed) {
      const oldest = deleted.keys().next().value as string;
      deleted.delete(oldest);
      evicted = true;
    }
  };
  const wasReclaimed = async (childId: string, spawnedAt: number): Promise<boolean> => {
    const hit = deleted.get(childId);
    if (hit !== undefined && hit >= spawnedAt) return true;
    try {
      for (const e of await deps.runtime.events.readFrom(LIFECYCLE_STREAM, lifecycleCursor)) {
        lifecycleCursor = Math.max(lifecycleCursor, e.sequence + 1);
        if (e.eventType === "EXECUTION_DELETED") {
          const id = (e.payload as { executionId?: unknown }).executionId;
          if (typeof id === "string") noteDeleted(id, e.timestamp);
        }
      }
      const now = deleted.get(childId);
      if (now !== undefined) return now >= spawnedAt;
      if (evicted) {
        // may have been evicted: look at the whole stream for this one id.
        let latest = -1;
        for (const e of await deps.runtime.events.readFrom(LIFECYCLE_STREAM, 0)) {
          const id = (e.payload as { executionId?: unknown }).executionId;
          if (e.eventType === "EXECUTION_DELETED" && id === childId) {
            latest = Math.max(latest, e.timestamp);
          }
        }
        return latest >= spawnedAt && latest >= 0;
      }
    } catch {
      // No lifecycle stream / unreadable: nothing is known to be reclaimed.
    }
    return false;
  };

  // The settled outcome of a child as the DURABLE LOG has it: a settled result, "running" (it
  // exists, is not terminal), or "absent" (no events and no retention fact: never started). `hint`
  // is a terminal event the caller just observed live — `onEvent` fires before the durable write
  // drains, so the log alone could still read that child as running.
  //
  // A child retention has since DELETED settles as a typed failure — it must never be re-run (its
  // side effects already happened, and a re-run would replace the output the parent was owed).
  // When the terminal event was compacted away the fold still knows the OUTCOME, but the error text
  // / cancel reason is lost (a failed child reads "terminal event compacted").
  const settledOf = async (
    childId: string,
    spawnedAt: number,
    hint?: EventEnvelope
  ): Promise<ChildResult | "running" | "absent"> => {
    if (hint !== undefined && hint.executionId === childId && TERMINAL.has(hint.eventType)) {
      return settle(hint);
    }
    let st = await deps.runtime.loadState(childId, deps.runtime.systemOptions());
    if (st === null) {
      return (await wasReclaimed(childId, spawnedAt))
        ? {
            status: "failed",
            error: `child execution "${childId}" was reclaimed by retention before its result was collected`,
          }
        : "absent";
    }
    // A `continued` child is never a result (ADR 0109 D6): it is "look at the head". The supervisor
    // routes to the chain's newest generation however many generations rotated while it was
    // away (`followToHead`: O(log n), verified by the kernel), and settles from
    // the head's own log. A head still running is remembered so its terminal event settles THIS
    // child's slot, and a further rotation advances it (`EXECUTION_CONTINUED` below).
    let headId = childId;
    if (st.status === "continued") {
      const head = await deps.runtime.followToHead(childId, deps.runtime.systemOptions());
      if (head === null) return "running";
      headId = head.executionId;
      st = head.state;
      if (st.status === "continued") return "running"; // an unreadable successor: the sweep retries
    }
    if (headId !== childId) {
      if (st.status !== "completed" && st.status !== "failed" && st.status !== "cancelled") {
        // the furthest id reached stands in for the child: a stale nearer entry would never fire
        for (const [k, original] of followed) if (original === childId) followed.delete(k);
        followed.set(headId, childId);
        return "running";
      }
    }
    if (st.status !== "completed" && st.status !== "failed" && st.status !== "cancelled") {
      return "running";
    }
    const log = await deps.runtime.events.read(headId);
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      if (e !== undefined && TERMINAL.has(e.eventType)) return settle(e);
    }
    // The terminal event was compacted away; the fold still knows the outcome.
    if (st.status === "completed") return { status: "completed", output: st.variables._output };
    if (st.status === "cancelled") return { status: "cancelled" };
    return { status: "failed", error: "execution failed (terminal event compacted)" };
  };

  // What the supervisor currently holds, as key → the parent whose park it belongs to.
  const heldParks = (): Map<string, string> => {
    const held = new Map<string, string>();
    for (const [key, g] of groups) held.set(key, g.parentId);
    for (const key of specs.keys()) {
      const pid = parentOf(key);
      if (pid !== undefined) held.set(key, pid);
    }
    for (const id of started) {
      if (memberOf.has(id) || held.has(id)) continue;
      const pid = parentOf(id);
      if (pid !== undefined) held.set(id, pid);
    }
    return held;
  };
  // The parent's DURABLE log shows `key` answered (or the parent over). Unknown / unreadable ⇒ false.
  const parkGone = async (parentId: string, key: string): Promise<boolean> => {
    const st = await loadParent(parentId);
    if (st === undefined || st === null) return false;
    if (
      st.status === "completed" ||
      st.status === "failed" ||
      st.status === "cancelled" ||
      st.status === "continued"
    ) {
      return true;
    }
    if (parkedOn(st, key)) return false;
    return answeredDurably(parentId, key);
  };
  const dropGone = async (parentId: string): Promise<void> => {
    for (const [key, pid] of heldParks()) {
      if (pid === parentId && (await parkGone(pid, key))) forget(key);
    }
  };
  // A park can be answered ELSEWHERE (another node resumed the parent): this process then never sees
  // the child's terminal event, so nothing here would ever release what an adoption (or a start)
  // recorded. The sweep re-checks the log for every held park; it runs while anything is held.
  const sweep = async (): Promise<void> => {
    for (const [key, pid] of heldParks()) {
      if (await parkGone(pid, key)) forget(key);
    }
  };
  let sweeping = false;
  const ensureSweeper = (): void => {
    if (sweeping) return;
    sweeping = true;
    void (async () => {
      try {
        while (heldParks().size > 0) {
          await sleepUnref(tune.sweepMs);
          await sweep();
        }
      } catch (err) {
        fail(err);
      } finally {
        sweeping = false;
      }
    })();
  };

  // R8 — rebuild the supervisor's state for ONE parked parent from the durable log, then act:
  // resume it if everything it awaits already settled, start what was recorded but never
  // started, or hand running children back to the live path. Per-parent serialized.
  //
  // What is read: the parent's fold (parked on CHILD_DONE? on which key?), the parent's log (the
  // spawn `DECISION_RECORDED` for that key — the spec / group members), and each awaited child's
  // state + terminal event. No store-wide scan; O(parent log + awaited children).
  //
  // Cached state is NEVER trusted over the log: another supervisor may have settled members this
  // one never saw, so this re-derives every unsettled slot even when the park is already known
  // (`started`). A duplicate resume that results is harmless (the park's `viewDigest`).
  const adoptOnce = async (parentId: string, hint?: EventEnvelope): Promise<void> => {
    const sys = deps.runtime.systemOptions();
    const st = await deps.runtime.loadState(parentId, sys).catch(() => null);
    await dropGone(parentId); // whatever is held for a park the log shows answered goes now.
    if (st?.status !== "suspended" || st.suspendedOn?.on !== CHILD_DONE) return;
    const key = st.suspendedOn.correlationKey;
    if (key === undefined) return;
    const { single, grp, spawnedAt } = await durableSpawn(parentId, key);
    if (single === undefined && grp === undefined) {
      fail(
        new Error(
          `orchestration: execution "${parentId}" is parked on ${CHILD_DONE} "${key}" but its log records no spawn for it — cannot supervise`
        )
      );
      return;
    }

    if (grp !== undefined) {
      let g = groups.get(key);
      if (g === undefined) {
        g = {
          parentId,
          members: grp.members,
          results: new Array<ChildResult>(grp.members.length),
          remaining: grp.members.length,
          spawnedAt,
        };
        groups.set(key, g);
      }
      let unstarted = false;
      for (const [index, m] of grp.members.entries()) {
        if (g.results[index] !== undefined) continue;
        const r = await settledOf(m.childId, g.spawnedAt, hint);
        if (g.results[index] !== undefined) continue; // settled live while we read.
        if (r === "absent") {
          unstarted = true;
          memberOf.set(m.childId, { groupId: key, index });
        } else if (r === "running") {
          started.add(m.childId);
          memberOf.set(m.childId, { groupId: key, index });
        } else {
          g.results[index] = r;
          g.remaining -= 1;
          memberOf.delete(m.childId);
          started.delete(m.childId);
        }
      }
      if (g.remaining === 0) {
        await resumeParent(parentId, { settled: g.results }, { key, adopted: true });
      } else if (started.has(key)) {
        // already live (members are starting / running here): nothing more to start.
      } else if (unstarted) {
        handleSuspend(key);
      } else {
        started.add(key);
      }
      return;
    }

    const one = single as NonNullable<typeof single>;
    const r = await settledOf(key, spawnedAt, hint);
    if (r === "absent") {
      specs.set(key, {
        flowId: one.flowId,
        input: one.input,
        ...(one.grants !== undefined && { grants: one.grants }),
        ...(one.expiresAt !== undefined && { expiresAt: one.expiresAt }),
      });
      if (!started.has(key)) handleSuspend(key);
    } else if (r === "running") {
      started.add(key);
    } else {
      await resumeParent(
        parentId,
        r.status === "completed" ? { output: r.output } : { __childFailed: r },
        { key, adopted: true }
      );
    }
  };

  // Per-parent serialization of adoption / reconciliation (they read-modify-write one group).
  const tails = new Map<string, Promise<void>>();
  const serial = (parentId: string, work: () => Promise<void>): Promise<void> => {
    const next = (tails.get(parentId) ?? Promise.resolve()).then(work).catch(fail);
    tails.set(parentId, next);
    void next.then(() => {
      if (tails.get(parentId) === next) tails.delete(parentId);
    });
    return next;
  };
  const adopt = (parentId: string, hint?: EventEnvelope): Promise<void> =>
    serial(parentId, async () => {
      try {
        await adoptOnce(parentId, hint);
      } finally {
        ensureSweeper(); // adoption may have recorded state for a park another node will answer.
      }
    });

  // A group member settled here with siblings still outstanding. Those siblings may have settled
  // on ANOTHER node (their terminal events never reach this supervisor's `onEvent`, and vice
  // versa), so the in-memory `remaining` count can be forever too high on every node: nobody would
  // resume the parent. Re-read the unsettled siblings from the log. Waits for THIS member's
  // terminal to be durable first: each node reads only after its own settle is durable, so
  // whichever settles durably LAST is guaranteed to see the other's. Cost: one state read per
  // still-unsettled sibling per member settle (O(n²) over a group of n; the group is bounded by
  // `limits.maxFanOut`).
  const reconcileGroup = (groupId: string, member: EventEnvelope): Promise<void> => {
    const group = groups.get(groupId);
    if (group === undefined) return Promise.resolve();
    return serial(group.parentId, async () => {
      for (
        let i = 0;
        i < 200 && (await settledOf(member.executionId, group.spawnedAt)) === "running";
        i++
      ) {
        await sleep(5);
      }
      const g = groups.get(groupId);
      if (g === undefined) return;
      for (const [index, m] of g.members.entries()) {
        if (g.results[index] !== undefined) continue;
        const r = await settledOf(m.childId, g.spawnedAt);
        if (r === "absent" || r === "running" || g.results[index] !== undefined) continue;
        g.results[index] = r;
        g.remaining -= 1;
        memberOf.delete(m.childId);
        started.delete(m.childId);
      }
      if (g.remaining === 0 && groups.get(groupId) === g) {
        groups.delete(groupId);
        started.delete(groupId);
        await resumeParent(g.parentId, { settled: g.results }, { key: groupId });
      }
    });
  };

  // A terminal event for a child execution (the live path, and recovery's re-route).
  const onChildTerminal = (event: EventEnvelope): void => {
    const execId = event.executionId;
    // A group member terminating: SETTLE it into the group's slot (wait-all — success
    // AND failure both fill a slot) rather than resuming the parent directly (the parent
    // awaits the WHOLE group). When the last member settles, resume once with the array.
    const location = memberOf.get(execId);
    if (location !== undefined) {
      memberOf.delete(execId);
      started.delete(execId);
      const group = groups.get(location.groupId);
      if (group === undefined) return;
      if (group.results[location.index] === undefined) {
        group.results[location.index] = settle(event);
        group.remaining -= 1;
      }
      if (group.remaining === 0) {
        groups.delete(location.groupId);
        started.delete(location.groupId); // fan-out idempotency marker; group is done.
        // Results are positionally aligned with `children` (index order), NOT completion
        // order — the deterministic contract awaitChildren promises.
        void resumeParent(group.parentId, { settled: group.results }, { key: location.groupId });
      } else {
        void reconcileGroup(location.groupId, event); // siblings may have settled elsewhere.
      }
      return;
    }

    const parentId = parentOf(execId);
    if (!started.has(execId)) {
      // R8 — a child this process never saw spawned (it was started before a restart, or by
      // another process). Rebuild its parent's park from the log instead of dropping it.
      if (parentId !== undefined) void adopt(parentId, event);
      return;
    }
    if (parentId !== undefined) {
      if (event.eventType === "EXECUTION_COMPLETED") {
        void resumeParent(
          parentId,
          { output: (event.payload as { output?: unknown }).output },
          { key: execId }
        );
      } else {
        // Propagate the child's abnormal termination so the parent's `awaitChild` THROWS
        // `childFailed` (and, uncaught, fails the parent — which propagates one level up
        // if the parent is itself a child) instead of hanging forever.
        void resumeParent(parentId, { __childFailed: settle(event) }, { key: execId });
      }
    }
    // Bound the supervisor's maps: once a child is terminal it needs no more bookkeeping.
    specs.delete(execId);
    started.delete(execId);
  };

  // ── ADR 0112 D5 — the cancel cascade (1P: the kernel has no child relation) ─────────────────
  //
  // Cancelling a parent cancels the children it spawned that are still running, unless a child
  // was spawned `detached`. A cancel is the one terminal the parent cannot recover from, so a
  // non-detached child left running would be work nobody awaits and nobody can see.
  //
  // LIVE: the parent's own `EXECUTION_CANCELLED` (and a continued parent's `EXECUTION_CONTINUED`)
  // reaches `onEvent`; the child list is the parent's recorded spawn decisions (the durable
  // authority, read from its log) plus whatever this supervisor holds in memory. An id with no
  // execution (a spawn recorded but never started) is ignored.
  // SWEEP: `recover()` also cancels any non-terminal execution whose RECORDED lineage
  // (`EXECUTION_STARTED.parent`, written only through the runtime's lineage grant) names a
  // parent that is cancelled/continued: that finds the orphans the live path missed (the parent
  // was cancelled on a node with no supervisor, or the supervisor was down). It is a scan of the
  // child side, so the GUARANTEE is "a scheduled `recover()` bounds an orphan's lifetime", not a
  // live property.
  let cascadedTotal = 0;
  const cascadeReason = (parentId: string): string =>
    JSON.stringify({ kind: "cascade", parent: parentId });

  const cascadeCancel = async (childId: string, parentId: string): Promise<void> => {
    try {
      const cancelled = await deps.runtime.cancel(
        childId,
        cascadeReason(parentId),
        deps.runtime.systemOptions()
      );
      if (cancelled) cascadedTotal++;
    } catch (err) {
      // A child that was never started has no execution to cancel: nothing to do.
      if (!String((err as Error | undefined)?.message ?? err).startsWith("No execution found")) {
        fail(err);
      }
    }
  };

  /** The children `parentId` spawned, with whether each opted out, from memory and (durably) its log. */
  const spawnedBy = async (
    parentId: string,
    fromMemory: Map<string, boolean>
  ): Promise<Map<string, boolean>> => {
    const out = new Map(fromMemory);
    try {
      for (const e of await deps.runtime.events.read(parentId)) {
        if (e.eventType !== "DECISION_RECORDED") continue;
        const choice = (e.payload as { choice?: unknown }).choice;
        const one = asSpawnChoice(choice);
        if (one !== undefined) out.set(one.childId, one.detached === true);
        const many = asGroupChoice(choice);
        if (many !== undefined) {
          for (const m of many.members) out.set(m.childId, m.detached === true);
        }
      }
    } catch {
      // An unreadable (or shredded) parent log: the in-memory view and the sweep are what is left.
    }
    return out;
  };

  /** What this supervisor holds in memory for `parentId`'s children (read BEFORE the reclaim drops it). */
  const memorySpawnedBy = (parentId: string): Map<string, boolean> => {
    const out = new Map<string, boolean>();
    for (const [childId, spec] of specs) {
      if (parentOf(childId) === parentId) out.set(childId, spec.detached === true);
    }
    for (const group of groups.values()) {
      if (group.parentId !== parentId) continue;
      for (const m of group.members) out.set(m.childId, m.detached === true);
    }
    return out;
  };

  const cascadeFrom = async (parentId: string, fromMemory: Map<string, boolean>): Promise<void> => {
    const children = await spawnedBy(parentId, fromMemory);
    const work: Promise<void>[] = [];
    for (const [childId, detached] of children) {
      if (!detached) work.push(cascadeCancel(childId, parentId));
    }
    await Promise.all(work);
  };

  /**
   * Is `childId` a detached spawn of `parentId`? Read from the parent's recorded decisions. A
   * `recover` pass passes its own `cache` so a gone parent's log is read ONCE per pass, not once
   * per orphan (a parent with N orphaned children cost N full log reads). Bounded by the caller.
   */
  const isDetachedSpawn = async (
    parentId: string,
    childId: string,
    cache?: Map<string, Map<string, boolean>>
  ): Promise<boolean> => {
    let spawned = cache?.get(parentId);
    if (spawned === undefined) {
      spawned = await spawnedBy(parentId, new Map());
      if (cache !== undefined) {
        if (cache.size >= 64) cache.clear();
        cache.set(parentId, spawned);
      }
    }
    return spawned.get(childId) === true;
  };

  const recover = async (options?: {
    source?: ExecutionEnumerable;
    pageSize?: number;
  }): Promise<RecoverSummary> => {
    const source = options?.source ?? (deps.runtime.events as unknown as ExecutionEnumerable);
    const summary: RecoverSummary = { scanned: 0, parked: 0, resumed: 0, started: 0, cascaded: 0 };
    const resumed0 = resumedTotal;
    const started0 = startedTotal;
    const cascaded0 = cascadedTotal;
    // parent id → is it cancelled / continued (an orphan's parent). Bounded: a pass over a big
    // store must not hold every parent it ever met.
    const parentGone = new Map<string, boolean>();
    // parent id → its recorded spawns (child → detached), read once per pass (bounded).
    const spawnCache = new Map<string, Map<string, boolean>>();
    for await (const id of iterateExecutionIds(source, options?.pageSize)) {
      if (isReservedStream(id)) continue;
      summary.scanned++;
      const st = await deps.runtime.loadState(id, deps.runtime.systemOptions()).catch(() => null);
      // ADR 0112 D5 — an orphan: still live, with a RECORDED parent that was cancelled/continued.
      const recordedParent = (st?.variables as { _parent?: unknown } | undefined)?._parent;
      if (
        st !== null &&
        st !== undefined &&
        typeof recordedParent === "string" &&
        (st.status === "running" || st.status === "suspended" || st.status === "pending")
      ) {
        let gone = parentGone.get(recordedParent);
        if (gone === undefined) {
          const ps = await deps.runtime
            .loadState(recordedParent, deps.runtime.systemOptions())
            .catch(() => null);
          gone = ps?.status === "cancelled" || ps?.status === "continued";
          if (parentGone.size >= 1024) parentGone.clear();
          parentGone.set(recordedParent, gone);
        }
        if (gone && !(await isDetachedSpawn(recordedParent, id, spawnCache))) {
          await cascadeCancel(id, recordedParent);
          continue;
        }
      }
      if (st?.status !== "suspended" || st.suspendedOn?.on !== CHILD_DONE) continue;
      summary.parked++;
      await adopt(id);
    }
    // Child starts / refusals are fire-and-forget (gated on `waitParentDurable`); wait for them.
    await Promise.allSettled([...inflight]);
    await sweep().catch(fail);
    summary.resumed = resumedTotal - resumed0;
    summary.started = startedTotal - started0;
    summary.cascaded = cascadedTotal - cascaded0;
    return summary;
  };

  // ADR 0118 D3 — "is a parent durably parked on this child?" (the retention pin).
  const parkedOnChild = async (childId: string): Promise<boolean> => {
    const sys = deps.runtime.systemOptions();
    try {
      // The parent edge: the child's OWN recorded `parent` (sequence 0; only the lineage grant
      // writes it, so a caller cannot forge one). Before R3k logs carried none: fall back to what
      // this supervisor has rebuilt (a group member's group, or a child it started/specced).
      const first = (await readRangeOf(deps.runtime.events, childId, 0, 0))[0];
      const recorded = (first?.payload as { parent?: unknown } | null | undefined)?.parent;
      let parentId: string | undefined =
        typeof recorded === "string" && recorded.length > 0 ? recorded : undefined;
      if (parentId === undefined) {
        const member = memberOf.get(childId);
        if (member !== undefined) parentId = groups.get(member.groupId)?.parentId;
        else if (started.has(childId) || specs.has(childId)) parentId = parentOf(childId);
      }
      if (parentId === undefined) return false;
      const st = await deps.runtime.loadState(parentId, sys);
      if (st?.status !== "suspended" || st.suspendedOn?.on !== CHILD_DONE) return false;
      const key = st.suspendedOn.correlationKey;
      if (key === undefined) return false;
      if (key === childId) return true; // a single child: the park's key IS the child id
      const { grp } = await durableSpawn(parentId, key);
      return grp?.members.some((m) => m.childId === childId) ?? false;
    } catch (err) {
      // A crypto-shredded log is unreadable BY DESIGN and forever (the key is destroyed): nothing
      // can be parked on it, and pinning it would block its retention AND compaction for good.
      // Matched by NAME (this package does not depend on the crypto plugin), through the
      // StorageWriteError/cause wrappers. Any OTHER failure is rethrown: the retention run fails
      // visibly and the log is KEPT (a swallowed error would have to guess).
      if (
        errName(rootCause(err)) === "PayloadShreddedError" ||
        errName(err) === "PayloadShreddedError"
      ) {
        return false;
      }
      throw err;
    }
  };

  // ADR 0118 D4 — the re-driver this supervisor contributes to the `TimerService`: re-derive the
  // resume of ONE parked parent from the log (`adopt`) and say whether it is still contended.
  const redriver: Redriver = async (parentId) => {
    const st = await loadParent(parentId);
    if (st === undefined) return "contended"; // an unreadable store is retried, not dropped
    if (st === null || st.status !== "suspended" || st.suspendedOn?.on !== CHILD_DONE) {
      return "noop"; // answered (or gone): nothing to drive
    }
    redriving.add(parentId);
    try {
      await adopt(parentId);
    } finally {
      redriving.delete(parentId);
    }
    return redriveContended.delete(parentId) ? "contended" : "done";
  };
  deps.redrive?.service.registerRedriver(redriver);

  return {
    onEvent(event: EventEnvelope): void {
      if (event.eventType === "DECISION_RECORDED") {
        const choice = (event.payload as { choice?: unknown }).choice;
        const single = asSpawnChoice(choice);
        if (single !== undefined) {
          specs.set(single.childId, {
            flowId: single.flowId,
            input: single.input,
            ...(single.grants !== undefined && { grants: single.grants }),
            ...(single.expiresAt !== undefined && { expiresAt: single.expiresAt }),
            ...(single.detached === true && { detached: true }),
          });
          ensureSweeper();
          return;
        }
        const group = asGroupChoice(choice);
        if (group !== undefined) {
          groups.set(group.groupId, {
            // groupId is `<parentId>::<key>`, so parentOf peels back to the parent.
            parentId: parentOf(group.groupId) ?? group.groupId,
            members: group.members,
            results: new Array<ChildResult>(group.members.length),
            remaining: group.members.length,
            spawnedAt: event.timestamp,
          });
          group.members.forEach((m, index) =>
            memberOf.set(m.childId, { groupId: group.groupId, index })
          );
          ensureSweeper();
        }
        return;
      }

      if (event.eventType === "EXECUTION_SUSPENDED") {
        const condition = (
          event.payload as { condition?: { on?: string; correlationKey?: string } }
        ).condition;
        if (condition?.on !== CHILD_DONE) return;
        const correlationKey = condition.correlationKey;
        if (correlationKey === undefined || started.has(correlationKey)) return;
        handleSuspend(correlationKey);
        return;
      }

      if (
        event.eventType === "EXECUTION_COMPLETED" ||
        event.eventType === "EXECUTION_FAILED" ||
        event.eventType === "EXECUTION_CANCELLED" ||
        // ADR 0109: a continued parent is as finished as a completed one — it spawns no further
        // children and nothing will resume it, so its recorded-but-never-started specs and
        // unresolved groups are dead.
        (event.eventType === "EXECUTION_CONTINUED" && event.metadata?.kernel === true)
      ) {
        const execId = event.executionId;
        // ADR 0112 D5 — a cancelled (or continued) parent cancels its non-detached children. The
        // in-memory view is captured NOW, before the reclaim below drops it.
        if (
          event.eventType === "EXECUTION_CANCELLED" ||
          event.eventType === "EXECUTION_CONTINUED"
        ) {
          track(cascadeFrom(execId, memorySpawnedBy(execId)).catch(fail));
        }
        // Reclaim specs for any recorded-but-never-started child of a parent that has now
        // terminated. If a parent fails/cancels before its CHILD_DONE suspend lands, the
        // child never starts, so no child-terminal event ever arrives to clean its spec —
        // an unbounded `specs` leak. A terminated execution spawns no further children, so
        // any spec still keyed under it is dead. (`started` self-cleans: only started
        // children get an entry, and a started child always reaches its own terminal event.)
        for (const recordedChildId of specs.keys()) {
          if (parentOf(recordedChildId) === execId) specs.delete(recordedChildId);
        }
        // Same reclaim for a group whose parent terminated before (or instead of) resuming:
        // an unresolved group under a dead parent is dead. Also drop its member index.
        for (const [groupId, group] of groups) {
          if (group.parentId === execId) {
            for (const m of group.members) memberOf.delete(m.childId);
            groups.delete(groupId);
            started.delete(groupId); // the fan-out idempotency marker; dead with the group.
          }
        }

        // A continued execution is NOT a child result (ADR 0109 D6: "look at the head"): it never
        // settles a group slot or resumes a parent. If it is a child this supervisor tracks, its
        // SUCCESSOR now stands in for it (any number of rotations), and the successor's terminal event
        // settles the original slot.
        if (event.eventType === "EXECUTION_CONTINUED") {
          const successor = (event.payload as { successorId?: unknown } | null)?.successorId;
          if (typeof successor === "string" && successor.length > 0) {
            const tracked = followed.get(execId) ?? execId;
            if (
              memberOf.has(tracked) ||
              started.has(tracked) ||
              specs.has(tracked) ||
              followed.has(execId)
            ) {
              followed.delete(execId);
              followed.set(successor, tracked);
            }
          }
        } else {
          const original = followed.get(execId);
          if (original !== undefined) {
            followed.delete(execId);
            onChildTerminal({ ...event, executionId: original });
          } else {
            onChildTerminal(event);
          }
        }
      }
    },
    recover,
    parkedOnChild,
    size: () => ({
      specs: specs.size,
      started: started.size,
      groups: groups.size,
      memberOf: memberOf.size,
      reclaimed: deleted.size,
    }),
  };
}
