import type { SurfacePatch, SurfaceState } from "./types";

// ── Immutable path helpers ────────────────────────────────────────────────────

function splitPath(path: string): string[] {
  return path === "" ? [] : path.split(".");
}

// Reserved keys, matching the kernel fold's `RESERVED_FOLD_KEYS`
// (`replay-vm/src/eventHandlers.ts`). The writers below use the assignment form
// (`clone[head] = …`) on a plain object, so `clone["__proto__"] = x` would invoke the
// prototype setter and re-parent that state object — after which every later property
// lookup on it traverses a value that came in over the wire.
//
// It matters here specifically because this is the CONSUMER side: patches arrive as
// SURFACE_PATCH event payloads, and a surface can be fed from outside the process
// (the A2UI ingress path, MCP apps). The kernel fold already refuses these keys; this
// standalone folder folds the same events and must agree.
//
// Unlike the kernel, which throws, an unsafe path is a NO-OP: this module's contract is
// "pure and total — an unknown op is a no-op so forward-compatible producers never crash a
// consumer", and a UI store must not be crashable by a malformed patch.
const RESERVED_PATH_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function hasReservedSegment(parts: readonly string[]): boolean {
  for (const part of parts) if (RESERVED_PATH_KEYS.has(part)) return true;
  return false;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getIn(state: SurfaceState, parts: string[]): unknown {
  let current: unknown = state;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// Returns a shallow-cloned copy of `state` with `parts` set to the result of
// `update(existing)`. Clones every object along the path so callers never mutate
// the previous state (structural sharing everywhere else).
function updateIn(
  state: SurfaceState,
  parts: string[],
  update: (existing: unknown) => unknown
): SurfaceState {
  if (parts.length === 0) {
    return asRecord(update(state));
  }
  const [head, ...rest] = parts;
  if (head === undefined) return state;
  const clone: Record<string, unknown> = { ...state };
  if (rest.length === 0) {
    clone[head] = update(clone[head]);
  } else {
    clone[head] = updateIn(asRecord(clone[head]), rest, update);
  }
  return clone;
}

function removeIn(state: SurfaceState, parts: string[]): SurfaceState {
  if (parts.length === 0) return {};
  const [head, ...rest] = parts;
  if (head === undefined) return state;
  const clone: Record<string, unknown> = { ...state };
  if (rest.length === 0) {
    delete clone[head];
  } else if (clone[head] !== undefined) {
    clone[head] = removeIn(asRecord(clone[head]), rest);
  }
  return clone;
}

// ── Patch application ─────────────────────────────────────────────────────────

// Applies one patch to the surface, returning a new state. Pure and total: an
// unknown op is a no-op so forward-compatible producers never crash a consumer.
//
// `owned` tracks arrays *created during the current batch*. Appending to a
// batch-owned array mutates it in place (O(1)) instead of copying it — so a batch
// with k appends to one list is O(k) not O(k²). This is safe: the input state's
// arrays are never in `owned`, so previous states are never mutated (cross-batch
// immutability is preserved); only arrays this batch just created are pushed to.
function applyOne(state: SurfaceState, patch: SurfacePatch, owned: WeakSet<object>): SurfaceState {
  const parts = splitPath(patch.path);
  // Drop the whole patch rather than sanitising the path: a patch that names a reserved
  // key is malformed, and silently retargeting it somewhere else would be worse.
  if (hasReservedSegment(parts)) return state;
  switch (patch.op) {
    case "set":
      return updateIn(state, parts, () => patch.value);
    case "merge":
      return updateIn(state, parts, (existing) => ({ ...asRecord(existing), ...patch.value }));
    case "append":
      return updateIn(state, parts, (existing) => {
        if (Array.isArray(existing) && owned.has(existing)) {
          existing.push(patch.value);
          return existing;
        }
        const next = Array.isArray(existing) ? [...existing, patch.value] : [patch.value];
        owned.add(next);
        return next;
      });
    case "increment":
      return updateIn(
        state,
        parts,
        (existing) => (typeof existing === "number" ? existing : 0) + (patch.by ?? 1)
      );
    case "remove":
      return removeIn(state, parts);
    default:
      return state;
  }
}

export function applySurfacePatch(state: SurfaceState, patch: SurfacePatch): SurfaceState {
  return applyOne(state, patch, new WeakSet());
}

export function applySurfacePatches(
  state: SurfaceState,
  patches: readonly SurfacePatch[]
): SurfaceState {
  const owned = new WeakSet<object>();
  let next = state;
  for (const patch of patches) next = applyOne(next, patch, owned);
  return next;
}

export { getIn as getSurfaceValue };
