import type { EventEnvelope } from "@loom/core";
import { fail } from "@loom/core";
import type { ExecutionContext, RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";

// ── Cross-execution orchestration (child workflows) ───────────────────────────
//
// Spawn a child workflow from a parent and durably await its result — WITHOUT a new
// syscall. The primitive is composed from ones that already exist:
//   • `ctx.decide` durably (and replay-safely) fixes the child's id + spec;
//   • `ctx.suspend({ on: CHILD_DONE, correlationKey: childId })` parks the parent;
//   • a supervisor starts the child, and on the child's completion `resume`s the parent
//     with the child's output.
// Each await rides ONE suspend/resume cycle per parent (the single `_resumePayload` slot):
//   • `awaitChild` — spawn ONE child, suspend once, resume once with its output.
//   • `awaitChildren` — spawn N children CONCURRENTLY under a shared group correlationKey,
//     suspend once, resume once with the array of outputs (still one slot: the supervisor
//     aggregates every child's output and delivers them together). Outputs come back in
//     input order, not completion order.
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

/** Marker + spec recorded by `awaitChild` and read by the supervisor. */
interface SpawnChoice {
  __orchestration: true;
  childId: string;
  flowId: string;
  input: unknown;
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
 * `maxDepth` (ADR 0061 D5) bounds recursive re-entry — a self-invoking flow
 * (e.g. a drift-repair loop re-entering its interpreter) must not recurse
 * unboundedly on persistent failure. Exceeding it throws a typed
 * `depthExceeded` failure (ADR 0060) BEFORE anything durable happens, so the
 * calling flow can catch it and settle; uncaught, the run fails loudly.
 */
export async function awaitChild<TOut = unknown>(
  ctx: Pick<ExecutionContext, "executionId" | "decide" | "suspend">,
  spec: { key: string; flowId: string; input: unknown; maxDepth?: number }
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
  }));
  const resumed = (await ctx.suspend({ on: CHILD_DONE, correlationKey: childId })) as unknown as {
    output: TOut;
  };
  return resumed.output;
}

/**
 * From inside a parent flow: spawn every `children[i]` as a child execution CONCURRENTLY
 * and suspend until they ALL complete, returning their outputs positionally aligned with
 * `children` (NOT completion order). Still ONE suspend/resume cycle per parent — the
 * supervisor starts the whole group, collects each output, and resumes once with the
 * array — so it rides the single `_resumePayload` slot exactly like `awaitChild`.
 *
 * Replay-safe by the same mechanism: a SINGLE `ctx.decide` fixes the entire group
 * (every child id + spec), so a resume/recovery re-run never starts a second fan-out.
 * Child ids are `<parentId>::<group.key>#<i>` — one nesting level deeper than the parent,
 * so `maxDepth` (checked once; all members share the parent's depth + 1) bounds recursion
 * identically to the single-child path. Deterministic ids mean `group.key` and each item's
 * position, not wall-clock, decide identity — so the fan-out is crash-recoverable frame by
 * frame. An empty `children` resolves to `[]` without suspending (no members to await).
 *
 * A member that fails/cancels leaves the group unresolved and the parent suspended —
 * parallel failure propagation is the same documented follow-up as the single-child path.
 */
