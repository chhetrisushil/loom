// ── R16 - an id namespace is claimed once per execution context ──────────────────────────────────
//
// A decision id (`<planId>:plan`) or step id (`<planId>:<node>`) is served from the log by NAME. Two
// plans that share a namespace in one run would silently get each other's recorded result (the second
// `planGoal` served the first's plan with no model call; the second `executePlan` served the first's
// outputs). So a namespace is claimed per context, and a second claim throws. The map is keyed by the
// context object, which is fresh on every run and every replay, so the check is deterministic: the
// same body claims the same ids in the same order on every re-run.

const claims = new WeakMap<object, Set<string>>();

/** Thrown when an id namespace is used twice in one execution context. */
export class IdReusedError extends Error {
  readonly kind: string;
  readonly id: string;
  constructor(kind: string, id: string) {
    super(
      `${kind} id "${id.slice(0, 80)}" was already used in this execution: give each call its own id (a reused id would be served the first call's recorded result)`
    );
    this.name = "IdReusedError";
    this.kind = kind;
    this.id = id;
    Object.setPrototypeOf(this, IdReusedError.prototype);
  }
}

export function claimId(ctx: object, kind: string, id: string): void {
  let set = claims.get(ctx);
  if (set === undefined) {
    set = new Set();
    claims.set(ctx, set);
  }
  const key = `${kind}\0${id}`;
  if (set.has(key)) throw new IdReusedError(kind, id);
  set.add(key);
}
