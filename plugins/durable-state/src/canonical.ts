/**
 * Depth cap for canonicalization. JSON nesting beyond this is pathological
 * (and could stack-overflow the save path — audit W8); exceeding it throws a
 * loud RangeError rather than crashing the process.
 */
const MAX_DEPTH = 256;

/**
 * Canonical JSON serialization: object keys sorted, `undefined` properties
 * skipped (JSON semantics). Used for the save effect's adopt-own-write check —
 * value equality must not depend on property insertion order.
 */
export function stableStringify(value: unknown, depth = 0): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (depth >= MAX_DEPTH) {
    throw new RangeError(`stableStringify: value nests deeper than ${MAX_DEPTH} levels`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item, depth + 1)).join(",")}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => [key, (value as Record<string, unknown>)[key]] as const)
    .filter(([, v]) => v !== undefined)
    .map(([key, v]) => `${JSON.stringify(key)}:${stableStringify(v, depth + 1)}`);
  return `{${entries.join(",")}}`;
}

export function canonicalEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}
