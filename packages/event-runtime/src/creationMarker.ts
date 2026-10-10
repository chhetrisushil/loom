import type { EventEnvelope } from "@loom/core";

/**
 * SPI 2.2.0 — the LEGACY (pre-ADR 0129) opaque creation marker `appendIfUnchanged` compares (see `TipObservation`):
 * derived from an execution's sequence-0 envelope, so a log deleted and re-created under the same
 * id reads as a different execution. Envelope ids are deterministic, hence the timestamp too.
 * Every reference store derives it with this one function so they agree byte for byte.
 *
 * SPI 2.3.0 (ADR 0129): this is no longer the anchor of a log whose store assigned an
 * incarnation (it cannot tell two byte-identical re-creations apart). It remains the anchor of a
 * log created before the store gained that metadata, and of a store that cannot assign one.
 */
export function creationMarker(first: Pick<EventEnvelope, "id" | "timestamp">): string {
  return `${first.timestamp}:${first.id}`;
}
