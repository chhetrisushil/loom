import type { z } from "zod";
import { type DataClass, classOf } from "./classify";

// ── Marks the dot-path sinks cannot reach ─────────────────────────────────────
//
// `collectMarkedPaths` walks objects and stops at arrays, by design: "array-element recursion
// is out of scope — the dot-path sinks address scalar paths". Marking the array itself is the
// supported spelling and works.
//
// The hazard is what happens to a mark placed INSIDE an array element. No path is collected
// for it, so `maskPaths` never masks it, the crypto field walker never encrypts it, and the
// content externalizer never externalizes it. The developer marked the field; the mark simply
// does nothing, and nothing says so. This finds those marks so a pre-flight check can.
//
// It deliberately mirrors the walker it is auditing — same transparent wrappers, same
// "a marked object is a unit, don't descend" rule — so the two agree on what IS reachable.
// Any divergence would produce false positives on fields that are in fact masked.

/** A classification mark that no dot-path sink can address. */
export interface UnreachableMark {
  /**
   * Dot-path to the mark, with `[]` marking each array crossing —
   * e.g. `"people[].ssn"`. Not a real dot-path (nothing can address it); it is a
   * human-readable location.
   */
  readonly path: string;
  readonly dataClass: DataClass;
  /** Why it cannot be reached. Currently always an array crossing. */
  readonly reason: "under-array";
}

/** Unwrap optional/nullable/default/effects, as the classification walker does. */
function chain(schema: z.ZodTypeAny): { nodes: z.ZodTypeAny[]; inner: z.ZodTypeAny } {
  const nodes: z.ZodTypeAny[] = [];
  let cur: z.ZodTypeAny = schema;
  for (let i = 0; i < 100; i++) {
    nodes.push(cur);
    const def = (cur as { _def?: Record<string, unknown> })._def;
    const typeName = def?.typeName as string | undefined;
    let next: unknown;
    if (typeName === "ZodOptional" || typeName === "ZodNullable" || typeName === "ZodDefault") {
      next = def?.innerType;
    } else if (typeName === "ZodEffects") {
      next = def?.schema;
    } else {
      break;
    }
    if (next === undefined) break;
    cur = next as z.ZodTypeAny;
  }
  return { nodes, inner: cur };
}

function objectShape(node: z.ZodTypeAny): Record<string, z.ZodTypeAny> | undefined {
  const def = (node as { _def?: { typeName?: string; shape?: () => unknown } })._def;
  if (def?.typeName !== "ZodObject" || typeof def.shape !== "function") return undefined;
  return def.shape() as Record<string, z.ZodTypeAny>;
}

/** The array element type, if this node is an array. */
function arrayElement(node: z.ZodTypeAny): z.ZodTypeAny | undefined {
  const def = (node as { _def?: { typeName?: string; type?: unknown } })._def;
  if (def?.typeName !== "ZodArray") return undefined;
  return def.type as z.ZodTypeAny | undefined;
}

function effectiveClass(schema: z.ZodTypeAny): DataClass | undefined {
  for (const node of chain(schema).nodes) {
    const mark = classOf(node);
    if (mark !== undefined) return mark;
  }
  return undefined;
}

/**
 * Every classification mark that sits under an array and is therefore invisible to the
 * dot-path sinks (masking, field encryption, externalization).
 *
 * Returns `[]` for a schema with no such marks — including one that marks arrays *themselves*,
 * which is the supported and working spelling.
 */
export function collectUnreachableMarks(schema: z.ZodTypeAny, prefix = ""): UnreachableMark[] {
  return walk(schema, prefix, false);
}

function walk(schema: z.ZodTypeAny, path: string, underArray: boolean): UnreachableMark[] {
  const mark = effectiveClass(schema);
  if (mark !== undefined && path !== "") {
    // A mark terminates the walk exactly as it does in `collectMarkedPaths` — a marked
    // object is a unit. Under an array that mark is unreachable; above one it is fine, and
    // either way we do not descend, so a mark nested inside a marked object is not
    // double-reported (the outer mark already covers it).
    return underArray ? [{ path, dataClass: mark, reason: "under-array" }] : [];
  }

  const inner = chain(schema).inner;
  const out: UnreachableMark[] = [];

  const element = arrayElement(inner);
  if (element !== undefined) {
    // Cross into the element. Everything marked below here is unreachable, whether this is
    // the first array crossing or a nested one.
    return walk(element, `${path}[]`, true);
  }

  const shape = objectShape(inner);
  if (shape !== undefined) {
    for (const [key, child] of Object.entries(shape)) {
      out.push(...walk(child, path === "" ? key : `${path}.${key}`, underArray));
    }
  }
  return out;
}
