import { mkdirSync, writeFileSync } from "node:fs";
import { captureGolden } from "@loom/testing";
import { releaseApprovalFlow } from "../app/flows/release-approval/flow";
import { buildApp } from "./config";

// Produce evals/happy-path.json — a golden fixture for `loom eval`. The event log
// IS the fixture: we run the flow to completion once, capture its log, and pair it
// with expectations. Re-run with `pnpm record:golden` whenever the flow changes.
async function main(): Promise<void> {
  const app = buildApp({ storage: { kind: "memory" } });

  const handle = await app.runtime.start(releaseApprovalFlow, {
    service: "checkout-api",
    changeType: "hotfix",
  });
  await handle.waitForSuspend();
  const resumed = await app.runtime.resume(handle.executionId, {
    eventType: "ApprovalGranted",
    payload: { approved: true, approvedBy: "ada@example.com" },
  });
  await resumed.waitForCompletion();

  const log = await captureGolden(app.stores.eventStore, handle.executionId);
  const golden = {
    name: "happy path — hotfix approved",
    log,
    expect: { status: "completed", stepsCompleted: ["assess", "notify", "apply"] },
  };

  mkdirSync("evals", { recursive: true });
  writeFileSync("evals/happy-path.json", `${JSON.stringify(golden, null, 2)}\n`);
  console.log(`wrote evals/happy-path.json (${log.length} events)`);
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
