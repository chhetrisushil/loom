// ── R16 (ADR 0123) — the goal store ─────────────────────────────────────────────────────────────
//
// A goal outlives the execution that pursues it: it may span many runs, a continue-as-new chain
// (ADR 0109) and process restarts. So it is held in a durable keyed store, not in an execution's
// folded state, and it is addressed by `(owner, id)`: an owner's goals live in their own namespace,
// and another owner's id is indistinguishable from a missing one (no existence oracle).
//
// The store is a plain async SPI (`GoalStore`) with two implementations here:
//   - `InMemoryGoalStore` (tests, single process);
//   - `DurableGoalStore`, over any compare-and-set keyed store. `DurableStateStore` from
//     `@loom/plugin-durable-state` (SQLite/Postgres backends exist) satisfies `GoalKvStore`
//     structurally, so this package takes no dependency on the plugin tier.
//
// Flow code never calls the store directly (a store read is not replayable). It goes through
// `goalEffects(store)` — registered effects, so every result is journaled and a replay folds the
// recorded value — and the OWNER comes from the execution's authenticated principal (ADR 0111),
// never from an argument a flow, a model or a plan could supply.

export type GoalStatus = "open" | "active" | "done" | "failed" | "abandoned";

export interface Goal {
  id: string;
  /** Opaque; set by the store from the owner. Never accepted from input. */
  owner: string;
  parentId?: string;
  title: string;
  status: GoalStatus;
  /** Bumped on every change; pass it back as `expectedRevision` for compare-and-set. */
  revision: number;
  /** Monotone per-owner creation ordinal (no clock: replay-safe, deterministic ordering). */
  seq: number;
  /** Short free text recorded with the last status change (bounded). */
  note?: string;
  /** What the last pursuit of this goal ended in, written by {@link runGoal}. */
  lastRun?: { status: "completed" | "failed" | "stopped"; replans: number; error?: string };
}

/** Per-call options for a store write. */
export interface GoalWriteOptions {
  /**
   * A write carrying a key already applied returns the ORIGINAL result and changes nothing, so an
   * effect re-driven after a crash (the same `EffectContext.idempotencyKey`) is not applied twice.
   */
  idempotencyKey?: string;
}

export interface CreateGoalInput {
  /** Unique per owner: `^[A-Za-z][A-Za-z0-9._-]{0,63}$`. */
  id: string;
  title: string;
  /** Must be an existing goal of the SAME owner. */
  parentId?: string;
}

export interface GoalFilter {
  status?: GoalStatus;
  /** `null` ⇒ top-level goals only; a string ⇒ that goal's direct children. */
  parentId?: string | null;
}

export interface SetStatusInput {
  id: string;
  status: GoalStatus;
  note?: string;
  expectedRevision?: number;
  lastRun?: Goal["lastRun"];
}

export class GoalNotFoundError extends Error {
  constructor(id: string) {
    super(`no goal "${id.slice(0, 80)}"`);
    this.name = "GoalNotFoundError";
    Object.setPrototypeOf(this, GoalNotFoundError.prototype);
  }
}
/** The caller has no owner identity (fail closed), or the owner is unusable. */
export class GoalAccessDeniedError extends Error {
  constructor(why: string) {
    super(`goal access denied: ${why}`);
    this.name = "GoalAccessDeniedError";
    Object.setPrototypeOf(this, GoalAccessDeniedError.prototype);
  }
}
export class GoalTransitionError extends Error {
  constructor(from: GoalStatus, to: GoalStatus) {
    super(`illegal goal transition ${from} -> ${to}`);
    this.name = "GoalTransitionError";
    Object.setPrototypeOf(this, GoalTransitionError.prototype);
  }
}
export class GoalConflictError extends Error {
  constructor(why: string) {
    super(`goal conflict: ${why}`);
    this.name = "GoalConflictError";
    Object.setPrototypeOf(this, GoalConflictError.prototype);
  }
}
export class GoalLimitError extends Error {
  constructor(why: string) {
    super(`goal limit: ${why}`);
    this.name = "GoalLimitError";
    Object.setPrototypeOf(this, GoalLimitError.prototype);
  }
}

