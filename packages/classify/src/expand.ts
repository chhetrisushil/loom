// ── Wildcard path expansion (#260 option 2) ───────────────────────────────────
//
// The dot-path sinks — telemetry masking, field-level encryption, content externalization —
// address scalar paths and originally could not descend into array elements, so a mark
// placed inside one did nothing at all. `[]` is the array-crossing segment that fixes it:
// `people[].ssn` means "the `ssn` of every element of `people`".
//
// Rather than teach three near-identical spine-walkers about arrays, expansion happens ONCE
// against the concrete value and yields ordinary indexed paths (`people.0.ssn`,
// `people.1.ssn`) that every existing applier already handles — `array["0"]` is a normal
// property access, and each applier's spine copy already preserves arrays. So the walkers
// stay as they were, and there is one place where array semantics live.
//
// A path with no `[]` passes through untouched, so every pre-existing path behaves exactly
// as before (G2).

/** Split a segment into its key and how many array crossings follow it (`rows[][]` ⇒ 2). */
function parseSegment(segment: string): { key: string; depth: number } {
  let depth = 0;
  let key = segment;
  while (key.endsWith("[]")) {
    key = key.slice(0, -2);
    depth++;
  }
  return { key, depth };
}

/**
 * Expand `paths` against `root`, replacing every `[]` with the concrete indices present in
 * the value.
 *
 * - `"a.b"` (no wildcard) → `["a.b"]`, unchanged and unchecked; the appliers already skip
 *   absent paths, and pre-existing behaviour must not shift.
 * - `"people[].ssn"` over two people → `["people.0.ssn", "people.1.ssn"]`.
 * - `"tags[]"` (a marked array ELEMENT type) → one path per element.
 * - A wildcard that does not resolve — absent, or `[]` over a non-array — expands to
 *   nothing, so nothing is masked/encrypted for it. Resolving against the value is the whole
 *   point of expanding late.
 */
export function expandPaths(root: unknown, paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const path of paths) {
    if (!path.includes("[]")) {
      out.push(path);
      continue;
    }
    expandInto(root, path.split("."), 0, [], out);
  }
  return out;
}

/** True if any path uses a wildcard — lets callers skip expansion entirely (G2 fast path). */
export function hasWildcard(paths: readonly string[]): boolean {
  for (const p of paths) if (p.includes("[]")) return true;
  return false;
}

function expandInto(
  value: unknown,
  segments: readonly string[],
  index: number,
  acc: readonly string[],
  out: string[]
): void {
  if (index >= segments.length) {
    out.push(acc.join("."));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const { key, depth } = parseSegment(segments[index] as string);
  if (!Object.hasOwn(value, key)) return;
  const child = (value as Record<string, unknown>)[key];
  descend(child, depth, [...acc, key], segments, index, out);
}

/** Walk `depth` array levels, emitting an index per level, then continue with the next segment. */
function descend(
  value: unknown,
  depth: number,
  acc: readonly string[],
  segments: readonly string[],
  index: number,
  out: string[]
): void {
  if (depth === 0) {
    // Reached the value this segment names. If it is the last segment it IS the target;
    // otherwise keep walking.
    if (index === segments.length - 1) out.push(acc.join("."));
    else expandInto(value, segments, index + 1, acc, out);
    return;
  }
  // A `[]` over a non-array resolves to nothing — the mark does not apply to this value.
  if (!Array.isArray(value)) return;
  for (const [i, element] of value.entries()) {
    descend(element, depth - 1, [...acc, String(i)], segments, index, out);
  }
}