export async function awaitChildren<TOut = unknown>(
  ctx: Pick<ExecutionContext, "executionId" | "decide" | "suspend">,
  group: {
    key: string;
    children: readonly { flowId: string; input: unknown }[];
    maxDepth?: number;
  }
): Promise<TOut[]> {
  if (group.children.length === 0) return [];
  const groupId = childIdFor(ctx.executionId, group.key);
  const members: GroupMember[] = group.children.map((c, i) => ({
    // `#<i>` shares the child-id namespace with `awaitChild` keys; a group `key` must be
    // distinct from any sibling single-child key in the same parent (childIdFor already
    // forbids the `::` separator in the key, which is what protects `parentOf`).
    childId: childIdFor(ctx.executionId, `${group.key}#${i}`),
    flowId: c.flowId,
    input: c.input,
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
    outputs: TOut[];
  };
  return resumed.outputs;
}

export interface SupervisorDeps {
  runtime: WorkflowRuntime;
  /** Child flows by id, so the supervisor can start them by the recorded flowId. */
  flows: Record<string, RegisteredFlow>;
  /** Fired on a supervision failure (start/resume rejection). */
  onError?: (err: unknown) => void;
}

export interface ChildSupervisor {
  /** Wire this into `WorkflowRuntimeDeps.onEvent` (it sees every execution's events). */
  onEvent(event: EventEnvelope): void;
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
  const specs = new Map<string, { flowId: string; input: unknown }>();
  // childIds (and groupIds) already started this process (idempotency within the runtime).
  const started = new Set<string>();
  // groupId → live aggregation for a parallel spawn: its members, their outputs collected
  // positionally, and the count still outstanding. Learned from the group DECISION_RECORDED.
  const groups = new Map<
    string,
    { parentId: string; members: GroupMember[]; outputs: unknown[]; remaining: number }
  >();
  // member childId → (groupId, index), so a member's completion lands in the right slot.
  const memberOf = new Map<string, { groupId: string; index: number }>();

  const fail = (err: unknown): void => deps.onError?.(err);

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
      const s = await deps.runtime.loadState(parentId).catch(() => undefined);
      if (s?.status === "suspended") break;
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  // Resume the parent, retrying a transient "No execution found". A completed child proves
  // its parent exists and is suspended-on-CHILD_DONE, but under an async event store (e.g.
  // Postgres) a just-written suspend can briefly not be readable when the child completes
  // almost instantly — a read-after-write visibility gap the durability gate bounds but a
  // slower store can still exceed. Without the retry the resume throws and the parent hangs
  // forever. Bounded backoff (~1s) backstops the gate; a genuinely missing parent still
  // surfaces via onError after the retries. `payload` is `{ output }` for a single child or
  // `{ outputs }` for a group.
  const resumeParent = async (parentId: string, payload: unknown, attempt = 0): Promise<void> => {
    try {
      await deps.runtime.resume(parentId, { eventType: CHILD_DONE, payload });
    } catch (err) {
      const transient = err instanceof Error && /No execution found/.test(err.message);
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
          specs.set(single.childId, { flowId: single.flowId, input: single.input });
          return;
        }
        const group = asGroupChoice(choice);
        if (group !== undefined) {
          groups.set(group.groupId, {
            // groupId is `<parentId>::<key>`, so parentOf peels back to the parent.
            parentId: parentOf(group.groupId) ?? group.groupId,
            members: group.members,
            outputs: new Array<unknown>(group.members.length),
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
                .start(flow, member.input, { executionId: member.childId })
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
        started.add(childId);
        // Start the child only once the parent's suspend is DURABLE (see waitParentDurable).
        const parentId = parentOf(childId);
        void (async () => {
          await waitParentDurable(parentId);
          await deps.runtime.start(flow, spec.input, { executionId: childId }).catch(fail);
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

        // A group member terminating: route its output into the group's slot rather than
        // resuming the parent directly (the parent awaits the WHOLE group, not each child).
        const location = memberOf.get(execId);
        if (location !== undefined) {
          memberOf.delete(execId);
          started.delete(execId);
          const group = groups.get(location.groupId);
          if (group === undefined) return;
          if (event.eventType !== "EXECUTION_COMPLETED") {
            // A failed/cancelled member never fills its slot, so `remaining` never reaches
            // 0 and the parent stays suspended — parallel failure propagation is the same
            // documented follow-up as the single-child path. (The group is reclaimed when
            // the parent itself terminates, above.)
            return;
          }
          group.outputs[location.index] = (event.payload as { output?: unknown }).output;
          group.remaining -= 1;
          if (group.remaining === 0) {
            groups.delete(location.groupId);
            started.delete(location.groupId); // fan-out idempotency marker; group is done.
            // Outputs are positionally aligned with `children` (index order), NOT completion
            // order — the deterministic contract awaitChildren promises.
            void resumeParent(group.parentId, { outputs: group.outputs });
          }
          return;
        }

        if (!started.has(execId)) return;
        const parentId = parentOf(execId);
        if (event.eventType === "EXECUTION_COMPLETED" && parentId !== undefined) {
          const output = (event.payload as { output?: unknown }).output;
          void resumeParent(parentId, { output });
        }
        // Bound the supervisor's maps: once a child is terminal it needs no more
        // bookkeeping. (A failed/cancelled child leaves its parent suspended — failure
        // propagation is a documented follow-up — but the maps are still reclaimed.)
        specs.delete(execId);
        started.delete(execId);
      }
    },
  };
}
