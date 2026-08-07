// ── Q5 — the structural diff (there is no existing one to reuse) ──────────────
//
// Checked before building: `packages/agent-surface/src/applyPatch.ts` is a path-based
// immutable *update* over `SurfacePatch`, not a differ, and `resolvePath`
// (`@loom/blueprint-runtime`, ADR 0068) resolves a single dot-path. Neither diffs two
// values. So one small differ lives here, shared by IX-2 and IX-3.
//
// Three properties this must have, all of them load-bearing against hostile or merely
// pathological state (an `ExecutionState.variables` is arbitrary user data folded from
// a log — the inspector does not get to assume it is well-shaped):
//
//   1. ITERATIVE. An explicit work stack, never recursion. Deeply nested state must
//      not blow the JS stack — a crash here is a denial of the debugging tool exactly
//      when the execution is weird enough to need it.
//   2. CYCLE-SAFE. State reaching the inspector has been through a fold, not
//      necessarily through JSON. A self-referential object must terminate, not hang.
//      Handled by memoising visited (a, b) PAIRS: revisiting a pair means that subtree
//      was already accounted for, which collapses cycles and shared subgraphs alike.
//   3. BOUNDED. Depth and output size are capped, and hitting either is REPORTED.
//      Silent truncation would present a partial diff as a complete one.
//
// Prototype-pollution is structurally impossible here rather than defended against:
// the output is a flat array of `{ path, kind }` records, so no user-controlled string
// is ever used as a write key. Reads use `Object.keys` (own, enumerable) so an
// inherited or `__proto__` key cannot enter a path. This mirrors the kernel fold's own
// `assertSafeKey` discipline in `@loom/replay-vm`.

export type ChangeKind = "added" | "removed" | "changed";

export interface StateChange {
  /**
   * Path segments from the diff root. Segments, not a dotted string: a key may itself
   * contain a dot, and joining would make `{"a.b": 1}` and `{a: {b: 1}}` indistinguishable.
   * Render with {@link formatPath} when a display string is wanted.
   */
  readonly path: readonly string[];
  readonly kind: ChangeKind;
  readonly before?: unknown;
  readonly after?: unknown;
}

export type TruncationReason = "depth" | "size";

export interface DiffResult {
  readonly changes: readonly StateChange[];
  /** True when the walk stopped early. `changes` is then a PREFIX, not the whole diff. */
  readonly truncated: boolean;
  readonly truncationReason?: TruncationReason;
}

export interface DiffOptions {
  /**
   * Maximum nesting depth to descend. Default 64 — the same order as the kernel's
   * depth-capped `stableStringify` (W8 audit). Beyond it the node is reported as a
   * single `changed` leaf rather than descended into.
   */
  maxDepth?: number;
  /** Maximum number of changes to emit before stopping. Default 10_000. */
  maxChanges?: number;
}

const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_CHANGES = 10_000;

/** Render a path for display. Segments containing `.` or `\` are escaped, so the
 *  rendering is injective — two different paths never render identically. */
export function formatPath(path: readonly string[]): string {
  return path.map((s) => s.replace(/\\/g, "\\\\").replace(/\./g, "\\.")).join(".");
}

/** A plain object or array — the only shapes we descend into. */
function isTraversable(v: unknown): v is Record<string, unknown> | unknown[] {
  if (typeof v !== "object" || v === null) return false;
  if (Array.isArray(v)) return true;
  // Only plain objects. A class instance, Map, Set, Date, RegExp, … is an opaque leaf:
  // descending into one would report internal slots as state, which is noise at best
  // and misleading at worst.
  const proto = Object.getPrototypeOf(v) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Leaf equality. `Object.is` plus the one non-plain case that genuinely recurs in
 * folded state — `Date` — compared by instant rather than by identity, so two equal
 * timestamps do not read as a change.
 */
function leafEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return false;
}

/**
 * Work items. `added`/`removed` are enqueued as ready-made emissions rather than
 * pushed straight onto `changes`, so EVERY change — shallow or deep — leaves the
 * stack in the same order. Emitting immediately while deferring comparisons would
 * interleave a node's own added/removed keys with its siblings' descendants, and the
 * output would no longer be in depth-first sorted-path order.
 */
type Work =
  | { readonly t: "compare"; a: unknown; b: unknown; path: readonly string[]; depth: number }
  | { readonly t: "emit"; change: StateChange };

