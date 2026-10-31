// ── The integrity axis — provenance for content the system did not author ────
//
// The existing markers are a CONFIDENTIALITY axis (`secret`/`sensitive`/
// `internal` — what may LEAVE) plus a where-stored axis (`externalized`). This
// is the third and opposite direction: what may ENTER an instruction position.
// A third-party MCP tool result, an A2A peer's response, a fetched document —
// all arrive as ordinary strings, and an ordinary string interpolated into a
// system prompt is indistinguishable from an instruction the operator wrote.
//
// WHY A VALUE WRAPPER AND NOT A SCHEMA MARKER. Confidentiality is a property of
// a FIELD: `ssn` is sensitive in every execution, forever, so declaring it once
// at the schema is exactly right. Integrity is a property of a VALUE: the same
// `summary: string` field is trustworthy when this flow computed it and
// untrusted when a third-party server returned it, and which one it is cannot be
// known until runtime. A schema marker would have to guess, and a marker that
// guesses is worse than none — it reads as coverage. So taint is attached where
// it is acquired, to the value, by the code that acquired it.
//
// The wrapper is plain JSON (`{ __loomTainted, value }`), the same structural
// shape K10.3's `secretRef` uses, so it survives the log verbatim and a replay
// hands the effect back a value that is still tainted. The corollary is the
// honest limit on retrofitting: taint applies to content ingested AFTER a
// producer starts applying it. An existing log replays exactly as it did, with
// no taint, because the fact was never recorded — the same argument ADR 0063 D3
// made about principals.

/** Where a tainted value came from — an origin label, e.g. `mcp:acme/chart`. */
export interface Taint {
  /**
   * Human-meaningful provenance, chosen by the producer. It is rendered into
   * the fence around the content, so treat it as untrusted display text: it
   * frequently contains a third-party-controlled fragment (a tool name, a peer
   * id) and is escaped at the point of use, never trusted as markup.
   */
  origin: string;
}

/** A value carrying its own provenance. Plain JSON — survives the log unchanged. */
export interface TaintedValue<T = unknown> {
  __loomTainted: Taint;
  value: T;
}

/**
 * Wrap a value as untrusted, recording where it came from.
 *
 * Apply this at INGRESS — the moment content crosses into the system from a
 * party that is not the operator. Tainting later is guesswork, and tainting
 * never is how third-party text ends up in a system prompt.
 *
 * Re-tainting an already-tainted value keeps the ORIGINAL origin: provenance
 * records where content entered, and a re-wrap would let a later, more
 * flattering label overwrite the true one.
 */
export function tainted<T>(value: T, origin: string): TaintedValue<T> {
  if (isTainted(value)) return value as TaintedValue<T>;
  return { __loomTainted: { origin }, value };
}

/** Whether a value carries taint. Structural, so it survives a JSON round-trip. */
export function isTainted(value: unknown): value is TaintedValue {
  if (typeof value !== "object" || value === null) return false;
  const mark = (value as { __loomTainted?: unknown }).__loomTainted;
  return (
    typeof mark === "object" &&
    mark !== null &&
    typeof (mark as { origin?: unknown }).origin === "string" &&
    "value" in value
  );
}

/** The provenance on a value, or `undefined` when it carries none. */
export function taintOf(value: unknown): Taint | undefined {
  return isTainted(value) ? value.__loomTainted : undefined;
}

/**
 * The inner value, discarding provenance. Non-tainted values pass through.
 *
 * Deliberately loud. Unwrapping is legitimate and often necessary — parsing a
 * tainted JSON payload, indexing a tainted record — but every call is a place
 * where provenance stops travelling. Unwrap to COMPUTE with content; never
 * unwrap on the way to a prompt, which is the one path the taint exists to
 * govern. Nothing can stop you; the point is that the call site is visible.
 */
export function unwrapTainted<T>(value: TaintedValue<T> | T): T {
  return isTainted(value) ? (value.value as T) : (value as T);
}