export interface GoalStore {
  create(owner: string, input: CreateGoalInput, opts?: GoalWriteOptions): Promise<Goal>;
  get(owner: string, id: string): Promise<Goal>;
  list(owner: string, filter?: GoalFilter): Promise<Goal[]>;
  setStatus(owner: string, input: SetStatusInput, opts?: GoalWriteOptions): Promise<Goal>;
  /**
   * Recompute `id`'s status from its children and walk up through its ancestors: all children done
   * ⇒ done; any child active ⇒ active; every child terminal with a failure ⇒ failed; abandoned
   * children are ignored (all abandoned ⇒ abandoned). A goal with no children is left alone.
   */
  rollup(owner: string, id: string, opts?: GoalWriteOptions): Promise<Goal>;
}

export const GOAL_LIMITS = Object.freeze({
  maxGoalsPerOwner: 1000,
  maxDepth: 8,
  maxTitleChars: 500,
  maxNoteChars: 300,
  maxOwnerChars: 256,
});

const GOAL_ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

const ALLOWED: Readonly<Record<GoalStatus, readonly GoalStatus[]>> = {
  open: ["active", "done", "abandoned", "failed"],
  active: ["open", "done", "failed", "abandoned"],
  failed: ["active", "open", "abandoned"],
  done: [],
  abandoned: [],
};

export function canTransition(from: GoalStatus, to: GoalStatus): boolean {
  return from === to || ALLOWED[from].includes(to);
}

interface OwnerDoc {
  seq: number;
  goals: Goal[];
  /** The last {@link MAX_APPLIED} idempotency keys and their results. */
  applied?: Array<{ key: string; result: Goal }>;
}

const MAX_APPLIED = 64;

/** Apply `fn` unless `key` was already applied, in which case return the original result. */
function once(doc: OwnerDoc, key: string | undefined, fn: () => Goal): Goal {
  if (key === undefined) return fn();
  const hit = doc.applied?.find((a) => a.key === key);
  if (hit !== undefined) return structuredClone(hit.result);
  const g = fn();
  const applied = (doc.applied ??= []);
  applied.push({ key: key.slice(0, 200), result: structuredClone(g) });
  if (applied.length > MAX_APPLIED) applied.shift();
  return g;
}

function checkOwner(owner: unknown): string {
  if (typeof owner !== "string" || owner.length === 0 || owner.length > GOAL_LIMITS.maxOwnerChars) {
    throw new GoalAccessDeniedError("a goal owner is a non-empty string");
  }
  return owner;
}

