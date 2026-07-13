import type { z } from "zod";
import { collectMarkedPaths } from "./classify";

// ── ADR 0046 — the `externalized()` marker ────────────────────────────────────
//
// Orthogonal to the secret/sensitive/internal taxonomy: that axis says HOW sensitive a field
// is; this one says WHERE its value is stored — externalized to a content store, with the log
// keeping only a reference. A field can be both (a large AND sensitive document: externalize
// the bytes, and encrypt them in the content store). Because it is a separate axis, it has its
// own registry rather than a fourth DataClass.
//
// A non-invasive WeakMap keeps the marker from mutating the Zod schema (same instance returned,
// validation untouched), exactly like the classification registry.

const externalRegistry = new WeakMap<object, true>();

/**
 * Mark a field `externalized` — its value is moved to a content store on append and the log
 * keeps a content-addressed reference (ADR 0046). Returns the SAME schema (validation
 * unchanged). Marking an object externalizes its whole subtree as one blob.
 */
export function externalized<T extends z.ZodTypeAny>(schema: T): T {
  externalRegistry.set(schema, true);
  return schema;
}

/** Whether a schema was marked {@link externalized} (through transparent wrappers is handled by the walker). */
export function isExternalized(schema: unknown): boolean {
  return typeof schema === "object" && schema !== null && externalRegistry.get(schema) === true;
}

/**
 * The dot-paths of every `externalized()`-marked field in a schema (declaration order,
 * deterministic). A marked object is reported at its own path as a unit.
 */
export function externalizedPaths(schema: z.ZodTypeAny): string[] {
  return collectMarkedPaths(schema, (node) =>
    externalRegistry.get(node) === true ? true : undefined
  ).map((m) => m.path);
}
