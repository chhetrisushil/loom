/**
 * Canonical JSON serialization: object keys sorted, `undefined` properties
 * skipped (JSON semantics). Used for the save effect's adopt-own-write check —
 * value equality must not depend on property insertion order.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => [key, (value as Record<string, unknown>)[key]] as const)
    .filter(([, v]) => v !== undefined)
    .map(([key, v]) => `${JSON.stringify(key)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

export function canonicalEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}