/** Pure operations over one owner's document; both stores run these under their own atomicity. */
const ops = {
  create(doc: OwnerDoc, owner: string, input: CreateGoalInput): Goal {
    if (typeof input?.id !== "string" || !GOAL_ID.test(input.id)) {
      throw new GoalConflictError(`goal id must match ${GOAL_ID.source}`);
    }
    if (
      typeof input.title !== "string" ||
      input.title.length === 0 ||
      input.title.length > GOAL_LIMITS.maxTitleChars
    ) {
      throw new GoalLimitError(`title must be 1..${GOAL_LIMITS.maxTitleChars} characters`);
    }
    if (doc.goals.length >= GOAL_LIMITS.maxGoalsPerOwner) {
      throw new GoalLimitError(`more than ${GOAL_LIMITS.maxGoalsPerOwner} goals`);
    }
    if (doc.goals.some((g) => g.id === input.id)) {
      throw new GoalConflictError(`goal "${input.id}" exists`);
    }
    if (input.parentId !== undefined) {
      const parent = doc.goals.find((g) => g.id === input.parentId);
      if (parent === undefined) throw new GoalNotFoundError(input.parentId);
      let depth = 1;
      for (let p: Goal | undefined = parent; p?.parentId !== undefined; depth++) {
        p = doc.goals.find((g) => g.id === p?.parentId);
      }
      if (depth >= GOAL_LIMITS.maxDepth) throw new GoalLimitError("subgoals nest too deeply");
      if (parent.status === "done" || parent.status === "abandoned") {
        throw new GoalTransitionError(parent.status, "open");
      }
    }
    const goal: Goal = {
      id: input.id,
      owner,
      ...(input.parentId !== undefined && { parentId: input.parentId }),
      title: input.title,
      status: "open",
      revision: 1,
      seq: ++doc.seq,
    };
    doc.goals.push(goal);
    return goal;
  },
  get(doc: OwnerDoc, id: string): Goal {
    const g = doc.goals.find((x) => x.id === id);
    if (g === undefined) throw new GoalNotFoundError(id);
    return g;
  },
  list(doc: OwnerDoc, f: GoalFilter = {}): Goal[] {
    return doc.goals
      .filter(
        (g) =>
          (f.status === undefined || g.status === f.status) &&
          (f.parentId === undefined ||
            (f.parentId === null ? g.parentId === undefined : g.parentId === f.parentId))
      )
      .sort((a, b) => a.seq - b.seq);
  },
  setStatus(doc: OwnerDoc, input: SetStatusInput): Goal {
    const g = ops.get(doc, input.id);
    if (input.expectedRevision !== undefined && input.expectedRevision !== g.revision) {
      throw new GoalConflictError(`revision ${g.revision} != expected ${input.expectedRevision}`);
    }
    if (!canTransition(g.status, input.status))
      throw new GoalTransitionError(g.status, input.status);
    if (input.lastRun !== undefined) checkLastRun(input.lastRun);
    g.status = input.status;
    g.revision++;
    if (input.note !== undefined) g.note = String(input.note).slice(0, GOAL_LIMITS.maxNoteChars);
    if (input.lastRun !== undefined) g.lastRun = input.lastRun;
    return g;
  },
  rollup(doc: OwnerDoc, id: string): Goal {
    let cur = ops.get(doc, id);
    // Children index once per call: O(n) for the whole walk.
    const kids = new Map<string, Goal[]>();
    for (const g of doc.goals) {
      if (g.parentId !== undefined) {
        const l = kids.get(g.parentId);
        if (l) l.push(g);
        else kids.set(g.parentId, [g]);
      }
    }
    for (;;) {
      const children = kids.get(cur.id) ?? [];
      if (children.length > 0) {
        const live = children.filter((c) => c.status !== "abandoned");
        let next: GoalStatus;
        if (live.length === 0) next = "abandoned";
        else if (live.every((c) => c.status === "done")) next = "done";
        else if (live.some((c) => c.status === "active")) next = "active";
        else if (live.every((c) => c.status === "done" || c.status === "failed")) next = "failed";
        else next = cur.status === "failed" ? "open" : cur.status === "done" ? "done" : "open";
        if (next !== cur.status && canTransition(cur.status, next)) {
          cur.status = next;
          cur.revision++;
        }
      }
      if (cur.parentId === undefined) return ops.get(doc, id);
      cur = ops.get(doc, cur.parentId);
    }
  },
};

function checkLastRun(r: unknown): void {
  const o = r as Goal["lastRun"] | null;
  const bad = (why: string): never => {
    throw new GoalLimitError(`lastRun ${why}`);
  };
  if (typeof o !== "object" || o === null) return bad("must be an object");
  if (!["completed", "failed", "stopped"].includes(o.status)) bad("has an unknown status");
  if (!Number.isInteger(o.replans) || o.replans < 0 || o.replans > 1_000_000)
    bad("replans is out of range");
  if (
    o.error !== undefined &&
    (typeof o.error !== "string" || o.error.length > GOAL_LIMITS.maxNoteChars)
  ) {
    bad("error must be a short string");
  }
  if (Object.keys(o).some((k) => !["status", "replans", "error"].includes(k)))
    bad("has unknown fields");
}

const clone = <T>(v: T): T => structuredClone(v);

