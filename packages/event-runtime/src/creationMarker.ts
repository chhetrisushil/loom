import type { EventEnvelope } from "@loom/core";

/**
 * SPI 2.2.0 — the opaque creation marker `appendIfUnchanged` compares (see `TipObservation`):
 * derived from an execution's sequence-0 envelope, so a log deleted and re-created under the same
 * id reads as a different execution. Envelope ids are deterministic, hence the timestamp too.
 * Every reference store derives it with this one function so they agree byte for byte.
 */
export function creationMarker(first: Pick<EventEnvelope, "id" | "timestamp">): string {
  return `${first.timestamp}:${first.id}`;
}
