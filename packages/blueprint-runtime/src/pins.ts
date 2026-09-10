import { checkVersionPins } from "@loom/core";
import type { PinReport, VersionPins } from "@loom/core";
import type { Blueprint } from "./types";

// ── The blueprint spelling of the binding-semantics pin (ADR 0095) ────────────
//
// `validateBlueprint` checks a composition against a catalogue; `preservesNodes` checks one
// tree against another. Neither can see the failure this covers, because it is not in the
// tree at all: a `DataBinding` names a projection, the projection is live code registered
// under that name, and the content address that makes a promoted view "the same view"
// freezes the NAME.
//
// So a view can be byte-identical to the one an operator promoted, hydrate cleanly, validate
// cleanly, and render a number that means something else — because the fold behind
// `latency` was edited, or its window moved from rolling to fixed, since the day it was
// composed.
//
// The comparison itself is `@loom/core`'s `checkVersionPins`, over `id -> version` maps
// rather than blueprints: its other consumer (`ReadModelService.checkPins`) has no tree.
// These two functions are the blueprint case spelled once, the way `blueprintNodeIds` /
// `preservesBlueprintNodes` spell it for identity.

/**
 * The versions a blueprint recorded for the projections it binds to.
 *
 * Only ids the blueprint actually DECLARES are returned. A pin for an id absent from
 * `projections` freezes nothing this view reads, and counting it would pad the comparison
 * with agreements that carry no information — the denominator problem `PinReport.compared`
 * exists to make visible.
 */
export function blueprintPins(blueprint: Blueprint): VersionPins {
  const recorded = blueprint.projectionVersions;
  if (recorded === undefined) return {};
  const pins: Record<string, string> = {};
  for (const projectionId of blueprint.projections) {
    const version = recorded[projectionId];
    if (version !== undefined) pins[projectionId] = version;
  }
  return pins;
}

/**
 * Does this blueprint still mean what it meant when it was composed?
 *
 * `current` is what the runtime about to hydrate it declares —
 * `projectionRuntime.pins?.() ?? {}`. Findings, never a throw: a drift can be a deliberate
 * re-promotion or a silent re-definition, and only the caller can tell.
 *
 * The comparison is scoped to the blueprint's own `projections` in BOTH directions, and
 * every declared projection is entered on the recorded side even when nothing pinned it
 * (as `""`, which `checkVersionPins` reads as "declared nothing"). That is deliberate:
 * projections this view never binds are none of its business, and a binding that nobody
 * pinned must produce a visible `unpinned` finding rather than vanishing from a report that
 * would then read `ok: true` over an empty comparison.
 */
export function checkBlueprintPins(blueprint: Blueprint, current: VersionPins): PinReport {
  const recorded: Record<string, string> = {};
  const scoped: Record<string, string> = {};
  for (const projectionId of blueprint.projections) {
    recorded[projectionId] = blueprint.projectionVersions?.[projectionId] ?? "";
    const now = current[projectionId];
    if (now !== undefined) scoped[projectionId] = now;
  }
  return checkVersionPins(recorded, scoped);
}
