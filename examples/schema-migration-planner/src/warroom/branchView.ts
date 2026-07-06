import type { RiskLevel } from "../domain";
import type { StrategyId, StrategyOutcome } from "./strategies";

// ── Branch surface view model ─────────────────────────────────────────────────
//
// The projected state of the "branch" A2UI surface — what the Migration Board
// renders. Framework-agnostic and type-only so the Web Components client can import
// it without pulling in any server code.

export type BranchStatus =
  | "proposed" // a candidate the operator can explore
  | "simulating" // forked, dry-run in flight
  | "simulated" // dry-run done, projected outcome available
  | "committing" // the winner, applying for real
  | "committed" // the winner, applied
  | "rejected"; // a losing branch, kept as lineage

export interface BranchView {
  strategy: StrategyId;
  label: string;
  branchName: string; // git-style ref name, e.g. "spec/online-ddl"
  executionId?: string;
  status: BranchStatus;
  risk: RiskLevel;
  description: string;
  // Live backfill progress (0–100) while `status === "simulating"`, streamed from
  // the branch's speculative simulation so the graph shows bars advancing at once.
  progress?: number;
  outcome?: StrategyOutcome;
  winner?: boolean;
}

export type BranchPhase =
  | "idle"
  | "prepared" // gate reached; branches proposed, not yet explored
  | "exploring" // speculative forks running
  | "explored" // all dry-runs done; awaiting a promote
  | "committing" // winner applying for real
  | "committed"; // done

export interface BranchSurface {
  target: string;
  parentExecutionId: string | null;
  forkPoint: number | null; // the sequence the branches fork at
  phase: BranchPhase;
  branches: BranchView[];
  // Immutable fork lineage: how many branches were spun off the gate.
  lineageCount: number;
  // The ref table (git-style movable pointers).
  refs: Array<{ name: string; executionId: string; tip: number }>;
  note: string;
}

export function emptyBranchSurface(): BranchSurface {
  return {
    target: "",
    parentExecutionId: null,
    forkPoint: null,
    phase: "idle",
    branches: [],
    lineageCount: 0,
    refs: [],
    note: "Branch-only, no merge: mutually-exclusive migrations can't be reconciled — you pick one.",
  };
}

export type { StrategyOutcome };
