import type { RendererRegistry } from "./RendererRegistry";
import type { WidgetCatalog } from "./catalog";

// ── Catalogue ↔ renderer coverage ─────────────────────────────────────────────
//
// `validateBlueprint` checks one direction: the composer only names components
// the catalogue defines. That is worth nothing on its own if the *renderer* does
// not implement everything the catalogue defines — the composition passes
// validation and the viewer gets a placeholder anyway.
//
// The two checks are therefore a pair, and the second one is the easier to
// forget, because it fails on shipped code with no product involved: a kind is
// added to the vocabulary, a renderer is not written for it, and the only
// evidence is a string in somebody's browser.
//
// `missing` is the half that makes a report `!ok`. `extra` — a renderer for a
// kind the catalogue does not define — is reported but does not fail: it is
// drift, not a defect, and it is exactly what a host that merges a BYO registry
// into a smaller catalogue looks like.

export interface CoverageReport {
  /** True iff every catalogue kind has a renderer. */
  readonly ok: boolean;
  /** Catalogue kinds with no registered renderer — these render as a placeholder. */
  readonly missing: readonly string[];
  /** Registered kinds absent from the catalogue — reported, not failed. */
  readonly extra: readonly string[];
}

/**
 * Which of a catalogue's components this registry can actually render.
 *
 * Use it as a test in any package that ships a renderer, so adding a kind to the
 * vocabulary without a renderer fails the build rather than the viewer.
 */
export function catalogCoverage(
  catalog: WidgetCatalog,
  registry: RendererRegistry<unknown>
): CoverageReport {
  const registered = new Set(registry.kinds());
  const missing: string[] = [];
  const declared = new Set<string>();

  for (const entry of catalog.entries) {
    declared.add(entry.kind);
    if (!registered.has(entry.kind)) missing.push(entry.kind);
  }

  const extra = [...registered].filter((kind) => !declared.has(kind));

  return { ok: missing.length === 0, missing, extra };
}
