import { buildApp } from "./app";
import { SCHEMA_REPAIRED, createHydrator } from "./hydration";
import { startTelemetryMcpServer } from "./mcpServer";
import { applyHydratedStates } from "./telemetry";

// Ask the observability assistant a few questions. Telemetry is HYDRATED by a
// durable Loom interpreter flow — fanout$ over mcpInvoke$ (schema-hash-pinned
// dynamic MCP dispatch) chained into sandboxEval$ (sandboxed, LLM-authored
// reshaping) — then each question is analysed by the agent, categorised, and
// answered with a DYNAMICALLY-generated dashboard (WHAT + WHY), rendered
// headlessly to the terminal. Offline, no API key: the MCP server runs
// in-process. Midway, a simulated backend deploy drifts one tool's schema —
// the pinned hash mismatches, the flow fails TYPED (schemaDrift) and repairs
// in-band; recorded siblings substitute from the log (ADR 0060/0061/0063/0064).

const QUESTIONS_BEFORE = [
  "Why is the CPU utilization high?",
  "What is the connection saturation level?",
];
const QUESTIONS_AFTER = [
  "Is replica lag a problem right now?",
  "Which slow queries are hurting us?",
];

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const note = (s: string): string => `\x1b[33m${s}\x1b[0m`;

async function main(): Promise<void> {
  const server = await startTelemetryMcpServer();
  try {
    const { composer, renderer, executionId, projectionRuntime } = buildApp();
    const hydrator = createHydrator(server.url);

    console.log(
      dim("\n── Hydrating telemetry: durable flow, fanout$ → mcpInvoke$ → sandboxEval$ ──")
    );
    const plan = await hydrator.buildPlan();
    console.log(
      dim(
        plan.nodes
          .map(
            (n) => `  ${n.projectionId} ← ${n.toolName} (pin ${n.expectedSchemaHash.slice(0, 18)}…)`
          )
          .join("\n")
      )
    );
    applyHydratedStates(projectionRuntime, executionId, await hydrator.hydrate("hydrate-1", plan));

    for (const question of QUESTIONS_BEFORE) {
      const result = await composer.answer(question);
      console.log(
        dim(
          `\n# "${question}" → topic=${result.classification.topic} kind=${result.classification.kind}`
        )
      );
      console.log(renderer.render(result.blueprint, executionId));
    }

    console.log(
      note("\n── Backend deploy: db.replication's input schema changes — the pin drifts ──")
    );
    server.upgradeReplicationTool();
    applyHydratedStates(projectionRuntime, executionId, await hydrator.hydrate("hydrate-2", plan));
    const repaired = (await hydrator.events("hydrate-2")).find(
      (e) => e.eventType === SCHEMA_REPAIRED
    );
    if (repaired) {
      const p = repaired.payload as {
        toolName: string;
        expectedSchemaHash: string;
        observedHash: string;
      };
      console.log(
        note(
          `⚠ schemaDrift on ${p.toolName}: pinned ${p.expectedSchemaHash.slice(0, 18)}… observed ${p.observedHash.slice(0, 18)}… — repaired in-band; recorded siblings substituted from the log`
        )
      );
    }

    for (const question of QUESTIONS_AFTER) {
      const result = await composer.answer(question);
      console.log(
        dim(
          `\n# "${question}" → topic=${result.classification.topic} kind=${result.classification.kind}`
        )
      );
      console.log(renderer.render(result.blueprint, executionId));
    }
  } finally {
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
