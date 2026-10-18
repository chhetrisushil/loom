import { projection$ } from "@loom/core";
import type { EventEnvelope } from "@loom/core";

export interface IngestState {
  status: "queued" | "running" | "done" | "failed";
  steps: number;
  last?: string;
}

export function ingestProjection(version = "1") {
  return projection$<IngestState>({
    id: "ingest-status",
    name: "Ingest status",
    version,
    initialState: { status: "queued", steps: 0 },
    handlers: {
      STEP_COMPLETED: (s, e) => ({
        ...s,
        status: "running",
        steps: s.steps + 1,
        last: (e.payload as { step: string }).step,
      }),
      EXECUTION_COMPLETED: (s) => ({ ...s, status: "done" }),
      EXECUTION_FAILED: (s) => ({ ...s, status: "failed" }),
    },
  });
}

/** `u1:wf:ingest-d1` and `u1:wf:ingest-d1.2` -> "d1" (DocMind's generation suffix). */
export const keyOf = (id: string): string | undefined => /ingest-(.+?)(?:\.\d+)?$/.exec(id)?.[1];
/** The user-scoped prefix before the first ":". */
export const scopeOf = (id: string): string | undefined => id.split(":")[0] || undefined;

export function evt(
  executionId: string,
  sequence: number,
  eventType: string,
  payload: unknown = {}
): EventEnvelope {
  return {
    id: `${executionId}-${sequence}`,
    workflowId: "wf",
    executionId,
    eventType,
    sequence,
    timestamp: 1_000 + sequence,
    payload,
  };
}
