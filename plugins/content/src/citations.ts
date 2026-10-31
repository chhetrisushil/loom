// The ONE walker for "which blobs does this value cite" — shared by the mark phase of
// `sweepUnpinnedContent` and by `ContentResolvingEventStore`, which touches what it carries
// into a log without a `put` (ADR 0055 D6 amendment 2). Iterative + cycle-safe: neither a
// retention job nor an append may stack-overflow on an app-controlled payload.

/**
 * The structural claim-check test, identical to `isClaimCheck` in `@loom/middleware`
 * (kept structural so this plugin takes no middleware dependency): the flag AND a string
 * `ref.__loomContent`. An app object that merely carries the flag is app data.
 */
function envelopeRef(value: object): string | undefined {
  if ((value as { __loomClaimCheck?: unknown }).__loomClaimCheck !== true) return undefined;
  const address = (value as { ref?: { __loomContent?: unknown } | null }).ref?.__loomContent;
  return typeof address === "string" ? address : undefined;
}

/** The address of an R5 media source `{ kind: "ref", ref: { address: string } }`, if `value` is one. */
function mediaSourceAddress(value: object): string | undefined {
  if ((value as { kind?: unknown }).kind !== "ref") return undefined;
  const address = (value as { ref?: { address?: unknown } | null }).ref?.address;
  return typeof address === "string" ? address : undefined;
}

/**
 * Visit every content address an event payload (or snapshot state) cites. Any object carrying a
 * string `__loomContent` is a ref leaf — this covers bare ADR 0046
 * `ContentRef`s (e.g. a finding's `evidence` list, an externalized field) AND
 * the `ref` of an ADR 0054 claim-check envelope. `inEnvelope` is true ONLY for
 * a RECLAIMABLE envelope's own `ref` — the offloaded value, the one citation whose
 * erasure is replay-invisible (ADR 0055 D4). An envelope marked `retain: true` (ADR 0140:
 * the opt-in agent claim-check, whose offloaded bytes are the ONLY copy of a tool output the
 * log once held) reports its ref as load-bearing (`inEnvelope` false): kept while any live
 * log, archive segment or snapshot cites it, freed only when that history is deleted. Every other envelope field (`digest` above
 * all: orchestration branches on it) is recorded, replay-visible data and is
 * walked in the envelope's own context like any other payload.
 *
 * Because the enveloped context never descends (the `ref` is a leaf), one
 * WeakSet cycle guard suffices: an object aliased at a bare site and as an
 * envelope's `ref` is still visited bare, since the envelope reports its ref
 * directly rather than through the guard.
 *
 * Iterative with cycle detection: the sweep is a retention job over
 * app-controlled payloads, so a pathologically deep (or, from an in-memory
 * store, cyclic) value must not stack-overflow the pass (audit W8).
 */
export function visitCitedAddresses(
  value: unknown,
  visit: (address: string, inEnvelope: boolean) => void,
  /**
   * ADR 0140 D11 - when given, a `retain: true` envelope is honoured as load-bearing ONLY if it is in
   * this set (see {@link retainRootsOf}); any other (a nested, tool-authored lookalike) stays reclaimable.
   * Absent: every retained envelope is honoured (snapshots and archives, which pin everything anyway).
   */
  trustedRetain?: ReadonlySet<object>
): void {
  const stack: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current !== "object" || current === null) continue;
    if (seen.has(current)) continue;
    seen.add(current);
    const address = (current as { __loomContent?: unknown }).__loomContent;
    if (typeof address === "string") {
      visit(address, false);
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    // R5 (ADR 0120) — an LLM media source `{ kind: "ref", ref: { address } }` cites a blob by its
    // address WITHOUT the `__loomContent` marker (deliberately: the resolving store would
    // JSON-decode that marker). It is as load-bearing as a bare ref — a live model call resolves
    // it, and erasing it makes the next call fail — so the mark phase must see it, or the sweep
    // would reclaim media the transcript still cites.
    const mediaAddress = mediaSourceAddress(current);
    if (mediaAddress !== undefined) {
      visit(mediaAddress, false);
      continue;
    }
    const offloaded = envelopeRef(current);
    // ADR 0140 - a RETAINED envelope's blob is audit evidence, not telemetry: load-bearing.
    if (offloaded !== undefined) {
      visit(
        offloaded,
        (current as { retain?: unknown }).retain !== true ||
          (trustedRetain !== undefined && !trustedRetain.has(current))
      );
    }
    for (const [key, item] of Object.entries(current)) {
      if (offloaded !== undefined && key === "ref") continue;
      stack.push(item);
    }
  }
}

/**
 * ADR 0140 D11 - the objects in an event payload where a retained envelope is TRUSTED: the top-level
 * `output` of a `STEP_COMPLETED` (through a taint wrapper), exactly where the opt-in preset records its
 * envelope. A `retain: true` lookalike nested inside a tool's result is tool-authored data: it cannot
 * pin a blob.
 */
export function retainRootsOf(event: { eventType: string; payload: unknown }): Set<object> {
  const roots = new Set<object>();
  if (event.eventType !== "STEP_COMPLETED") return roots;
  let out = (event.payload as { output?: unknown } | null)?.output;
  if (
    typeof out === "object" &&
    out !== null &&
    (out as { __loomTainted?: unknown }).__loomTainted !== undefined
  ) {
    out = (out as { value?: unknown }).value;
  }
  if (typeof out === "object" && out !== null) roots.add(out);
  return roots;
}
