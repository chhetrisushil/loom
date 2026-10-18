import { projection$ } from "@loom/core";
import type { EventEnvelope } from "@loom/core";
import { FoldedModelEngine, foldedCapable } from "./FoldedModelEngine";
import { InMemoryReadModelStore } from "./InMemoryReadModelStore";
import type { FoldedRecord } from "./types";

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

// ── live-cache helpers (Task 6b; extended by 6c) ───────────────────────────────
export const X = "u1:wf:ingest-d1";

/** Deterministic evidence: how many times the engine went to the store for a base. */
export class CountingStore extends InMemoryReadModelStore {
  reads = 0;
  override async getFolded(
    modelId: string,
    executionIds: readonly string[]
  ): Promise<FoldedRecord[]> {
    this.reads++;
    return super.getFolded(modelId, executionIds);
  }
}

export async function node(
  store: CountingStore,
  opts: ConstructorParameters<typeof FoldedModelEngine>[2] = {},
  onError: (e: unknown) => void = (e) => {
    throw e;
  }
) {
  if (!foldedCapable(store)) throw new Error("store is not folded-capable");
  const engine = new FoldedModelEngine(store, onError, opts);
  await engine.register({ projection: ingestProjection() });
  return engine;
}
export const step = (id: string, n: number) => evt(id, n, "STEP_COMPLETED", { step: `s${n}` });
export const stepsOf = async (store: InMemoryReadModelStore, id = X) =>
  ((await store.getFolded("ingest-status", [id]))[0]?.state as { steps: number } | undefined)
    ?.steps;
