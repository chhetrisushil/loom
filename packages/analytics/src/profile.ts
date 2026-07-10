import type { EventEnvelope } from "@loom/core";

// ── Runtime observability / profiler (ADR 0029) ──────────────────────────────
//
// Read-only diagnostic lenses over the durable log — "DevTools for Loom". Every
// event carries a wall-clock `timestamp`, so a flame graph (self/total time per
// step) and a latency breakdown (busy vs. suspended, per-step, decision counts)
// fall straight out of the log with no schema change and no hot-path cost.

export type FlameKind = "execution" | "step" | "parallel";

export interface FlameNode {
  label: string;
  kind: FlameKind;
  startMs?: number;
  endMs?: number;
  /** Wall-clock span (endMs − startMs). */
  totalMs: number;
  /** totalMs minus the wall-clock of children (clamped ≥ 0; parallel children overlap). */
  selfMs: number;
  attempts?: number;
  status?: string;
  children: FlameNode[];
}

interface StepSpan {
  stepId: string;
  startMs: number;
  endMs?: number;
  attempts: number;
  status: string;
}

interface ParallelWindow {
  startMs: number;
  endMs: number;
  stepIds: Set<string>;
}

const TERMINAL_STEP: Record<string, string> = {
  STEP_COMPLETED: "completed",
  STEP_FAILED: "failed",
  STEP_CANCELLED: "cancelled",
};

function eventsForExecution(events: EventEnvelope[], executionId?: string): EventEnvelope[] {
  const target = executionId ?? events[0]?.executionId;
  if (target === undefined) return [];
  return events.filter((e) => e.executionId === target).sort((a, b) => a.sequence - b.sequence);
}

function spanTotal(n: FlameNode): number {
  return n.totalMs;
}

/**
 * P1 — a flame graph for one execution. Steps are leaves; a `PARALLEL_STARTED`/
 * `PARALLEL_COMPLETED` window groups its steps under a `parallel` node. Nesting is
 * derived from timing + parallel windows (frames are flat — there are no parent
 * pointers), so this is an honest two-level tree, not a synthetic deep stack.
 */
export function flameGraph(events: EventEnvelope[], executionId?: string): FlameNode {
  const scoped = eventsForExecution(events, executionId);
  const id = executionId ?? scoped[0]?.executionId ?? "(none)";

  const spans = new Map<string, StepSpan>();
  const windows: ParallelWindow[] = [];
  let openWindow: { startMs: number; stepIds: Set<string> } | undefined;

  for (const e of scoped) {
    const p = e.payload as { stepId?: string; stepIds?: string[]; attempt?: number };
    switch (e.eventType) {
      case "STEP_STARTED": {
        if (p.stepId === undefined) break;
        const prev = spans.get(p.stepId);
        // firstStartedAt semantics: keep the earliest start, count attempts.
        if (prev === undefined) {
          spans.set(p.stepId, {
            stepId: p.stepId,
            startMs: e.timestamp,
            attempts: 1,
            status: "running",
          });
        } else {
          prev.attempts += 1;
        }
        break;
      }
      case "STEP_COMPLETED":
      case "STEP_FAILED":
      case "STEP_CANCELLED": {
        if (p.stepId === undefined) break;
        const span = spans.get(p.stepId);
        if (span !== undefined) {
          span.endMs = e.timestamp;
          span.status = TERMINAL_STEP[e.eventType] ?? span.status;
        }
        break;
      }
      case "PARALLEL_STARTED": {
        openWindow = { startMs: e.timestamp, stepIds: new Set(p.stepIds ?? []) };
        break;
      }
      case "PARALLEL_COMPLETED": {
        if (openWindow !== undefined) {
          windows.push({ ...openWindow, endMs: e.timestamp });
          openWindow = undefined;
        }
        break;
      }
    }
  }
  if (openWindow !== undefined) {
    // Unclosed window (execution still running / crashed) — bound it at the last event.
    const lastTs = scoped[scoped.length - 1]?.timestamp ?? openWindow.startMs;
    windows.push({ ...openWindow, endMs: lastTs });
  }

  const leaf = (span: StepSpan): FlameNode => {
    const total = (span.endMs ?? span.startMs) - span.startMs;
    return {
      label: span.stepId,
      kind: "step",
      startMs: span.startMs,
      ...(span.endMs !== undefined && { endMs: span.endMs }),
      totalMs: total,
      selfMs: total,
      attempts: span.attempts,
      status: span.status,
      children: [],
    };
  };

  const claimed = new Set<string>();
  const parallelNodes: FlameNode[] = windows.map((w) => {
    const kids: FlameNode[] = [];
    for (const span of spans.values()) {
      if (w.stepIds.has(span.stepId)) {
        claimed.add(span.stepId);
        kids.push(leaf(span));
      }
    }
    kids.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
    const total = w.endMs - w.startMs;
    return {
      label: `parallel(${kids.length})`,
      kind: "parallel",
      startMs: w.startMs,
      endMs: w.endMs,
      totalMs: total,
      selfMs: Math.max(0, total - kids.reduce((s, k) => s + spanTotal(k), 0)),
      children: kids,
    };
  });

  const topLevel: FlameNode[] = [...parallelNodes];
  for (const span of spans.values()) {
    if (!claimed.has(span.stepId)) topLevel.push(leaf(span));
  }
  topLevel.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));

  const startMs = scoped[0]?.timestamp;
  const endMs = scoped[scoped.length - 1]?.timestamp;
  const total = startMs !== undefined && endMs !== undefined ? endMs - startMs : 0;
  return {
    label: id,
    kind: "execution",
    ...(startMs !== undefined && { startMs }),
    ...(endMs !== undefined && { endMs }),
    totalMs: total,
    selfMs: Math.max(0, total - topLevel.reduce((s, k) => s + spanTotal(k), 0)),
    children: topLevel,
  };
}