// ── Nested taint - a marker anywhere inside a value ──────────────────────────
//
// `isTainted` looks at the TOP of a value only. A producer that taints part of what it returns (an A2A
// reply taints `content` and leaves `raw` for control flow, ADR 0085) hands back a plain object with a
// wrapper buried inside, and every top-level check reads it as clean. `scanTaint` is the one walk the
// agent loop and the claim-check middleware share to answer "is ANY of this untrusted".

/** Bounds of a {@link scanTaint} walk. */
export interface TaintScanOptions {
  /** Deepest nesting visited (the root is depth 0). Default {@link TAINT_SCAN_MAX_DEPTH}. */
  maxDepth?: number;
  /** Most object/array nodes visited. Default {@link TAINT_SCAN_MAX_NODES}. */
  maxNodes?: number;
}

/** Default nesting bound of {@link scanTaint}. */
export const TAINT_SCAN_MAX_DEPTH = 64;
/** Default node bound of {@link scanTaint}. */
export const TAINT_SCAN_MAX_NODES = 100_000;
/** The origin reported when a scan hit its bound and could not prove the value clean. */
export const TAINT_SCAN_EXCEEDED_ORIGIN = "unknown:taint-scan-bound-exceeded";

/** What {@link scanTaint} found. */
export interface TaintScan {
  /** Distinct origins of every wrapper found, in discovery order. */
  readonly origins: readonly string[];
  /** The walk hit a bound before it finished: the value is NOT proven clean. */
  readonly exceeded: boolean;
  /** `origins` is non-empty or `exceeded` - the value must be treated as untrusted. */
  readonly tainted: boolean;
}

/**
 * Walk `value` for taint wrappers at ANY depth. Iterative (no recursion, so a 100k-deep JSON cannot
 * blow the stack), cycle-safe, and bounded by depth and node count. FAILS CLOSED: when a bound is hit
 * the result is `exceeded: true` and `tainted: true`, because "too big to look at" is not "clean".
 * Binary views are skipped (they cannot hold a wrapper). Pure: the value is never modified.
 */
export function scanTaint(value: unknown, options: TaintScanOptions = {}): TaintScan {
  const maxDepth = options.maxDepth ?? TAINT_SCAN_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? TAINT_SCAN_MAX_NODES;
  const origins: string[] = [];
  const found = new Set<string>();
  let exceeded = false;
  let nodes = 0;
  const seen = new WeakSet<object>();
  const stack: Array<{ v: unknown; d: number }> = [{ v: value, d: 0 }];
  while (stack.length > 0) {
    const { v, d } = stack.pop() as { v: unknown; d: number };
    if (typeof v !== "object" || v === null || seen.has(v) || ArrayBuffer.isView(v)) continue;
    seen.add(v);
    if (++nodes > maxNodes || d > maxDepth) {
      exceeded = true;
      break;
    }
    if (isTainted(v)) {
      const origin = v.__loomTainted.origin;
      if (!found.has(origin)) {
        found.add(origin);
        origins.push(origin);
      }
    }
    for (const child of Array.isArray(v) ? v : Object.values(v)) {
      if (typeof child === "object" && child !== null) stack.push({ v: child, d: d + 1 });
    }
  }
  return { origins, exceeded, tainted: exceeded || origins.length > 0 };
}

/**
 * The origin label for a value that may hold nested taint, or `undefined` when it is provably clean.
 * Several origins are joined (`a, b`); a bound hit adds {@link TAINT_SCAN_EXCEEDED_ORIGIN}.
 */
export function nestedTaintOrigin(value: unknown, options?: TaintScanOptions): string | undefined {
  const scan = scanTaint(value, options);
  if (!scan.tainted) return undefined;
  const all = scan.exceeded ? [...scan.origins, TAINT_SCAN_EXCEEDED_ORIGIN] : scan.origins;
  return all.join(", ");
}
