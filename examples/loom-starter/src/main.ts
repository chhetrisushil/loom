import { releaseApprovalFlow } from "../app/flows/release-approval/flow";
import { buildApp } from "./config";

// A tiny end-to-end driver: start the flow, let it pause at the approval gate,
// then resume it with a decision — persisting to SQLite so the `loom` CLI can
// inspect the log (`loom logs`, `loom debug`, `loom inspect`).
async function main(): Promise<void> {
  const app = buildApp({ storage: { kind: "sqlite", dir: ".data" } });

  const handle = await app.runtime.start(releaseApprovalFlow, {
    service: "checkout-api",
    changeType: "hotfix", // → medium risk → pauses for approval
  });

  const suspended = await handle.waitForSuspend();
  console.log(`⏸  suspended at #${suspended.sequence} —`, surface(app, handle.executionId));

  // …a human reviews and approves. Even if this process restarted, the resume
  // below would still continue the execution from its durable checkpoint.
  const resumed = await app.runtime.resume(handle.executionId, {
    eventType: "ApprovalGranted",
    payload: { approved: true, approvedBy: "ada@example.com" },
  });
  const done = await resumed.waitForCompletion();

  console.log(`✅ ${done.status} —`, done.variables._output);
  console.log("   surface:", surface(app, handle.executionId));
  console.log(`\nInspect it:  loom logs --db .data/events.db ${handle.executionId}`);

  await app.close();
}

function surface(app: ReturnType<typeof buildApp>, executionId: string): unknown {
  return app.projectionRuntime.getState("ui", executionId);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
