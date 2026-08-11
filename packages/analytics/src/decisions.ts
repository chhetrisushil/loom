import type { EventEnvelope } from "@loom/core";

// ── Decision materialization (ADR 0030) ──────────────────────────────────────
//
// Pure, read-only lenses that MATERIALIZE the decision history the log already
// carries: DECISION_RECORDED (choice + D1 descriptive fields) and OUTCOME_RECORDED
// (how a choice turned out). Like every @loom/analytics lens they never write and
// never touch the fold — they turn the durable log into a queryable read-model
// (D2 DecisionStore) and an explainability graph (D3 DecisionGraph). Advisory only
// (P9/P10); decisions still replay from the log via getDecision, not from here.

/** One materialized decision — the folded choice plus D1 descriptive metadata + provenance. */
export interface DecisionRecord {
  decisionId: string;
  choice: unknown;
  rationale?: unknown;
  source?: string;
  /** D1 — the other choices considered. */
  alternatives?: unknown;
  estimatedCostUsd?: number;
  estimatedLatencyMs?: number;
  confidence?: number;
  /** ADR 0079 — the observation the decider saw (the `s` in `(s, a, r)`). */
  context?: Record<string, unknown>;
  /** ADR 0079 — which policy chose, and with what probability. */
  policy?: { id: string; version: string; propensity?: number };
  executionId: string;
  sequence: number;
  timestamp: number;
}

/** One recorded outcome; `decisionId` links it back to the decision that caused it. */
export interface OutcomeRecord {
  key: string;
  success?: boolean;
  score?: number;
  decisionId?: string;
  executionId: string;
  sequence: number;
  timestamp: number;
}

function decisionFrom(e: EventEnvelope): DecisionRecord {
  const p = e.payload as Partial<DecisionRecord> & { decisionId: string; choice: unknown };
  return {
    decisionId: p.decisionId,
    choice: p.choice,
    ...(p.rationale !== undefined && { rationale: p.rationale }),
    ...(p.source !== undefined && { source: p.source }),
    ...(p.alternatives !== undefined && { alternatives: p.alternatives }),
    ...(p.estimatedCostUsd !== undefined && { estimatedCostUsd: p.estimatedCostUsd }),
    ...(p.estimatedLatencyMs !== undefined && { estimatedLatencyMs: p.estimatedLatencyMs }),
    ...(p.confidence !== undefined && { confidence: p.confidence }),
    ...(p.context !== undefined && { context: p.context }),
    ...(p.policy !== undefined && { policy: p.policy }),
    executionId: e.executionId,
    sequence: e.sequence,
    timestamp: e.timestamp,
  };
}

function outcomeFrom(e: EventEnvelope): OutcomeRecord {
  const p = e.payload as Partial<OutcomeRecord> & { key: string };
  return {
    key: p.key,
    ...(p.success !== undefined && { success: p.success }),
    ...(p.score !== undefined && { score: p.score }),
    ...(p.decisionId !== undefined && { decisionId: p.decisionId }),
    executionId: e.executionId,
    sequence: e.sequence,
    timestamp: e.timestamp,
  };
}

/** Every DECISION_RECORDED as a materialized record, in log order. */
export function decisionRecords(events: EventEnvelope[]): DecisionRecord[] {
  return events.filter((e) => e.eventType === "DECISION_RECORDED").map(decisionFrom);
}

/** Every OUTCOME_RECORDED as a materialized record, in log order. */
export function outcomeRecords(events: EventEnvelope[]): OutcomeRecord[] {
  return events.filter((e) => e.eventType === "OUTCOME_RECORDED").map(outcomeFrom);
}

export interface DecisionQuery {
  decisionId?: string;
  executionId?: string;
  source?: string;
  /** Filter to decisions that do (`true`) / do not (`false`) have a linked outcome. */
  hasOutcome?: boolean;
}

/**
 * D2 — a queryable read-model over the decision log. Built once from the events;
 * the query helpers are pure filters over the materialized records.
 */
export interface DecisionStore {
  readonly records: readonly DecisionRecord[];
  readonly outcomes: readonly OutcomeRecord[];
  byId(decisionId: string): DecisionRecord[];
  byExecution(executionId: string): DecisionRecord[];
  bySource(source: string): DecisionRecord[];
  outcomesOf(decisionId: string): OutcomeRecord[];
  query(q: DecisionQuery): DecisionRecord[];
}

export function decisionStore(events: EventEnvelope[]): DecisionStore {
  const records = decisionRecords(events);
  const outcomes = outcomeRecords(events);
  const outcomesByDecision = new Map<string, OutcomeRecord[]>();
  for (const o of outcomes) {
    if (o.decisionId === undefined) continue;
    const list = outcomesByDecision.get(o.decisionId) ?? [];
    list.push(o);
    outcomesByDecision.set(o.decisionId, list);
  }
  const outcomesOf = (decisionId: string): OutcomeRecord[] =>
    outcomesByDecision.get(decisionId) ?? [];

  return {
    records,
    outcomes,
    outcomesOf,
    byId: (decisionId) => records.filter((r) => r.decisionId === decisionId),
    byExecution: (executionId) => records.filter((r) => r.executionId === executionId),
    bySource: (source) => records.filter((r) => r.source === source),
    query: (q) =>
      records.filter((r) => {
        if (q.decisionId !== undefined && r.decisionId !== q.decisionId) return false;
        if (q.executionId !== undefined && r.executionId !== q.executionId) return false;
        if (q.source !== undefined && r.source !== q.source) return false;
        if (q.hasOutcome !== undefined && outcomesOf(r.decisionId).length > 0 !== q.hasOutcome) {
          return false;
        }
        return true;
      }),
  };
}

/** A decision plus the outcomes it produced. */
export interface DecisionNode extends DecisionRecord {
  outcomes: OutcomeRecord[];
}

export type DecisionEdgeKind = "outcome" | "sequence";

/**
 * An explainability edge. `outcome`: decision → the outcome it caused (`to` is the
 * outcome key). `sequence`: decision → the next decision in the same execution
 * (`to` is that decisionId) — the "what did it decide next" thread.
 */
export interface DecisionEdge {
  from: string;
  to: string;
  kind: DecisionEdgeKind;
}

/** D3 — the decision→outcome→next-decision graph, the spine of "why did it choose X". */
export interface DecisionGraph {
  nodes: DecisionNode[];
  edges: DecisionEdge[];
}

export function decisionGraph(events: EventEnvelope[]): DecisionGraph {
  const store = decisionStore(events);
  const nodes: DecisionNode[] = store.records.map((r) => ({
    ...r,
    outcomes: store.outcomesOf(r.decisionId),
  }));

  const edges: DecisionEdge[] = [];
  // decision → outcome
  for (const o of store.outcomes) {
    if (o.decisionId !== undefined) {
      edges.push({ from: o.decisionId, to: o.key, kind: "outcome" });
    }
  }
  // decision → next decision, per execution, in sequence order
  const byExecution = new Map<string, DecisionRecord[]>();
  for (const r of store.records) {
    const list = byExecution.get(r.executionId) ?? [];
    list.push(r);
    byExecution.set(r.executionId, list);
  }
  for (const list of byExecution.values()) {
    const ordered = [...list].sort((a, b) => a.sequence - b.sequence);
    for (let i = 1; i < ordered.length; i++) {
      edges.push({
        from: ordered[i - 1]!.decisionId,
        to: ordered[i]!.decisionId,
        kind: "sequence",
      });
    }
  }
  return { nodes, edges };
}
