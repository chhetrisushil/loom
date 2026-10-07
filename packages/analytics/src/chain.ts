import type { EventEnvelope } from "@loom/core";

// ── Chain lineage (ADR 0109 D6) ───────────────────────────────────────────────
//
// A continue-as-new chain is a sequence of executions linked by `EXECUTION_CONTINUED` (predecessor
// -> successor) and `EXECUTION_STARTED.continuedFrom` (successor -> predecessor). This is a PROJECTION
// over those two facts, folded from event logs the caller already has: no new state, no SPI, no
// durable event. It answers "which executions are generations of this one", "in what order" and
// "which is the current head".
//
// Chain identity is read the way the kernel's fold reads it, never from raw sequence 0 alone: a
// fork's `forkChain` stamp (the fork LEFT the chain, ADR 0109 D7) replaces whatever the copied
// sequence-0 payload says, so a fork of `chain~2` is its own one-generation chain.

export type ChainGenerationStatus =
  | "running"
  | "suspended"
  | "completed"
  | "failed"
  | "cancelled"
  | "continued";

export interface ChainGeneration {
  executionId: string;
  /** 0 for the first execution of the chain (its id IS the chain id), then 1, 2, ... */
  generation: number;
  /** The execution this one was started from, when it is a successor. */
  continuedFrom?: string;
  /** The successor it handed over to, once `EXECUTION_CONTINUED` committed. */
  continuedTo?: string;
  status: ChainGenerationStatus;
  /** Journal timestamp of its `EXECUTION_STARTED`. */
  startedAt?: number;
}

export interface ChainLineage {
  chainId: string;
  /** Ascending by generation. Only generations whose events were supplied appear. */
  generations: ChainGeneration[];
  /** The newest supplied generation that has not continued: the one a message is delivered to. */
  head: string;
  /**
   * True when generations `0..n` are all present and each names the next. False when a log was not
   * supplied (or was reclaimed by retention): the lineage is then a lower bound.
   */
  complete: boolean;
}

interface Folded {
  executionId: string;
  chainId: string;
  generation: number;
  continuedFrom?: string;
  continuedTo?: string;
  status: ChainGenerationStatus;
  startedAt?: number;
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function identityOf(first: EventEnvelope): {
  chainId: string;
  generation: number;
  continuedFrom?: string;
} {
  const valid = (v: unknown): { chainId: string; generation: number } | undefined =>
    isPlain(v) &&
    typeof v.chainId === "string" &&
    v.chainId.length > 0 &&
    Number.isSafeInteger(v.generation) &&
    (v.generation as number) >= 0
      ? { chainId: v.chainId, generation: v.generation as number }
      : undefined;
  const fork = valid(first.metadata?.forkChain);
  if (fork !== undefined) return fork; // a fork left its chain: no continuedFrom
  const own = valid(first.payload);
  if (own === undefined) return { chainId: first.executionId, generation: 0 };
  const from = isPlain(first.payload) ? first.payload.continuedFrom : undefined;
  const continuedFrom =
    isPlain(from) && typeof from.executionId === "string" ? from.executionId : undefined;
  return { ...own, ...(continuedFrom !== undefined && { continuedFrom }) };
}

function foldOne(events: readonly EventEnvelope[]): Folded | undefined {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const first = ordered[0];
  if (first === undefined || first.eventType !== "EXECUTION_STARTED") return undefined;
  const folded: Folded = {
    executionId: first.executionId,
    ...identityOf(first),
    status: "running",
    startedAt: first.timestamp,
  };
  for (const e of ordered) {
    switch (e.eventType) {
      case "EXECUTION_SUSPENDED":
        folded.status = "suspended";
        break;
      case "EXECUTION_RESUMED":
      case "EXECUTION_RECOVERED":
        if (folded.status === "suspended") folded.status = "running";
        break;
      case "EXECUTION_COMPLETED":
        folded.status = "completed";
        break;
      case "EXECUTION_FAILED":
        folded.status = "failed";
        break;
      case "EXECUTION_CANCELLED":
        folded.status = "cancelled";
        break;
      case "EXECUTION_CONTINUED": {
        // Only a kernel-stamped envelope counts (an app event of that name is not a fact).
        const to = isPlain(e.payload) ? e.payload.successorId : undefined;
        if (e.metadata?.kernel === true && typeof to === "string" && to.length > 0) {
          folded.status = "continued";
          folded.continuedTo = to;
        }
        break;
      }
    }
  }
  return folded;
}

/**
 * The lineage of the chain `executionId` belongs to, folded from `events` (the logs of any
 * executions, in any order, may be mixed; unrelated ones are ignored). `undefined` when
 * `executionId` has no `EXECUTION_STARTED` among them.
 */
export function chainLineage(
  events: readonly EventEnvelope[],
  executionId: string
): ChainLineage | undefined {
  const byExecution = new Map<string, EventEnvelope[]>();
  for (const e of events) {
    const list = byExecution.get(e.executionId);
    if (list === undefined) byExecution.set(e.executionId, [e]);
    else list.push(e);
  }
  const folds = new Map<string, Folded>();
  for (const [id, list] of byExecution) {
    const f = foldOne(list);
    if (f !== undefined) folds.set(id, f);
  }
  const anchor = folds.get(executionId);
  if (anchor === undefined) return undefined;
  const members = [...folds.values()]
    .filter((f) => f.chainId === anchor.chainId)
    .sort((a, b) => a.generation - b.generation);
  const generations: ChainGeneration[] = members.map((m) => ({
    executionId: m.executionId,
    generation: m.generation,
    ...(m.continuedFrom !== undefined && { continuedFrom: m.continuedFrom }),
    ...(m.continuedTo !== undefined && { continuedTo: m.continuedTo }),
    status: m.status,
    ...(m.startedAt !== undefined && { startedAt: m.startedAt }),
  }));
  let complete = generations.length > 0 && generations[0]?.generation === 0;
  for (let i = 0; complete && i < generations.length; i++) {
    const g = generations[i] as ChainGeneration;
    if (g.generation !== i) complete = false;
    const next = generations[i + 1];
    if (next !== undefined && g.continuedTo !== undefined && g.continuedTo !== next.executionId) {
      complete = false;
    }
  }
  const head =
    [...generations].reverse().find((g) => g.status !== "continued") ??
    (generations[generations.length - 1] as ChainGeneration);
  return { chainId: anchor.chainId, generations, head: head.executionId, complete };
}
