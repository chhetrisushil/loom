/**
 * How a store decorator handles one OPTIONAL SPI method of the store it wraps (ADR 0074
 * Amendment, L1):
 *
 * - `"forward"` — call the inner store's method verbatim (bound to the inner store);
 * - a function — the decorator's own implementation (it transforms ids, payloads, …);
 * - `{ refuse: reason }` — deliberately NOT offered, with the reason recorded. The method is
 *   left uninstalled, so callers see exactly what they see for a store without it.
 *
 * What the compiler enforces: every key in `M` is REQUIRED (`-?` strips the `?` a mapped type
 * over `S` would otherwise inherit from the optional SPI methods). So a decorator whose plan is
 * `satisfies DecoratorPlan<EventStore, OptionalEventStoreMethod>` fails to compile if it omits
 * any optional method — including one added to the SPI later, since `OptionalEventStoreMethod`
 * is derived from the interface. Pinned by `decoratorPlan.typecheck.ts`, which `pnpm typecheck`
 * checks. What it cannot enforce: that a decorator uses a plan at all — that is the decorator
 * conformance kit's job, and the `packages/spec` fitness test makes every decorator run it.
 */
export type DecoratorPlan<S, M extends keyof S> = {
  readonly [K in M]-?: "forward" | NonNullable<S[K]> | { readonly refuse: string };
};

// Refusals, keyed by the decorated object. A WeakMap so a discarded store takes its entry
// with it; read back by the decorator conformance kit through `refusalsOf`.
const refusals = new WeakMap<object, ReadonlyMap<string, string>>();

/**
 * The encryption-boundary marker a store exposes structurally (`EncryptingEventStore.keys`,
 * `EncryptingSnapshotStore.keys`). `loom doctor` and `LogLifecycle`'s compaction/archive
 * guard read it by shape, so a decorator stacked ABOVE an encrypting store must carry it up —
 * otherwise `Coalescing(Encrypting(pg))` looks like a plain store and compaction would write
 * the decrypted fold to a plaintext snapshot store (ADR 0022 Amendment).
 */
const ENCRYPTION_MARKER = "keys";
/** `EncryptingSnapshotStore.sealsWholeState` (ADR 0130 D8), carried up the same way. */
const WHOLE_STATE_MARKER = "sealsWholeState";

/**
 * Install each optional method of `plan` on `target`, **iff the inner store has it** — so a
 * capability probe (`if (store.copyPrefix)`) answers exactly as it would against `inner`,
 * and a decorator never advertises a capability its backend lacks. O(|M|) once, at
 * construction; zero cost per call (a forward is a bound method, not a trampoline).
 *
 * A function entry is bound to `bindTo` when given (a decorator whose implementation uses
 * `this`), else installed as-is. `{ refuse }` entries are recorded for {@link refusalsOf}.
 *
 * Also carries the inner store's structural encryption marker (`keys`) onto `target` when
 * `target` does not define its own — see {@link ENCRYPTION_MARKER}.
 */
export function installOptional<S extends object, M extends keyof S>(
  target: S,
  inner: S,
  plan: DecoratorPlan<S, M>,
  bindTo?: object
): void {
  const writable = target as Record<PropertyKey, unknown>;
  const source = inner as Record<PropertyKey, unknown>;
  let refused: Map<string, string> | undefined;
  for (const method of Object.keys(plan) as M[]) {
    const entry = plan[method] as unknown;
    if (typeof entry === "object" && entry !== null) {
      refused ??= new Map();
      refused.set(String(method), (entry as { refuse: string }).refuse);
      continue;
    }
    const innerMethod = source[method as PropertyKey];
    if (typeof innerMethod !== "function") continue; // the backend lacks it: so do we
    if (entry === "forward") {
      writable[method as PropertyKey] = (innerMethod as (...a: unknown[]) => unknown).bind(inner);
    } else if (typeof entry === "function") {
      writable[method as PropertyKey] =
        bindTo === undefined ? entry : (entry as (...a: unknown[]) => unknown).bind(bindTo);
    }
  }
  if (refused !== undefined) refusals.set(target, refused);
  const marker = source[ENCRYPTION_MARKER];
  if (typeof marker === "object" && marker !== null && writable[ENCRYPTION_MARKER] === undefined) {
    writable[ENCRYPTION_MARKER] = marker;
  }
  // ADR 0130 D8 — a snapshot store that seals its WHOLE state says so structurally; a decorator
  // above it must not hide that (the doctor / kernel would read a sealed store as plaintext).
  if (source[WHOLE_STATE_MARKER] === true && writable[WHOLE_STATE_MARKER] === undefined) {
    writable[WHOLE_STATE_MARKER] = true;
  }
}

/**
 * The optional methods a decorator deliberately refused through {@link installOptional},
 * with their reasons. Empty for a store that refused nothing (or did not use the helper).
 */
export function refusalsOf(store: object): ReadonlyMap<string, string> {
  return refusals.get(store) ?? new Map();
}
