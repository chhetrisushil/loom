// ── Transient folded state (user ruling 2026-10-14, ADR 0130 D7 / S5b) ───────────────────────
//
// The quarantine verbs on a node that cannot open the owner's checkpoint fold the owner from a log
// that may still contain SEALED payload values (kept as opaque ciphertext envelopes). That state is
// good for ONE thing: deciding the verb. It must never be journaled, returned, cached or written
// into a snapshot, because it holds ciphertext where a real fold holds values. It is therefore
// BRANDED (a module-private WeakSet, unforgeable by shape) and FROZEN, and every path that could
// persist or serve a state asserts the brand is absent.

const transient = new WeakSet<object>();

function deepFreeze<V>(v: V, seen = new WeakSet<object>()): V {
  if (typeof v !== "object" || v === null || seen.has(v)) return v;
  seen.add(v);
  for (const k of Reflect.ownKeys(v)) deepFreeze((v as Record<PropertyKey, unknown>)[k], seen);
  return Object.freeze(v);
}

/**
 * Brand a transient quarantine fold and freeze it DEEP. Returns a NEW object: its `variables` are a
 * private structured clone (so freezing never touches a structure shared with a snapshot store or a
 * replay seed), frozen all the way down, so no handler can mutate a ciphertext value into place.
 * The brand is on the returned object only: a spread copy loses it, which is why
 * `SealGuardedSnapshotStore.save` independently refuses a state whose `_waitAnswers` hold a
 * ciphertext envelope (`assertNoCipherAnswers`).
 */
export function markTransientFold<T extends object>(state: T): T {
  const src = state as { variables?: unknown };
  let variables: unknown;
  if (src.variables !== undefined) {
    try {
      variables = deepFreeze(structuredClone(src.variables));
    } catch (err) {
      // A value structuredClone cannot copy (a function, a symbol key's owner...) is not foldable.
      throw new Error(
        `a quarantine fold holds a value that cannot be copied (${err instanceof Error ? err.message : String(err)}); the verb cannot decide on it`
      );
    }
  }
  const copy = { ...state, ...(variables !== undefined && { variables }) } as T;
  transient.add(copy);
  return Object.freeze(copy);
}

/** True iff `state` is (the very object of) a transient quarantine fold. */
export function isTransientFold(state: unknown): boolean {
  return typeof state === "object" && state !== null && transient.has(state);
}

/** Throw if `state` is a transient fold; `where` names the path that refused it. */
export function assertNotTransientFold(state: unknown, where: string): void {
  if (isTransientFold(state)) {
    throw new Error(
      `a transient quarantine fold (folded past sealed payloads) cannot be used for ${where}; it only decides an operator verb`
    );
  }
}
