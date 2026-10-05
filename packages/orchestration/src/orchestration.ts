import type { EventEnvelope } from "@loom/core";
import { fail } from "@loom/core";
import type { PrincipalChain } from "@loom/effect-runtime";
import { signDelegation } from "@loom/effect-runtime";
import { ResumeRefusedError } from "@loom/workflow-runtime";
import type {
  ExecutionContext,
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
  }));
  const resumed = (await ctx.suspend({ on: CHILD_DONE, correlationKey: childId })) as unknown as {
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
  const resumed = (await ctx.suspend({ on: CHILD_DONE, correlationKey: groupId })) as unknown as {
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
}

export interface ChildSupervisor {
  /** Wire this into `WorkflowRuntimeDeps.onEvent` (it sees every execution's events). */
  onEvent(event: EventEnvelope): void;
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
  system: { system?: SystemGrant }
): { executionId: string; principal?: PrincipalChain; system?: SystemGrant } {
  // R3 — a child start is the supervisor acting, so it presents the system grant (bypasses the
  // execution authorizer only); the delegation principal, when any, still reaches its effects.
  if (delegation === undefined || spec.grants === undefined) {
    return { executionId: childId, ...system };
  }
  const token = signDelegation(delegation.secret, childId, [...spec.grants], spec.expiresAt);
  return { executionId: childId, principal: { actor: childId, delegation: token }, ...system };
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
  // childId → spec, learned from DECISION_RECORDED before the parent's suspend lands.
  const specs = new Map<
    string,
    { flowId: string; input: unknown; grants?: readonly string[]; expiresAt?: number }
  >();
  // childIds (and groupIds) already started this process (idempotency within the runtime).
  const started = new Set<string>();
  // groupId → live aggregation for a parallel spawn: its members, their SETTLED results
  // collected positionally, and the count still outstanding. Learned from the group
  // DECISION_RECORDED. Wait-all: every member (success OR failure) fills its slot.
  const groups = new Map<
    string,
    { parentId: string; members: GroupMember[]; results: ChildResult[]; remaining: number }
  >();
  // member childId → (groupId, index), so a member's terminal event lands in the right slot.
  const memberOf = new Map<string, { groupId: string; index: number }>();

  const fail = (err: unknown): void => deps.onError?.(err);

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

  // Wait until the parent is DURABLE (readable-as-suspended) before touching it. onEvent
  // fires synchronously at commit time (ExecutionJournal.commit), BEFORE the async durable
  // write drains — so a fast/instant child could otherwise complete and trigger a resume
  // that re-reads a parent whose suspend has not yet landed ("No execution found" → the
  // parent hangs). Bounded (~1s); typically resolves at once. `loadState` and `resume` read
  // the SAME event store, so once the parent reads suspended a later resume is guaranteed
  // to find it. (A parallel spawn multiplies the exposure — N children racing ONE suspend —
  // but the gate is per-suspend, so one wait covers the whole group.)
  const waitParentDurable = async (parentId: string | undefined): Promise<void> => {
    if (parentId === undefined) return;
    for (let i = 0; i < 200; i++) {
      const s = await deps.runtime
        .loadState(parentId, deps.runtime.systemOptions())
        .catch(() => undefined);
      if (s?.status === "suspended") break;
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  // Resume the parent, retrying a transient failure. A completed child proves its parent
  // exists and is suspended-on-CHILD_DONE, but under an async event store (e.g. Postgres) a
  // just-written suspend can briefly not be readable when the child completes almost
  // instantly — a read-after-write visibility gap the durability gate bounds but a slower
  // store can still exceed. Without the retry the resume throws and the parent hangs forever.
  // Bounded backoff (~1s) backstops the gate; a genuinely missing parent still surfaces via
  // onError after the retries. `payload` is `{ output }` for a single child or `{ outputs }`
  // for a group.
  //
  // TWO shapes of the same gap, both retriable: the parent's log may not be readable at all
  // ("No execution found"), or it may be readable but not yet folded to `suspended` — which
  // the resume ingress gate (#305) now refuses with `reason: "not-suspended"` rather than
  // resuming a still-running parent. Matching on the machine-readable reason, not the
  // message: every other refusal (gate-mismatch, kernel-event-type) is permanent and
  // retrying it would just delay a real error by a second.
  const resumeParent = async (parentId: string, payload: unknown, attempt = 0): Promise<void> => {
    try {
      await deps.runtime.resume(
        parentId,
        { eventType: CHILD_DONE, payload },
        deps.runtime.systemOptions()
      );
    } catch (err) {
      const transient =
        (err instanceof Error && /No execution found/.test(err.message)) ||
        (err instanceof ResumeRefusedError && err.reason === "not-suspended");
      if (transient && attempt < 10) {
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
        return resumeParent(parentId, payload, attempt + 1);
      }
      fail(err);
    }
  };

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
          });
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
          });
          group.members.forEach((m, index) =>
            memberOf.set(m.childId, { groupId: group.groupId, index })
          );
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
            void (async () => {
              await waitParentDurable(group.parentId);
              await resumeParent(group.parentId, {
                settled: group.members.map(() => refused),
              });
            })();
            return;
          }
          started.add(correlationKey); // idempotency: a replayed suspend won't re-fan-out.
          const runnable = group.members.map((m) => ({ member: m, flow: deps.flows[m.flowId] }));
          for (const { member, flow } of runnable) {
            if (flow === undefined) {
              // A member with no registered flow can never start, so the group can never
              // complete and the parent stays suspended (parity with the single-child
              // missing-flow case). Surface it; the other members still run.
              fail(new Error(`orchestration: no flow registered for "${member.flowId}"`));
            }
          }
          // One durability gate covers the whole group — all members share the one parent
          // suspend — then start each member (idempotently) exactly as a single child.
          void (async () => {
            await waitParentDurable(group.parentId);
            for (const { member, flow } of runnable) {
              if (flow === undefined || started.has(member.childId)) continue;
              started.add(member.childId);
              await deps.runtime
                .start(
                  flow,
                  member.input,
                  childStartOptions(
                    member.childId,
                    member,
                    deps.delegation,
                    deps.runtime.systemOptions()
                  )
                )
                .catch(fail);
            }
          })();
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
            void (async () => {
              await waitParentDurable(parentOfRefused);
              await resumeParent(parentOfRefused, {
                __childFailed: { status: "failed", error: `${breach.name}: ${breach.message}` },
              });
            })();
          }
          return;
        }
        started.add(childId);
        // Start the child only once the parent's suspend is DURABLE (see waitParentDurable).
        const parentId = parentOf(childId);
        void (async () => {
          await waitParentDurable(parentId);
          await deps.runtime
            .start(
              flow,
              spec.input,
              childStartOptions(childId, spec, deps.delegation, deps.runtime.systemOptions())
            )
            .catch(fail);
        })();
        return;
      }

      if (
        event.eventType === "EXECUTION_COMPLETED" ||
        event.eventType === "EXECUTION_FAILED" ||
        event.eventType === "EXECUTION_CANCELLED"
      ) {
        const execId = event.executionId;
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

        // A group member terminating: SETTLE it into the group's slot (wait-all — success
        // AND failure both fill a slot) rather than resuming the parent directly (the parent
        // awaits the WHOLE group). When the last member settles, resume once with the array.
        const location = memberOf.get(execId);
        if (location !== undefined) {
          memberOf.delete(execId);
          started.delete(execId);
          const group = groups.get(location.groupId);
          if (group === undefined) return;
          group.results[location.index] = settle(event);
          group.remaining -= 1;
          if (group.remaining === 0) {
            groups.delete(location.groupId);
            started.delete(location.groupId); // fan-out idempotency marker; group is done.
            // Results are positionally aligned with `children` (index order), NOT completion
            // order — the deterministic contract awaitChildren promises.
            void resumeParent(group.parentId, { settled: group.results });
          }
          return;
        }

        if (!started.has(execId)) return;
        const parentId = parentOf(execId);
        if (parentId !== undefined) {
          if (event.eventType === "EXECUTION_COMPLETED") {
            void resumeParent(parentId, { output: (event.payload as { output?: unknown }).output });
          } else {
            // Propagate the child's abnormal termination so the parent's `awaitChild` THROWS
            // `childFailed` (and, uncaught, fails the parent — which propagates one level up
            // if the parent is itself a child) instead of hanging forever.
            void resumeParent(parentId, { __childFailed: settle(event) });
          }
        }
        // Bound the supervisor's maps: once a child is terminal it needs no more bookkeeping.
        specs.delete(execId);
        started.delete(execId);
      }
    },
  };
}
