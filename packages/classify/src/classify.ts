import type { z } from "zod";

// ── K10-R1 — the data-protection classification taxonomy ──────────────────────
//
// A field's sensitivity is authored ONCE, at its schema, instead of hand-wired as
// dot-paths at every store/middleware seam. Three *handling* classes, each named for
// the downstream mechanism that acts on it — so a marker tells you what will happen,
// not just "this is secret-ish":
//
//   • "secret"    — credential material that MUST NOT be persisted at all. Substituted
//                   out before the value reaches the log (K10-R2 secretRef / K10.3 redaction).
//   • "sensitive" — personal/confidential data, persisted only encrypted-at-rest and
//                   crypto-shreddable (K10.2), and scrubbed from external egress (K10-R6).
//   • "internal"  — persisted in the clear but scrubbed from EXTERNAL egress
//                   (telemetry / a2ui / CLI, K10-R6); never crosses the trust boundary.
//
// The kernel stays ignorant of these names (G3 — the mechanism lives below in the crypto
// plugin / middleware; the policy *vocabulary* lives here, above the kernel). A field with
// no marker is unclassified and handled by nothing — omitting the marker is a true no-op.

/** The three data-protection handling classes, ordered most-restrictive first. */
export type DataClass = "secret" | "sensitive" | "internal";

/** Rank for "the strictest class wins" merges (secret > sensitive > internal). */
const RANK: Record<DataClass, number> = { secret: 3, sensitive: 2, internal: 1 };

// A schema instance → its class. A WeakMap (not a mutated property) keeps the marker
// non-invasive: the Zod schema is returned byte-identical, its validation untouched, and
// a schema that is GC'd drops its entry. Keyed by the exact instance the author passed,
// which is the same instance a walker meets in `.shape`, so lookups line up.
const registry = new WeakMap<object, DataClass>();

/**
 * Tag a schema with a {@link DataClass}. Returns the SAME schema (validation unchanged) so
 * it drops into a `z.object({ … })` shape transparently. Prefer the {@link secret} /
 * {@link sensitive} / {@link internal} sugar; use this directly only for a computed class.
 */
export function classify<T extends z.ZodTypeAny>(schema: T, dataClass: DataClass): T {
  registry.set(schema, dataClass);
  return schema;
}

/** Mark a field `"secret"` — never persisted; substituted before it reaches the log. */
export const secret = <T extends z.ZodTypeAny>(schema: T): T => classify(schema, "secret");
/** Mark a field `"sensitive"` — encrypted-at-rest, crypto-shreddable, scrubbed from egress. */
export const sensitive = <T extends z.ZodTypeAny>(schema: T): T => classify(schema, "sensitive");
/** Mark a field `"internal"` — persisted in the clear but never egressed externally. */
export const internal = <T extends z.ZodTypeAny>(schema: T): T => classify(schema, "internal");

/** The class a schema was tagged with, or `undefined` if unclassified. */
export function classOf(schema: unknown): DataClass | undefined {
  return typeof schema === "object" && schema !== null ? registry.get(schema as object) : undefined;
}

// Unwrap the transparent wrappers Zod adds (.optional()/.nullable()/.default()/.refine())
// so a marker survives being wrapped AFTER classification, and so an object nested under a
// wrapper is still walked. Returns the wrapper chain (outermost→innermost) for class lookup
// plus the innermost node for shape inspection.
function chain(schema: z.ZodTypeAny): { nodes: z.ZodTypeAny[]; inner: z.ZodTypeAny } {
  const nodes: z.ZodTypeAny[] = [];
  let cur: z.ZodTypeAny = schema;
  // Guard against a pathological self-referential def; real schemas terminate quickly.
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

/** The object `.shape` of a node, or `undefined` when it is not a `ZodObject`. */
function objectShape(node: z.ZodTypeAny): Record<string, z.ZodTypeAny> | undefined {
  const def = (node as { _def?: { typeName?: string; shape?: () => unknown } })._def;
  if (def?.typeName !== "ZodObject" || typeof def.shape !== "function") return undefined;
  return def.shape() as Record<string, z.ZodTypeAny>;
}

/** The mark on a schema, looking through any transparent wrappers around it (first wins). */
function effectiveMark<T>(schema: z.ZodTypeAny, markOf: (node: z.ZodTypeAny) => T | undefined) {
  for (const node of chain(schema).nodes) {
    const mark = markOf(node);
    if (mark !== undefined) return mark;
  }
  return undefined;
}

/**
 * Generic marked-path walker — the shared engine behind {@link collectClassifiedPaths} and the
 * {@link externalized} marker. Walks an object schema, and for every node whose `markOf`
 * returns a value emits `{ path, mark }`, recursing through nested objects and transparent
 * wrappers. A marked *object* is reported at its own path and NOT descended into (the coarser
 * mark wins — a marked address object is treated as a unit). Array-element recursion is out of
 * scope: the dot-path sinks address scalar paths. Deterministic: schema-declaration order (P2).
 */
export function collectMarkedPaths<T>(
  schema: z.ZodTypeAny,
  markOf: (node: z.ZodTypeAny) => T | undefined,
  prefix = ""
): { path: string; mark: T }[] {
  const out: { path: string; mark: T }[] = [];
  const mark = effectiveMark(schema, markOf);
  if (mark !== undefined && prefix !== "") {
    out.push({ path: prefix, mark });
    return out;
  }
  const shape = objectShape(chain(schema).inner);
  if (shape !== undefined) {
    for (const [key, child] of Object.entries(shape)) {
      const childPath = prefix === "" ? key : `${prefix}.${key}`;
      out.push(...collectMarkedPaths(child, markOf, childPath));
    }
  }
  return out;
}

/** A classified leaf/subtree and its dot-path from the walked root. */
export interface ClassifiedPath {
  /** Dot-path from the schema root, e.g. `"user.ssn"`. Empty for the root itself. */
  path: string;
  dataClass: DataClass;
}

/**
 * Walk an object schema and collect every classified field as a `{ path, dataClass }` (over the
 * `secret`/`sensitive`/`internal` taxonomy). Thin wrapper over {@link collectMarkedPaths}.
 */
export function collectClassifiedPaths(schema: z.ZodTypeAny, prefix = ""): ClassifiedPath[] {
  return collectMarkedPaths(schema, (node) => classOf(node), prefix).map((m) => ({
    path: m.path,
    dataClass: m.mark,
  }));
}

/** The subset of {@link collectClassifiedPaths} matching one class (e.g. only `"sensitive"`). */
export function pathsOfClass(schema: z.ZodTypeAny, dataClass: DataClass): string[] {
  return collectClassifiedPaths(schema)
    .filter((c) => c.dataClass === dataClass)
    .map((c) => c.path);
}

/** Strictest of two classes (secret > sensitive > internal); `undefined` is weakest. */
export function strictest(
  a: DataClass | undefined,
  b: DataClass | undefined
): DataClass | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return RANK[a] >= RANK[b] ? a : b;
}
