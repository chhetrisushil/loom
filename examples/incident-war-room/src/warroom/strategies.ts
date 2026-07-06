import type { RiskLevel } from "../domain";

// ── Candidate remediation strategies ──────────────────────────────────────────
//
// The incident (read-replica lag spiking on the primary) has more than one
// defensible fix — and they are *mutually exclusive*: you cannot both fail over
// the primary AND keep scaling its replicas. That exclusivity is exactly what
// makes git-style "branch, preview, pick a winner — no merge" the honest model.
//
// Each strategy is projected to a deterministic Outcome so the whole demo runs
// offline. In a real deployment `projectOutcome` would call a dry-run planner
// (e.g. `terraform plan`, a capacity model, a shadow apply) instead.

export type StrategyId = "scale-replicas" | "failover-primary" | "throttle-writes";

export interface Strategy {
  id: StrategyId;
  label: string;
  risk: RiskLevel;
  description: string;
}

// The three candidate branches the operator gets to explore at the gate.
export const STRATEGIES: readonly Strategy[] = [
  {
    id: "scale-replicas",
    label: "Scale read replicas",
    risk: "medium",
    description: "Add 2 read replicas to spread WAL apply load and drain the backlog.",
  },
  {
    id: "failover-primary",
    label: "Fail over the primary",
    risk: "high",
    description: "Promote the healthiest replica to primary; briefly pauses writes.",
  },
  {
    id: "throttle-writes",
    label: "Throttle writes",
    risk: "low",
    description:
      "Rate-limit write QPS so the existing replicas catch up. Degrades write throughput.",
  },
];

export function strategyById(id: StrategyId): Strategy {
  const found = STRATEGIES.find((s) => s.id === id);
  if (!found) throw new Error(`Unknown strategy: ${id}`);
  return found;
}

// The projected (simulate) or realized (real) result of applying a strategy.
// Speculative branches carry `simulated: true`; the promoted, committed branch
// carries `simulated: false, applied: true`.
export interface StrategyOutcome {
  strategy: StrategyId;
  label: string;
  simulated: boolean;
  applied: boolean;
  risk: RiskLevel;
  etaMinutes: number;
  downtimeSeconds: number;
  costPerHourUsd: number;
  // The metric the operator actually cares about: replica lag after the fix.
  projectedLagMs: number;
  summary: string;
}

// Deterministic projection for a strategy. Pure and side-effect-free, so a
// speculative branch can preview an outcome without touching real infrastructure.
export function projectOutcome(
  strategy: StrategyId,
  simulate: boolean,
  target: string
): StrategyOutcome {
  const s = strategyById(strategy);
  const base = {
    strategy,
    label: s.label,
    simulated: simulate,
    applied: !simulate,
    risk: s.risk,
  };
  const verb = simulate ? "Projected" : "Applied";
  switch (strategy) {
    case "scale-replicas":
      return {
        ...base,
        etaMinutes: 4,
        downtimeSeconds: 0,
        costPerHourUsd: 12,
        projectedLagMs: 180,
        summary: `${verb}: +2 read replicas on ${target}. WAL backlog drains, lag falls ~4200 → ~180ms. No downtime; +$12/hr.`,
      };
    case "failover-primary":
      return {
        ...base,
        etaMinutes: 9,
        downtimeSeconds: 12,
        costPerHourUsd: 0,
        projectedLagMs: 20,
        summary: `${verb}: promote healthiest replica to primary on ${target}. Lag ~4200 → ~20ms, but ~12s write pause during cutover.`,
      };
    case "throttle-writes":
      return {
        ...base,
        etaMinutes: 1,
        downtimeSeconds: 0,
        costPerHourUsd: 0,
        projectedLagMs: 600,
        summary: `${verb}: rate-limit writes on ${target} so replicas catch up. Lag ~4200 → ~600ms fast and free, but write throughput is degraded.`,
      };
  }
}

// The resume payload delivered to the suspended remediation flow at the gate —
// carries which branch (strategy) this execution is exploring and whether it is
// a dry-run simulation or the real, committed apply.
export interface RemediationDecision {
  approved: boolean;
  strategy: StrategyId;
  simulate: boolean;
  approvedBy: string;
}
