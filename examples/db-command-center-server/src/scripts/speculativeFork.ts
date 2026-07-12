import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EffectRuntime } from "@loom/effect-runtime";
/**
 * Speculative fork demo — git-style branching for agent executions (branch-only).
 *
 * A "scale read replicas" remediation task runs to its human-approval gate and
 * suspends. Instead of forcing a single approve/reject, an operator *forks* the
 * suspended execution into two speculative branches — "approve" and "reject" —
 * runs each to completion to preview its outcome, then keeps the winner by
 * moving the `main` ref onto it (`promote`). The original task is never touched.
 *
 * There is deliberately no merge: divergent ExecutionStates have no principled
 * join, so we pick a winning branch rather than reconcile.
 *
 * Run it:  pnpm --filter @loom/db-command-center-server demo:fork
 */
import { SqliteBranchRegistry, SqliteEventStore, SqliteSnapshotStore } from "@loom/plugin-sqlite";

import { WorkflowRuntime } from "@loom/workflow-runtime";
import { ScaleReplicasFlow } from "../capabilities/flows";

interface Remediation {
  applied: boolean;
  summary: string;
  newLagMs?: number;
}

const line = (s = ""): void => {
  process.stdout.write(`${s}\n`);
};
const rule = (): void => line("─".repeat(72));

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "loom-spec-fork-"));
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
  runtime.registerFlow(ScaleReplicasFlow.definition, ScaleReplicasFlow.runner);

  const target = "orders-db-primary";
  const taskId = "task-mission-1-scale-read-replicas";

  try {
    rule();
    line("① Start the remediation task and run it to the approval gate");
    rule();
    const handle = await runtime.start(
      ScaleReplicasFlow,
      { target, addReplicas: 2 },
      { executionId: taskId }
    );
    const suspended = await handle.waitForSuspend();
    const S = suspended.sequence;
    line(`   task ${taskId}`);
    line(`   status: ${suspended.status}  (awaiting "${suspended.suspendedOn?.on}")`);
    line(`   fork point: sequence ${S}`);
    // Point the canonical "main" ref at the suspended task.
    await branchRegistry.putRef({
      name: "main",
      executionId: taskId,
      tip: S,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    rule();
    line("② Fork two speculative branches from the gate — approve vs reject");
    rule();
    const approveBranch = await runtime.fork(taskId, S, { branchName: "spec/approve" });
    const rejectBranch = await runtime.fork(taskId, S, { branchName: "spec/reject" });
    line(`   spec/approve → ${approveBranch.executionId}`);
    line(`   spec/reject  → ${rejectBranch.executionId}`);
    line(`   both forked from ${taskId}@${S} (copy-on-write, parent untouched)`);

    rule();
    line("③ Run each branch to completion to preview its outcome");
    rule();
    const approveState = await (
      await runtime.resume(approveBranch.executionId, {
        eventType: "ApprovalGranted",
        payload: { approved: true, approvedBy: "demo-operator" },
      })
    ).waitForCompletion();
    const rejectState = await (
      await runtime.resume(rejectBranch.executionId, {
        eventType: "ApprovalGranted",
        payload: { approved: false, approvedBy: "demo-operator" },
      })
    ).waitForCompletion();
    // Advance each branch's ref tip to its new head as it grows.
    await branchRegistry.moveTip("spec/approve", approveState.sequence);
    await branchRegistry.moveTip("spec/reject", rejectState.sequence);
    const approved = approveState.variables._output as Remediation;
    const rejected = rejectState.variables._output as Remediation;
    line(`   spec/approve → applied=${approved.applied}  newLagMs=${approved.newLagMs ?? "—"}`);
    line(`                  ${approved.summary}`);
    line(`   spec/reject  → applied=${rejected.applied}`);
    line(`                  ${rejected.summary}`);

    rule();
    line("④ Original task is untouched — still suspended at the gate");
    rule();
    const parentEvents = await eventStore.read(taskId);
    line(`   ${taskId} last event: ${parentEvents[parentEvents.length - 1]?.eventType}`);
    line(`   (parent log ends at sequence ${parentEvents[parentEvents.length - 1]?.sequence})`);

    rule();
    line("⑤ Pick the winner — promote spec/approve onto main (no merge)");
    rule();
    line("   before:");
    for (const r of await branchRegistry.listRefs()) {
      line(`     ${r.name.padEnd(14)} → ${r.executionId}  @${r.tip}`);
    }
    await branchRegistry.promote("spec/approve", "main");
    line("   after promote:");
    for (const r of await branchRegistry.listRefs()) {
      const win = r.name === "main" ? "  ← now names the approved branch" : "";
      line(`     ${r.name.padEnd(14)} → ${r.executionId}  @${r.tip}${win}`);
    }
    line("");
    const forkCount = (await branchRegistry.children(taskId)).length;
    line(
      `   lineage: ${forkCount} branches forked from ${taskId}; the losing branch remains immutable and independently resumable.`
    );
    rule();
    line("✓ Speculative fork complete — branched, previewed, and picked a winner.");
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
