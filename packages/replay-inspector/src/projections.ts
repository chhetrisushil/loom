import type { EventEnvelope } from "@loom/core";
import type { ProjectionSlice, ProjectionSource, ReadOnlyEventStore } from "./types";
import { InspectorBudgetError } from "./types";

// ── IX-3 — the projection fold, and why it is the largest item ────────────────
//
// The original requirement asked for "the view at event N", assuming a rendering model
// where a view is recomputed from state. This system has no such model: `blueprint$` is
// a STATIC layout declaration listing `projections: string[]`
// (`@loom/blueprint-runtime` Blueprint.ts:9), and widgets bind to projection slices,
// notified change-only through `ProjectionRuntime.subscribeSelector` (ADR 0068). There
// is no recomputed view to show. What a debugging session actually wants — and what
// exists — is the projection SLICE at that point.
//
// That is a SECOND, independent fold. The kernel fold produces `ExecutionState`;
// `projection$` is a separate user-authored fold map `{ [eventType]: (state, event) =>
// state }` with its own state (`@loom/core` builders/projection.ts:21). Reconstructing
// it means running that fold too.
//
// Two answers from the routed claims shape this code:
//
//   Q1 — "does the snapshot store hold projection state?" → NO. `Snapshot.state` is
//   typed `ExecutionState`; projection state lives per-(projectionId, executionId) in
//   the projection runtime and is never persisted through the SPI. So there is no
//   anchor: every projection fold starts from `initialState`. MITIGATION, which makes
//   this affordable: the compiler records each projection's handled `eventTypes` in the
//   manifest, readable WITHOUT loading the fold chunk. One inverted index over the
//   whole projection set turns "which projections care about this event" into an O(1)
//   lookup, so each projection folds only its own events rather than the whole log.
//
//   Q3 — "are superseded projection chunks retained?" → chunks are Vite build artifacts
//   emitted into `build.outDir` (tools/compiler/src/plugin.ts:63-67). They are deploy
//   output, not versioned retrievable objects, so for an execution pinned to a
//   superseded version the fold body may simply be gone. That is REPORTED
//   (`status: "unavailable"`), never worked around: running the CURRENT fold over an
//   old log reproduces IX-5's forbidden silent fallback one level down.
//
// Nothing here is cached between calls. A loaded chunk is already memoised by the
// module system, so a cache of our own would add a retention surface (an unbounded
// Map keyed by projection id × flow hash) for no gain — the leak-free choice is to
// hold nothing.

export interface ProjectionReconstructOptions {
  /** Refuse rather than truncate above this many events. See ReconstructOptions. */
  maxEvents?: number;
}

const DEFAULT_MAX_EVENTS = 1_000_000;

/**
 * Inverted index `eventType → projection ids`, built once per call from the manifest's
 * statically-extracted key sets. Costs O(Σ eventTypes) to build and makes the per-event
 * dispatch O(1) instead of O(projections).
 */
export function indexByEventType(
  sources: readonly ProjectionSource[]
): ReadonlyMap<string, readonly string[]> {
  const index = new Map<string, string[]>();
  for (const source of sources) {
    for (const eventType of source.eventTypes) {
      const bucket = index.get(eventType);
      if (bucket === undefined) index.set(eventType, [source.id]);
      else bucket.push(source.id);
    }
  }
  return index;
}

/**
 * Reconstruct every supplied projection's state at `position`.
 *
 * One log read for all projections, then one fold per projection over only its own
 * events. A projection that declares none of the event types present in range is
 * reported `unaffected` with its initial state — NOT omitted. Absence and no-change are
 * different facts, and collapsing them hides the case an operator is usually chasing:
 * "did this projection see the event at all?"
 *
 * A fold body that cannot be resolved for the pinned version yields `unavailable` with
 * a reason. A handler that throws mid-fold does the same, scoped to that projection —
 * one broken fold must not take down the whole transition view.
 */
export async function reconstructProjections(
  events: ReadOnlyEventStore,
  executionId: string,
  sources: readonly ProjectionSource[],
  position: number,
  options: ProjectionReconstructOptions = {}
): Promise<ProjectionSlice[]> {
  if (sources.length === 0) return [];
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;

  // No snapshot anchor exists for projection state (Q1), so the read starts at the
  // origin. It is bounded above by `position`, and `readRange` pushes that bound into
  // the backend when the store implements it.
  const log =
    events.readRange !== undefined
      ? await events.readRange(executionId, 0, position)
      : (await events.readFrom(executionId, 0)).filter(
          (e: EventEnvelope) => e.sequence <= position
        );

  if (log.length > maxEvents) {
    throw new InspectorBudgetError(executionId, log.length, maxEvents);
  }

  const index = indexByEventType(sources);
  // Partition the log by projection in ONE pass. Without this, P projections would each
  // scan the whole log: O(P·E) instead of O(E + Σ matched).
  const buckets = new Map<string, EventEnvelope[]>();
  for (const source of sources) buckets.set(source.id, []);
  for (const event of log) {
    const ids = index.get(event.eventType);
    if (ids === undefined) continue;
    for (const id of ids) (buckets.get(id) as EventEnvelope[]).push(event);
  }

  // Folds are independent, so they run concurrently — each `load()` is a dynamic import
  // and serialising them would make the transition view wait on the slowest chunk chain.
  return Promise.all(
    sources.map(async (source): Promise<ProjectionSlice> => {
      const matched = buckets.get(source.id) as EventEnvelope[];

      if (source.load === undefined) {
        return {
          projectionId: source.id,
          status: "unavailable",
          reason:
            "no fold body available for the pinned version (superseded build chunk); " +
            "refusing to fall back to the current version",
          foldedEvents: 0,
        };
      }
      if (matched.length === 0) {
        // Declared nothing in range. Report the initial state rather than omitting the
        // projection — see the note above on absence vs no-change.
        return {
          projectionId: source.id,
          status: "unaffected",
          state: source.initialState,
          foldedEvents: 0,
        };
      }

      let handlers: Record<string, (state: unknown, event: EventEnvelope) => unknown>;
      try {
        handlers = await source.load();
      } catch (err) {
        return {
          projectionId: source.id,
          status: "unavailable",
          reason: `fold body failed to load for the pinned version: ${errorText(err)}`,
          foldedEvents: 0,
        };
      }

      let state = source.initialState;
      let folded = 0;
      for (const event of matched) {
        // Own-key lookup: `handlers` is user-authored, so an inherited or `__proto__`
        // name must never resolve to a callable. Mirrors `ReplayVM.getDecision`.
        if (!Object.hasOwn(handlers, event.eventType)) continue;
        const handler = handlers[event.eventType];
        if (typeof handler !== "function") continue;
        try {
          state = handler(state, event);
        } catch (err) {
          return {
            projectionId: source.id,
            status: "unavailable",
            reason: `fold threw at sequence ${event.sequence}: ${errorText(err)}`,
            foldedEvents: folded,
          };
        }
        folded++;
      }
      return { projectionId: source.id, status: "ok", state, foldedEvents: folded };
    })
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
