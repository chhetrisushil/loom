import type { z } from "zod";
import { type DataClass, classOf } from "./classify";

// ── Marks the dot-path sinks cannot reach ─────────────────────────────────────
//
// `collectMarkedPaths` walks objects and — since #260 option 2 — arrays, via a `[]` crossing
// segment. Everything else it simply does not descend: a record's values, a union's branches,
// a tuple's members, an intersection's sides. A mark placed under one of those collects no
// path, so `maskPaths` never masks it, the crypto field walker never encrypts it, and the
// content externalizer never externalizes it. The developer marked the field; the mark does
// nothing, and nothing says so. This finds those marks so a pre-flight check can.
//
// It mirrors the walker it audits — same transparent wrappers, same "a marked object is a
// unit, don't descend" rule, same array traversal — so the two agree on what IS reachable.
// Divergence would produce false positives on fields that are in fact masked, which is worse
// than the gap being reported.

/** A classification mark that no dot-path sink can address. */
export interface UnreachableMark {
  /**
   * Dot-path to the mark, with `[]` per array crossing and `<Type>` where an untraversable
   * container sits — e.g. `"byId.<record>.ssn"`. Not an addressable path; a location.
   */
  readonly path: string;
  readonly dataClass: DataClass;
  /** The container that blocks it, lowercased without the `Zod` prefix (`record`, `union`, …). */
  readonly container: string;
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

function typeNameOf(node: z.ZodTypeAny): string | undefined {
  return (node as { _def?: { typeName?: string } })._def?.typeName;
}

function objectShape(node: z.ZodTypeAny): Record<string, z.ZodTypeAny> | undefined {
  const def = (node as { _def?: { typeName?: string; shape?: () => unknown } })._def;
  if (def?.typeName !== "ZodObject" || typeof def.shape !== "function") return undefined;
  return def.shape() as Record<string, z.ZodTypeAny>;
}

function arrayElement(node: z.ZodTypeAny): z.ZodTypeAny | undefined {
  const def = (node as { _def?: { typeName?: string; type?: unknown } })._def;
  if (def?.typeName !== "ZodArray") return undefined;
  return def.type as z.ZodTypeAny | undefined;
}

/**
 * Schemas that hold inner schemas the classification walker never descends into. Returns the
 * children to search for stranded marks, plus the label for the location string.
 *
 * `lazy` is deliberately absent: descending a recursive schema to hunt for marks risks
 * non-termination, and the payoff is small.
 */
function opaqueChildren(
  node: z.ZodTypeAny
): { label: string; children: z.ZodTypeAny[] } | undefined {
  const def = (node as { _def?: Record<string, unknown> })._def;
  const typeName = typeNameOf(node);
  switch (typeName) {
    case "ZodRecord":
    case "ZodMap":
    case "ZodSet":
      return {
        label: typeName.slice(3).toLowerCase(),
        children: [def?.valueType as z.ZodTypeAny].filter(Boolean),
      };
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const options = def?.options;
      const list = Array.isArray(options)
        ? options
        : [...((options as Map<unknown, unknown>)?.values?.() ?? [])];
      return { label: "union", children: list as z.ZodTypeAny[] };
    }
    case "ZodTuple":
      return { label: "tuple", children: (def?.items as z.ZodTypeAny[]) ?? [] };
    case "ZodIntersection":
      return {
        label: "intersection",
        children: [def?.left as z.ZodTypeAny, def?.right as z.ZodTypeAny].filter(Boolean),
      };
    default:
      return undefined;
  }
}

function effectiveClass(schema: z.ZodTypeAny): DataClass | undefined {
  for (const node of chain(schema).nodes) {
    const mark = classOf(node);
    if (mark !== undefined) return mark;
  }
  return undefined;
}

/**
 * Every classification mark stranded under a container the dot-path sinks cannot address.
 *
 * Returns `[]` for marks on objects and arrays — both are traversable, so those marks work.
 */
export function collectUnreachableMarks(schema: z.ZodTypeAny, prefix = ""): UnreachableMark[] {
  return walk(schema, prefix, undefined);
}

function walk(
  schema: z.ZodTypeAny,
  path: string,
  blockedBy: string | undefined
): UnreachableMark[] {
  const mark = effectiveClass(schema);
  if (mark !== undefined && path !== "") {
    // A mark terminates the walk exactly as it does in `collectMarkedPaths` — a marked object
    // is a unit — so a mark nested inside a marked one is not double-reported.
    return blockedBy === undefined ? [] : [{ path, dataClass: mark, container: blockedBy }];
  }

  const inner = chain(schema).inner;

  const element = arrayElement(inner);
  if (element !== undefined) return walk(element, `${path}[]`, blockedBy);

  const shape = objectShape(inner);
  if (shape !== undefined) {
    const out: UnreachableMark[] = [];
    for (const [key, child] of Object.entries(shape)) {
      out.push(...walk(child, path === "" ? key : `${path}.${key}`, blockedBy));
    }
    return out;
  }

  const opaque = opaqueChildren(inner);
  if (opaque !== undefined) {
    const out: UnreachableMark[] = [];
    // Everything below here is unreachable — but keep the OUTERMOST blocker, since that is
    // the one the developer has to restructure.
    const blocker = blockedBy ?? opaque.label;
    for (const child of opaque.children) {
      out.push(...walk(child, `${path}.<${opaque.label}>`, blocker));
    }
    return out;
  }

  return [];
}
