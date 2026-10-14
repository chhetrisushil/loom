// ── Transient folded state (user ruling 2026-10-14, ADR 0130 D7 / S5b) ───────────────────────
//
// The quarantine verbs on a node that cannot open the owner's checkpoint fold the owner from a log
// that may still contain SEALED payload values (kept as opaque ciphertext envelopes). That state is
// good for ONE thing: deciding the verb. It must never be journaled, returned, cached or written
// into a snapshot, because it holds ciphertext where a real fold holds values. It is therefore
// BRANDED (a module-private WeakSet, unforgeable by shape) and FROZEN, and every path that could
// persist or serve a state asserts the brand is absent.

const transient = new WeakSet<object>();

/** Brand `state` as a transient quarantine fold and freeze it (shallow). Returns the same object. */
export function markTransientFold<T extends object>(state: T): T {
  transient.add(state);
  return Object.freeze(state);
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
