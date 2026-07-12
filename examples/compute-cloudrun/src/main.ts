import type { ExecutionDispatcher } from "@loom/dispatcher";
import { createWorkerServer } from "@loom/plugin-worker-server";
import type { ExecutionPackage } from "@loom/worker-runtime";
import { LocalWorkerRuntime } from "@loom/worker-runtime-local";
import {
  cloudRunDispatcher,
  inProcessDispatcher,
  newCloudRunSink,
  remoteDispatcher,
} from "./backends";
import type { RebuildOutput } from "./flow";
import { buildWorkerRuntime } from "./worker";

async function main(): Promise<void> {
  const runtime = buildWorkerRuntime();

  // Host the same runtime behind an HTTP worker server (as Cloud Run would).
  const server = createWorkerServer(new LocalWorkerRuntime(runtime), { port: 0 });
  await server.start();
  console.log(`worker server listening at ${server.url}\n`);

  const sink = newCloudRunSink();
  const backends: Array<[string, ExecutionDispatcher]> = [
    ["in-process", inProcessDispatcher(runtime)],
    ["remote-http", remoteDispatcher(server.url)],
    ["cloud-run", cloudRunDispatcher(server.url, sink)],
  ];

  // ── 1) The SAME flow on all three backends → equivalent results ─────────────
  console.log("▶ rebuild-index on every backend (same input: table=orders)");
  const outputs: RebuildOutput[] = [];
  for (const [name, dispatcher] of backends) {
    const pkg: ExecutionPackage = {
      executionId: `rebuild-${name}`,
      workflowId: "rebuild-index",
      flowId: "rebuild-index",
      input: { table: "orders" },
    };
    const result = await dispatcher.dispatch(pkg, { lane: "heavy", estimatedCpu: 4 });
    const out = result.output as RebuildOutput;
    outputs.push(out);
    console.log(
      `  ${name.padEnd(12)} → ${result.status}: reclaimed ${out.reclaimedMb}MB (bloat ${out.bloatPct}%)`
    );
  }
  const first = outputs[0];
  const same =
    first !== undefined &&
    outputs.every((o) => o.reclaimedMb === first.reclaimedMb && o.bloatPct === first.bloatPct);
  console.log(`  equivalent across backends: ${same}\n`);

  // ── 2) A suspended execution resumes on a DIFFERENT backend ─────────────────
  // Suspend via remote HTTP, resume via Cloud Run — the worker is stateless, so the
  // execution lives entirely in the shared log and any backend can pick it up.
  console.log("▶ rebuild-index-gated: suspend on remote-http, resume on cloud-run");
  const gatedId = "rebuild-gated-1";
  const remote = remoteDispatcher(server.url);
  const cloudRun = cloudRunDispatcher(server.url, sink);
  const suspended = await remote.dispatch({
    executionId: gatedId,
    workflowId: "rebuild-index-gated",
    flowId: "rebuild-index-gated",
    input: { table: "sessions" },
  });
  console.log(`  remote-http  → ${suspended.status} (awaiting approval)`);
  const resumed = await cloudRun.dispatch({
    executionId: gatedId,
    workflowId: "rebuild-index-gated",
    flowId: "rebuild-index-gated",
    resumeEvent: {
      eventType: "ApprovalGranted",
      payload: { approved: true, approvedBy: "ada@example.com" },
    },
  });
  const rout = resumed.output as RebuildOutput;
  console.log(
    `  cloud-run    → ${resumed.status}: approved by ${rout.approvedBy}, reclaimed ${rout.reclaimedMb}MB\n`
  );

  // ── 3) The Cloud Run platform observed the sizing + endpoint resolution ──────
  console.log(
    `Cloud Run platform saw ${sink.logs.length} allocate call(s); sizings: ${JSON.stringify(sink.sizings)}`
  );

  await server.stop();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
