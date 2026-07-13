import { buildApp } from "./app";

// A headless driver that runs the release-audit swarm end to end, offline (no API
// key). It runs two goals: a medium-risk one that pauses for a human sign-off, and
// a low-risk one that auto-signs-off under the risk policy.

const REVIEW_GOAL =
  "Audit checkout-service for the 2.4 release; sign off if low risk else wait for my approval.";
const LOW_GOAL = "Audit payments-service for the 2.3.1 patch; sign off automatically if low risk.";

async function main(): Promise<void> {
  const { app, conductor } = buildApp({ storage: { kind: "memory" } });

  console.log(
    "🛡️  Least-privilege policy$ active: each agent is scoped to its own audit tool, and the\n" +
      "    fleet is read-only (deploy/rollback/promote/delete effects are denied by the K2 ring).\n"
  );

  // ── Run 1: medium risk → pauses for a human sign-off ──────────────────────
  console.log(`\n▶ ${REVIEW_GOAL}`);
  const run1 = conductor.run(REVIEW_GOAL);
  // Poll until the swarm surfaces a pending sign-off, then approve it.
  await waitUntil(() => conductor.getState().pending !== null);
  console.log("  ⏸  awaiting human sign-off — approving…");
  conductor.resolveApproval(true, "ada@example.com");
  const r1 = await run1;
  console.log(`  ✅ ${r1.phase} — risk=${r1.risk}, signed off by ${r1.signoff.approvedBy}`);
  console.log(`     plan (recorded durably): ${r1.plan.map((s) => s.capabilityId).join(" → ")}`);

  // ── Run 2: low risk → auto sign-off (no human) ────────────────────────────
  console.log(`\n▶ ${LOW_GOAL}`);
  const r2 = await conductor.run(LOW_GOAL);
  console.log(`  ✅ ${r2.phase} — risk=${r2.risk}, signed off by ${r2.signoff.approvedBy} (auto)`);

  console.log(
    `\nInspect the durable plan record:\n  events for plan-${r1.runId} include a PLAN_COMPOSED event with the ${r1.plan.length}-step pipeline.\n`
  );
  await app.close();
}

function waitUntil(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      if (pred()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("timed out waiting for pending approval"));
        return;
      }
      setTimeout(tick, 15);
    };
    tick();
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