export class InMemoryGoalStore implements GoalStore {
  private readonly docs = new Map<string, OwnerDoc>();
  /** A read never creates an owner's document. */
  private peek(owner: string): OwnerDoc {
    return this.docs.get(checkOwner(owner)) ?? { seq: 0, goals: [] };
  }
  private write<T>(owner: string, fn: (doc: OwnerDoc) => T): T {
    // Mutate a copy so a refused write leaves the stored document untouched.
    const copy = clone(this.peek(owner));
    const out = fn(copy);
    this.docs.set(owner, copy);
    return clone(out);
  }
  async create(owner: string, input: CreateGoalInput, opts?: GoalWriteOptions): Promise<Goal> {
    return this.write(owner, (d) =>
      once(d, opts?.idempotencyKey, () => ops.create(d, owner, input))
    );
  }
  async get(owner: string, id: string): Promise<Goal> {
    return clone(ops.get(this.peek(owner), id));
  }
  async list(owner: string, filter?: GoalFilter): Promise<Goal[]> {
    return clone(ops.list(this.peek(owner), filter));
  }
  async setStatus(owner: string, input: SetStatusInput, opts?: GoalWriteOptions): Promise<Goal> {
    return this.write(owner, (d) => once(d, opts?.idempotencyKey, () => ops.setStatus(d, input)));
  }
  async rollup(owner: string, id: string, opts?: GoalWriteOptions): Promise<Goal> {
    return this.write(owner, (d) => once(d, opts?.idempotencyKey, () => ops.rollup(d, id)));
  }
}

/** A compare-and-set keyed store. `DurableStateStore` (`@loom/plugin-durable-state`) satisfies it. */
export interface GoalKvStore {
  load(key: string): Promise<{ revision: number; payload: unknown } | null>;
  save(
    key: string,
    value: { contractVersion: number; payload: unknown },
    expectedRevision: number
  ): Promise<{ revision: number }>;
}

const CONTRACT = 1;
const MAX_CAS_ATTEMPTS = 8;

/**
 * Goals over a CAS key-value store: one document per owner under `loom.goals/<owner>`. Every
 * mutation is load → pure change → `save(expectedRevision)`, retried on a lost race (bounded), so two
 * processes can share a store. The key embeds the owner percent-encoded; it is derived from the
 * authenticated principal, not from caller text.
 */
export class DurableGoalStore implements GoalStore {
  constructor(private readonly kv: GoalKvStore) {}

  private key(owner: string): string {
    return `loom.goals/${encodeURIComponent(checkOwner(owner))}`;
  }

  private async load(owner: string): Promise<{ doc: OwnerDoc; revision: number }> {
    const rec = await this.kv.load(this.key(owner));
    if (rec === null) return { doc: { seq: 0, goals: [] }, revision: 0 };
    const p = rec.payload as OwnerDoc;
    if (
      typeof p !== "object" ||
      p === null ||
      !Array.isArray(p.goals) ||
      typeof p.seq !== "number"
    ) {
      throw new GoalConflictError("stored goal document is malformed");
    }
    // The key is the owner's namespace; a record that names another owner is corrupt: refuse it.
    for (const g of p.goals) {
      if (g.owner !== owner)
        throw new GoalAccessDeniedError("stored goal belongs to another owner");
    }
    return { doc: p, revision: rec.revision };
  }

  private async mutate<T>(owner: string, fn: (doc: OwnerDoc) => T): Promise<T> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const { doc, revision } = await this.load(owner);
      const out = fn(doc);
      try {
        await this.kv.save(this.key(owner), { contractVersion: CONTRACT, payload: doc }, revision);
        return clone(out);
      } catch (e) {
        if ((e as Error)?.name === "RevisionConflictError") continue;
        throw e;
      }
    }
    throw new GoalConflictError("too many concurrent writers");
  }

  create(owner: string, input: CreateGoalInput, opts?: GoalWriteOptions): Promise<Goal> {
    return this.mutate(owner, (d) =>
      once(d, opts?.idempotencyKey, () => ops.create(d, owner, input))
    );
  }
  async get(owner: string, id: string): Promise<Goal> {
    return clone(ops.get((await this.load(owner)).doc, id));
  }
  async list(owner: string, filter?: GoalFilter): Promise<Goal[]> {
    return clone(ops.list((await this.load(owner)).doc, filter));
  }
  setStatus(owner: string, input: SetStatusInput, opts?: GoalWriteOptions): Promise<Goal> {
    return this.mutate(owner, (d) => once(d, opts?.idempotencyKey, () => ops.setStatus(d, input)));
  }
  rollup(owner: string, id: string, opts?: GoalWriteOptions): Promise<Goal> {
    return this.mutate(owner, (d) => once(d, opts?.idempotencyKey, () => ops.rollup(d, id)));
  }
}
