import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EffectRuntime } from "@loom/effect-runtime";
/**
 * Incident War Room — git-style branching for agent executions (branch-only).
 *
 * A replica-lag remediation runs to its human-approval gate and suspends. There
 * is more than one defensible fix, and they are *mutually exclusive* — you can't
 * both fail over the primary AND keep scaling its replicas. So instead of a
 * single approve/reject, the operator *forks* the suspended execution once per
 * candidate strategy, resumes each in dry-run (simulate) mode to preview its
 * projected outcome, compares them, then keeps the winner by moving the `main`
 * ref onto a real, committed apply (`promote`). The original task is never touched.
 *
 * There is deliberately no merge: divergent ExecutionStates have no principled
 * join, so we pick a winning branch rather than reconcile.
 *
 * Run it:  pnpm --filter @loom/incident-war-room demo:fork
 */
import { SqliteBranchRegistry, SqliteEventStore, SqliteSnapshotStore } from "@loom/plugin-sqlite";

import { WorkflowRuntime } from "@loom/workflow-runtime";
import { RemediateLagFlow } from "../capabilities/flows";
import { STRATEGIES, type StrategyId, type StrategyOutcome } from "../warroom/strategies";

const line = (s = ""): void => {
  process.stdout.write(`${s}\n`);
};
const rule = (): void => line("─".repeat(76));

async function simulateBranch(
  runtime: WorkflowRuntime,
  branchRegistry: SqliteBranchRegistry,
  parentId: string,
  forkSequence: number,
  strategy: StrategyId
): Promise<StrategyOutcome> {
  const branchName = `spec/${strategy}`;
  const fork = await runtime.fork(parentId, forkSequence, { branchName });
  const resumed = await runtime.resume(fork.executionId, {
    eventType: "RemediationDecision",
    payload: { approved: true, strategy, simulate: true, approvedBy: "explorer" },
  });
  const state = await resumed.waitForCompletion();
  await branchRegistry.moveTip(branchName, state.sequence);
  return state.variables._output as StrategyOutcome;
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "loom-war-room-"));
  const eventStore = new SqliteEventStore(join(dataDir, "events.db"));
  const snapshotStore = new SqliteSnapshotStore(join(dataDir, "snapshots.db"));
  const branchRegistry = new SqliteBranchRegistry(join(dataDir, "branches.db"));
  const effectRuntime = new EffectRuntime();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore,
    effectRuntime,
    branchRegistry,
  });
  runtime.registerFlow(RemediateLagFlow.definition, RemediateLagFlow.runner);

  const target = "orders-db-primary";
  const taskId = "task-remediate-lag";

  try {
    rule();
    line("① Run the remediation to its human-approval gate");
    rule();
    const handle = await runtime.start(RemediateLagFlow, { target }, { executionId: taskId });
    const suspended = await handle.waitForSuspend();
    const S = suspended.sequence;
    line(`   task ${taskId}`);
    line(`   status: ${suspended.status}  (awaiting "${suspended.suspendedOn?.on}")`);
    line(`   fork point: sequence ${S}`);
    await branchRegistry.putRef({
      name: "main",
      executionId: taskId,
      tip: S,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    rule();
    line(`② Fork ${STRATEGIES.length} speculative branches — one per candidate strategy`);
    rule();
    for (const s of STRATEGIES) {
      line(`   spec/${s.id.padEnd(18)} risk ${s.risk.padEnd(6)} ${s.description}`);
    }

    rule();
    line("③ Simulate each branch (dry-run) to preview its projected outcome");
    rule();
    for (const s of STRATEGIES) {
      const outcome = await simulateBranch(runtime, branchRegistry, taskId, S, s.id);
      line(
        `   ${s.id.padEnd(18)} lag→${String(outcome.projectedLagMs).padStart(4)}ms  ` +
          `eta ${outcome.etaMinutes}m  downtime ${outcome.downtimeSeconds}s  $${outcome.costPerHourUsd}/hr`
      );
    }

    rule();
    line("④ Original task is untouched — still suspended at the gate");
    rule();
    const parentEvents = await eventStore.read(taskId);
    line(`   ${taskId} last event: ${parentEvents[parentEvents.length - 1]?.eventType}`);
    line(`   (parent log ends at sequence ${parentEvents[parentEvents.length - 1]?.sequence})`);

    // The operator's pick: scale-replicas — no downtime and a big lag win.
    const winner: StrategyId = "scale-replicas";
    rule();
    line(`⑤ Promote "${winner}" onto main and apply it FOR REAL (no merge)`);
    rule();
    line("   before:");
    for (const r of await branchRegistry.listRefs()) {
      line(`     ${r.name.padEnd(20)} → ${r.executionId}  @${r.tip}`);
    }
    await branchRegistry.promote(`spec/${winner}`, "main");
    // Commit for real: a fresh branch forked from the gate, resumed simulate:false.
    const commit = await runtime.fork(taskId, S, { branchName: "commit" });
    const committed = await (
      await runtime.resume(commit.executionId, {
        eventType: "RemediationDecision",
        payload: { approved: true, strategy: winner, simulate: false, approvedBy: "operator" },
      })
    ).waitForCompletion();
    await branchRegistry.moveTip("commit", committed.sequence);
    await branchRegistry.promote("commit", "main");
    const applied = committed.variables._output as StrategyOutcome;

    line("   after promote:");
    for (const r of await branchRegistry.listRefs()) {
      const win = r.name === "main" ? "  ← now names the applied remediation" : "";
      line(`     ${r.name.padEnd(20)} → ${r.executionId}  @${r.tip}${win}`);
    }
    line("");
    line(`   applied: ${applied.summary}`);
    const forkCount = (await branchRegistry.children(taskId)).length;
    line("");
    line(
      `   lineage: ${forkCount} branches forked from ${taskId}; the losing branches remain immutable and independently resumable — the alternatives-considered audit trail.`
    );
    rule();
    line("✓ War Room complete — branched, simulated, compared, and picked a winner.");
  } finally {
    eventStore.close();
    snapshotStore.close();
    branchRegistry.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
