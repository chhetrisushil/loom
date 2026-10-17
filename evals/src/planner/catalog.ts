import { CapabilityCatalog, capability$ } from "@loom/capability";
import { flow$, handler$, step$ } from "@loom/core";
import type { ExecutionContext, FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";

// The capability catalogue the planner cases run against: a database-operations command centre, shaped like the
// sibling `loom-examples` `db-command-center` (diagnose, assess, apply, scale), with synthetic ids and text. The
// flows are no-ops: planning and routing never run them, they only need to exist for `capability$`.

const noop = step$({
  id: "noop",
  name: "Noop",
  inputSchema: z.any(),
  outputSchema: z.any(),
  handler: handler$(async () => ({})),
});

const flowFor = (id: string): RegisteredFlow<unknown, unknown> => ({
  definition: flow$({
    id,
    name: id,
    version: "1.0.0",
    inputSchema: z.any(),
    outputSchema: z.any(),
    steps: [noop],
  }),
  runner: ((ctx: ExecutionContext, i: unknown) => ctx.run(noop, i)) as FlowRunner<unknown, unknown>,
});

interface Def {
  id: string;
  intent: string;
  tags: string[];
  schema: z.ZodTypeAny;
}

const DEFS: readonly Def[] = [
  {
    id: "diagnose-cpu",
    intent: "Find why CPU utilization is high on a database and identify the root cause",
    tags: ["cpu", "utilization", "diagnose", "performance"],
    schema: z.object({ target: z.string() }),
  },
  {
    id: "diagnose-replica-lag",
    intent: "Investigate read-replica replication lag and locate the bottleneck",
    tags: ["replica", "replication", "lag", "diagnose"],
    schema: z.object({ target: z.string() }),
  },
  {
    id: "diagnose-locks",
    intent: "Find blocking sessions and lock contention on a database",
    tags: ["locks", "blocking", "contention", "diagnose"],
    schema: z.object({ target: z.string() }),
  },
  {
    id: "assess-remediation",
    intent: "Weigh the risk of a proposed remediation before it is applied",
    tags: ["remediation", "risk", "assess", "safety"],
    schema: z.object({ target: z.string(), domain: z.string() }),
  },
  {
    id: "apply-remediation",
    intent:
      "Apply a low-risk remediation to fix a diagnosed problem, with human approval when required",
    tags: ["remediation", "fix", "apply", "restart"],
    schema: z.object({ target: z.string() }),
  },
  {
    id: "scale-read-replicas",
    intent:
      "Add read-replica capacity to reduce replication lag, with human approval when required",
    tags: ["scale", "replica", "capacity", "apply"],
    schema: z.object({ target: z.string(), addReplicas: z.number() }),
  },
  {
    id: "vacuum-table",
    intent: "Vacuum and analyze one table to reclaim space and refresh planner statistics",
    tags: ["vacuum", "bloat", "maintenance", "table"],
    schema: z.object({ target: z.string(), table: z.string() }),
  },
  {
    id: "notify-oncall",
    intent: "Post a message to the on-call channel",
    tags: ["notify", "page", "message", "oncall"],
    schema: z.object({ channel: z.string(), message: z.any() }),
  },
];

export const CAPABILITY_IDS: readonly string[] = DEFS.map((d) => d.id);

export function makeCatalog(): CapabilityCatalog {
  let c = new CapabilityCatalog();
  for (const d of DEFS) {
    c = c.register(
      capability$({
        id: d.id,
        intent: d.intent,
        tags: d.tags,
        inputSchema: d.schema,
        flow: flowFor(d.id),
      })
    );
  }
  return c;
}