export interface StepLatency {
  count: number;
  totalMs: number;
  meanMs: number;
  maxMs: number;
}

export interface LatencyBreakdown {
  executions: number;
  /** Sum of per-execution wall-clock (first→last event). */
  wallMs: number;
  /** Sum of step durations (work time). */
  busyMs: number;
  /** Sum of suspend→resume gaps (parked time). */
  suspendedMs: number;
  stepCount: number;
  suspends: number;
  resumes: number;
  decisions: number;
  /** Aggregate over every step. */
  steps: StepLatency;
  /** Per-stepId aggregate. */
  byStep: Record<string, StepLatency>;
  /** ADR 0029 P3 — inert until the memoization / prediction seams land (see #cache). */
  cacheHitRatio: number | null;
  predictionAccuracy: number | null;
}

function stat(durations: number[]): StepLatency {
  const totalMs = durations.reduce((s, d) => s + d, 0);
  const count = durations.length;
  return {
    count,
    totalMs,
    meanMs: count > 0 ? totalMs / count : 0,
    maxMs: count > 0 ? Math.max(...durations) : 0,
  };
}

/**
 * P2 — latency breakdown across the log: wall vs. busy vs. suspended time, per-step
 * durations, and suspend/resume/decision counts. Aggregates over every execution in
 * `events` (pass one execution's events for a single-run view).
 */
export function latencyBreakdown(events: EventEnvelope[]): LatencyBreakdown {
  const byExec = new Map<string, EventEnvelope[]>();
  for (const e of events) {
    const list = byExec.get(e.executionId) ?? [];
    list.push(e);
    byExec.set(e.executionId, list);
  }

  let wallMs = 0;
  let suspendedMs = 0;
  let suspends = 0;
  let resumes = 0;
  let decisions = 0;
  const perStep = new Map<string, number[]>();

  for (const list of byExec.values()) {
    const ordered = [...list].sort((a, b) => a.sequence - b.sequence);
    const first = ordered[0]?.timestamp;
    const last = ordered[ordered.length - 1]?.timestamp;
    if (first !== undefined && last !== undefined) wallMs += last - first;

    const starts = new Map<string, number>();
    let suspendedAt: number | undefined;
    for (const e of ordered) {
      const p = e.payload as { stepId?: string };
      switch (e.eventType) {
        case "STEP_STARTED":
          if (p.stepId !== undefined && !starts.has(p.stepId)) starts.set(p.stepId, e.timestamp);
          break;
        case "STEP_COMPLETED":
        case "STEP_FAILED":
        case "STEP_CANCELLED": {
          if (p.stepId === undefined) break;
          const s = starts.get(p.stepId);
          if (s !== undefined) {
            const arr = perStep.get(p.stepId) ?? [];
            arr.push(e.timestamp - s);
            perStep.set(p.stepId, arr);
          }
          break;
        }
        case "EXECUTION_SUSPENDED":
          suspends += 1;
          suspendedAt = e.timestamp;
          break;
        case "EXECUTION_RESUMED":
          resumes += 1;
          if (suspendedAt !== undefined) {
            suspendedMs += e.timestamp - suspendedAt;
            suspendedAt = undefined;
          }
          break;
        case "DECISION_RECORDED":
          decisions += 1;
          break;
      }
    }
  }

  const byStep: Record<string, StepLatency> = {};
  const all: number[] = [];
  for (const [stepId, durs] of perStep) {
    byStep[stepId] = stat(durs);
    all.push(...durs);
  }
  const steps = stat(all);

  return {
    executions: byExec.size,
    wallMs,
    busyMs: steps.totalMs,
    suspendedMs,
    stepCount: steps.count,
    suspends,
    resumes,
    decisions,
    steps,
    byStep,
    cacheHitRatio: null,
    predictionAccuracy: null,
  };
}

export interface ExecutionProfile {
  executionId: string;
  flame: FlameNode;
  latency: LatencyBreakdown;
}

/** Combined per-execution profile: flame graph + latency breakdown for one run. */
export function profile(events: EventEnvelope[], executionId: string): ExecutionProfile {
  const scoped = events.filter((e) => e.executionId === executionId);
  return {
    executionId,
    flame: flameGraph(scoped, executionId),
    latency: latencyBreakdown(scoped),
  };
}

function renderNode(n: FlameNode, depth: number, lines: string[]): void {
  const indent = "  ".repeat(depth);
  const meta =
    n.kind === "step"
      ? ` [${n.status}${n.attempts && n.attempts > 1 ? ` ×${n.attempts}` : ""}]`
      : "";
  lines.push(`${indent}${n.label} — ${n.totalMs}ms (self ${n.selfMs}ms)${meta}`);
  for (const c of n.children) renderNode(c, depth + 1, lines);
}

/** Human-readable rendering for `loom profile`. */
export function formatProfile(p: ExecutionProfile): string {
  const lines: string[] = [`profile ${p.executionId}`, "", "flame graph:"];
  renderNode(p.flame, 1, lines);
  const l = p.latency;
  lines.push(
    "",
    "latency:",
    `  wall ${l.wallMs}ms · busy ${l.busyMs}ms · suspended ${l.suspendedMs}ms`,
    `  steps ${l.stepCount} (mean ${Math.round(l.steps.meanMs)}ms, max ${l.steps.maxMs}ms) · suspends ${l.suspends} · resumes ${l.resumes} · decisions ${l.decisions}`
  );
  return lines.join("\n");
}
