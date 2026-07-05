import type { A2UIPatch, A2UISurfaceState } from "./types";

// ── Immutable path helpers ────────────────────────────────────────────────────

function splitPath(path: string): string[] {
  return path === "" ? [] : path.split(".");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getIn(state: A2UISurfaceState, parts: string[]): unknown {
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
  state: A2UISurfaceState,
  parts: string[],
  update: (existing: unknown) => unknown
): A2UISurfaceState {
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

function removeIn(state: A2UISurfaceState, parts: string[]): A2UISurfaceState {
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
export function applyA2UIPatch(state: A2UISurfaceState, patch: A2UIPatch): A2UISurfaceState {
  const parts = splitPath(patch.path);
  switch (patch.op) {
    case "set":
      return updateIn(state, parts, () => patch.value);
    case "merge":
      return updateIn(state, parts, (existing) => ({ ...asRecord(existing), ...patch.value }));
    case "append":
      return updateIn(state, parts, (existing) =>
        Array.isArray(existing) ? [...existing, patch.value] : [patch.value]
      );
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

export function applyA2UIPatches(
  state: A2UISurfaceState,
  patches: readonly A2UIPatch[]
): A2UISurfaceState {
  return patches.reduce(applyA2UIPatch, state);
}

export { getIn as getSurfaceValue };