/**
 * Structural diff of two folded states. Deterministic: keys are visited in sorted
 * order, so the same pair always yields the same change sequence (P2 — an inspector
 * that renders differently on two runs over one log is not a debugging tool).
 *
 * Cost is O(n log k) in the number of visited nodes (n) with k keys per node, and
 * memory is O(visited pairs + emitted changes), both bounded by the caps.
 */
export function diffState(before: unknown, after: unknown, options: DiffOptions = {}): DiffResult {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxChanges = options.maxChanges ?? DEFAULT_MAX_CHANGES;

  const changes: StateChange[] = [];
  // Pair memo: `a`-object → set of `b`-objects already enqueued against it. Collapses
  // cycles AND shared subgraphs. Keyed by object identity; both maps are per-call and
  // dropped on return, so nothing is retained across invocations.
  const seen = new Map<object, Set<object>>();
  // LIFO stack; children are pushed in DESCENDING key order so they pop ascending.
  const stack: Work[] = [{ t: "compare", a: before, b: after, path: [], depth: 0 }];

  let truncationReason: TruncationReason | undefined;

  while (stack.length > 0) {
    if (changes.length >= maxChanges) {
      truncationReason = "size";
      break;
    }
    const work = stack.pop() as Work;
    if (work.t === "emit") {
      changes.push(work.change);
      continue;
    }
    const { a, b, path, depth } = work;

    if (leafEqual(a, b)) continue;

    const bothTraversable = isTraversable(a) && isTraversable(b);
    // Arrays and objects are different shapes; a switch between them is a whole-node
    // change, not a key-wise merge.
    const sameShape = bothTraversable && Array.isArray(a as object) === Array.isArray(b as object);

    if (!sameShape || depth >= maxDepth) {
      if (bothTraversable && depth >= maxDepth) truncationReason ??= "depth";
      changes.push({ path, kind: "changed", before: a, after: b });
      continue;
    }

    const ao = a as object;
    const bo = b as object;
    let bs = seen.get(ao);
    if (bs === undefined) {
      bs = new Set<object>();
      seen.set(ao, bs);
    } else if (bs.has(bo)) {
      // Already compared this exact pair: a cycle, or a shared subgraph. Either way
      // its differences are already in `changes` — re-walking would duplicate or hang.
      continue;
    }
    bs.add(bo);

    if (Array.isArray(ao) && Array.isArray(bo)) {
      const len = Math.max(ao.length, bo.length);
      // Push descending so the smallest index pops first.
      for (let i = len - 1; i >= 0; i--) {
        const inA = i < ao.length;
        const inB = i < bo.length;
        const childPath = [...path, String(i)];
        if (!inA)
          stack.push({ t: "emit", change: { path: childPath, kind: "added", after: bo[i] } });
        else if (!inB)
          stack.push({ t: "emit", change: { path: childPath, kind: "removed", before: ao[i] } });
        else stack.push({ t: "compare", a: ao[i], b: bo[i], path: childPath, depth: depth + 1 });
      }
      continue;
    }

    const ar = ao as Record<string, unknown>;
    const br = bo as Record<string, unknown>;
    // Sorted union of OWN ENUMERABLE keys. `Object.keys` never surfaces inherited or
    // `__proto__` names, so a poisoned prototype cannot inject a path segment.
    const keys = new Set<string>(Object.keys(ar));
    for (const k of Object.keys(br)) keys.add(k);
    const sorted = [...keys].sort();

    for (let i = sorted.length - 1; i >= 0; i--) {
      const k = sorted[i] as string;
      const inA = Object.hasOwn(ar, k);
      const inB = Object.hasOwn(br, k);
      const childPath = [...path, k];
      if (!inA) stack.push({ t: "emit", change: { path: childPath, kind: "added", after: br[k] } });
      else if (!inB)
        stack.push({ t: "emit", change: { path: childPath, kind: "removed", before: ar[k] } });
      else stack.push({ t: "compare", a: ar[k], b: br[k], path: childPath, depth: depth + 1 });
    }
  }

  // Narrowed rather than spread: `exactOptionalPropertyTypes` treats an explicit
  // `truncationReason: undefined` as distinct from an absent key.
  if (truncationReason !== undefined) return { changes, truncated: true, truncationReason };
  return { changes, truncated: false };
}
