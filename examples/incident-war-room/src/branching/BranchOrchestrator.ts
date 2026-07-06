import type { A2UIEmitter } from "@loom/a2ui";
import type { BranchRegistry } from "@loom/event-runtime";
import { parallelLimit } from "@loom/scheduler";
import type { WorkflowRuntime } from "@loom/workflow-runtime";
import { RemediateLagFlow } from "../capabilities/flows";
import type { BranchSurface, BranchView } from "../warroom/branchView";
import { emptyBranchSurface } from "../warroom/branchView";
import {
  STRATEGIES,
  type StrategyId,
  type StrategyOutcome,
  strategyById,
} from "../warroom/strategies";

// ── BranchOrchestrator — Loom's git-style branching, made a live experience ────
//
// This is the whole point of the example. It drives the fork → simulate →
// compare → promote loop over a durably-suspended remediation execution:
//
//   1. prepare()  — start the remediation flow, run it to the approval gate
//                   (ctx.suspend), point `main` at it, and propose the candidate
//                   branches. The parent is now a durable fork point.
//   2. explore()  — fork one child per candidate strategy from the gate, then
//                   resume each *in simulate mode* CONCURRENTLY (@loom/scheduler
//                   parallelLimit — deterministic, input-ordered results). Each
//                   branch previews its projected outcome without mutating infra.
//                   The parent log is never touched (copy-on-write).
//   3. promote()  — repoint `main` onto the winner (records the decision), then
//                   fork a fresh commit branch and resume it for REAL. Losing
//                   branches remain as immutable lineage — the "alternatives
//                   considered" audit trail. There is no merge.
//
// Every mutation mirrors the BranchSurface to the "branch" A2UI surface, so the
// War Room graph + diff fill in live over SSE.

export interface BranchOrchestratorDeps {
  runtime: WorkflowRuntime;
  branchRegistry: BranchRegistry;
  branch: A2UIEmitter;
}

export class BranchOrchestrator {
  private state: BranchSurface = emptyBranchSurface();
  private remediationExecId: string | null = null;

  constructor(private readonly deps: BranchOrchestratorDeps) {}

  getSurface(): BranchSurface {
    return this.state;
  }

  reset(): void {
    this.state = emptyBranchSurface();
    this.remediationExecId = null;
    this.publish();
  }

  // Phase 1 — run the remediation flow to its durable gate and propose branches.
  async prepare(target: string, remediationExecId: string): Promise<void> {
    const handle = await this.deps.runtime.start(
      RemediateLagFlow,
      { target },
      { executionId: remediationExecId }
    );
    const suspended = await handle.waitForSuspend();
    const forkPoint = suspended.sequence;
    this.remediationExecId = remediationExecId;

    // Point the canonical `main` ref at the suspended remediation execution.
    const now = Date.now();
    await this.deps.branchRegistry.putRef({
      name: "main",
      executionId: remediationExecId,
      tip: forkPoint,
      createdAt: now,
      updatedAt: now,
    });

    this.state = {
      ...emptyBranchSurface(),
      target,
      parentExecutionId: remediationExecId,
      forkPoint,
      phase: "prepared",
      branches: STRATEGIES.map(
        (s): BranchView => ({
          strategy: s.id,
          label: s.label,
          branchName: `spec/${s.id}`,
          status: "proposed",
          risk: s.risk,
          description: s.description,
        })
      ),
    };
    await this.refreshRefs();
    this.publish();
  }

