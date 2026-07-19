import { jsonSchemaHash } from "@loom/core";

// ── ADR 0064 — the output-shape skeleton ─────────────────────────────────────
//
// A value's structural type: primitives → their typeof name, objects → sorted
// key→shape maps, arrays → the DEDUPLICATED, canonically-sorted set of element
// shapes. Deterministic by construction, so `shapeHash` is a stable pin: the
// planner records the shape it expects, the executor compares what came back.

export type Shape = string | Shape[] | { [key: string]: Shape };

export function shapeOf(value: unknown): Shape {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return t;
  if (Array.isArray(value)) {
    const shapes = new Map<string, Shape>();
    for (const v of value) {
      const s = shapeOf(v);
      shapes.set(JSON.stringify(s), s);
    }
    return [...shapes.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, s]) => s);
  }
  if (t === "object") {
    const out: { [key: string]: Shape } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = shapeOf(v);
    }
    return out;
  }
  return t; // undefined/function/symbol — non-JSON, surfaced as their typeof
}

/** The canonical fingerprint of a value's structural shape (`fnv1a64:<hex16>`). */
export function shapeHash(value: unknown): string {
  return jsonSchemaHash(shapeOf(value));
}
