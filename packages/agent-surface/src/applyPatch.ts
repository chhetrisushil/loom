import type { SurfacePatch, SurfaceState } from "./types";

// ── Immutable path helpers ────────────────────────────────────────────────────

function splitPath(path: string): string[] {
  return path === "" ? [] : path.split(".");
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