  // Phase 2 — fork + speculatively simulate every candidate, concurrently.
  async explore(): Promise<StrategyOutcome[]> {
    const parent = this.remediationExecId;
    const forkPoint = this.state.forkPoint;
    if (parent === null || forkPoint === null || this.state.phase === "idle") {
      throw new Error("Cannot explore branches before prepare().");
    }
    this.setPhase("exploring");

    // parallelLimit preserves input order in the result array — the branch list
    // stays deterministic for replay even though the simulations interleave.
    const outcomes = await parallelLimit(
      STRATEGIES.map((s) => async (_signal: AbortSignal) => {
        const branchName = `spec/${s.id}`;
        // Copy-on-write fork of the suspended gate. Parent stays intact.
        const fork = await this.deps.runtime.fork(parent, forkPoint, { branchName });
        this.patchBranch(s.id, { executionId: fork.executionId, status: "simulating" });

        // Resume this branch down the alternate path — dry-run only.
        const resumed = await this.deps.runtime.resume(fork.executionId, {
          eventType: "RemediationDecision",
          payload: { approved: true, strategy: s.id, simulate: true, approvedBy: "explorer" },
        });
        const final = await resumed.waitForCompletion();
        await this.deps.branchRegistry.moveTip(branchName, final.sequence);

        const outcome = final.variables._output as StrategyOutcome;
        this.patchBranch(s.id, { status: "simulated", outcome });
        await this.refreshRefs();
        return outcome;
      }),
      { limit: STRATEGIES.length }
    );

    this.setPhase("explored");
    await this.refreshRefs();
    this.publish();
    return outcomes;
  }

  // Phase 3 — pick a winner: promote its ref onto main (the decision record),
  // then fork a fresh commit branch and apply it FOR REAL. No merge.
  async promote(strategy: StrategyId): Promise<StrategyOutcome> {
    const parent = this.remediationExecId;
    const forkPoint = this.state.forkPoint;
    if (parent === null || forkPoint === null || this.state.phase !== "explored") {
      throw new Error("Cannot promote before branches are explored.");
    }
    const winnerBranch = `spec/${strategy}`;
    this.setPhase("committing");
    this.patchBranch(strategy, { status: "committing", winner: true });
    // Mark the others as rejected (kept immutable as lineage / audit trail).
    for (const s of STRATEGIES) {
      if (s.id !== strategy) this.patchBranch(s.id, { status: "rejected" });
    }

    // Repoint main onto the winning exploration — records the human decision.
    await this.deps.branchRegistry.promote(winnerBranch, "main");

    // Commit for real: a fresh branch forked from the same gate, resumed with
    // simulate:false. The real mutation is itself a durable, replayable execution.
    const commit = await this.deps.runtime.fork(parent, forkPoint, { branchName: "commit" });
    const resumed = await this.deps.runtime.resume(commit.executionId, {
      eventType: "RemediationDecision",
      payload: { approved: true, strategy, simulate: false, approvedBy: "operator" },
    });
    const final = await resumed.waitForCompletion();
    await this.deps.branchRegistry.moveTip("commit", final.sequence);
    // main now names the applied execution — "what we actually did".
    await this.deps.branchRegistry.promote("commit", "main");

    const outcome = final.variables._output as StrategyOutcome;
    this.patchBranch(strategy, { status: "committed", outcome, winner: true });
    this.setPhase("committed");
    await this.refreshRefs();
    this.publish();
    return outcome;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private setPhase(phase: BranchSurface["phase"]): void {
    this.state = { ...this.state, phase };
    this.deps.branch.set("phase", phase);
  }

  private patchBranch(strategy: StrategyId, patch: Partial<BranchView>): void {
    this.state = {
      ...this.state,
      branches: this.state.branches.map((b) => (b.strategy === strategy ? { ...b, ...patch } : b)),
    };
    // Push the whole list so the graph + diff widgets re-read granularly.
    this.deps.branch.set("branches", this.state.branches);
  }

  private async refreshRefs(): Promise<void> {
    const refs = await this.deps.branchRegistry.listRefs();
    this.state = {
      ...this.state,
      refs: refs
        .map((r) => ({ name: r.name, executionId: r.executionId, tip: r.tip }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      lineageCount: this.remediationExecId
        ? (await this.deps.branchRegistry.children(this.remediationExecId)).length
        : 0,
    };
    this.deps.branch.merge("", { refs: this.state.refs, lineageCount: this.state.lineageCount });
  }

  private publish(): void {
    this.deps.branch.set("", this.state);
  }
}

export { STRATEGIES, strategyById };
