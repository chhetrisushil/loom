import type { LlmResponse } from "@loom/llm";
import type { Script } from "../cassetteFiles";

// ── The planner intents ───────────────────────────────────────────────────────
//
// Twelve operator intents → the agent graph a correct planner produces, through BOTH runtimes a command centre uses:
// `IntentRuntime.route` picks the capability that handles the intent, `PlannerRuntime.planGraph` composes the DAG of
// capability calls (with `$from` bindings and `dependsOn` edges). `expected` is written from the intent BEFORE any
// runtime ran over it. The scripts are what a sensible model would answer; no model produced any of it (PROVENANCE.md).

/** A plan node in canonical form: the free-text `rationale` is not part of the graph and is dropped. */
export interface GraphNode {
  readonly id: string;
  readonly capabilityId: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly dependsOn: readonly string[];
}

/** A graph, or the typed reason planning gave up (`refused:empty`, `refused:invalid`, `refused:unparseable`). */
export type ExpectedGraph = readonly GraphNode[] | `refused:${string}`;

export interface PlannerCase {
  readonly id: string;
  readonly tags: readonly string[];
  readonly intent: string;
  /** The capability `IntentRuntime` must route to, or `null` (nothing fits). */
  readonly route: string | null;
  readonly graph: ExpectedGraph;
  readonly script: Script;
}

const say = (content: string): LlmResponse => ({ content, stopReason: "end_turn" });
const ROUTER_SYSTEM = "You route a user's request";
const isRouting = (system: string | undefined): boolean =>
  system?.startsWith(ROUTER_SYSTEM) === true;

/** The model: routing answers with the id (or NONE); planning answers with one JSON plan per attempt. */
const model =
  (route: string | null, ...plans: string[]): Script =>
  (turn, req) =>
    isRouting(req.system)
      ? say(route ?? "NONE")
      : say(plans[Math.min(turn, plans.length - 1)] as string);

interface N {
  id: string;
  capabilityId: string;
  args?: Record<string, unknown>;
  dependsOn?: string[];
}
const nodes = (...ns: N[]): GraphNode[] =>
  ns.map((n) => ({ args: {}, dependsOn: [], ...n }) as GraphNode);
const plan = (...ns: N[]): string =>
  JSON.stringify({
    nodes: ns.map((n) => ({ ...n, rationale: `step ${n.id}` })),
  });

const one = (id: string, capabilityId: string, args: Record<string, unknown>): N[] => [
  { id, capabilityId, args },
];

export const PLANNER_CASES: readonly PlannerCase[] = [
  {
    id: "cpu-single",
    tags: ["single", "diagnose"],
    intent: "Why is CPU so high on orders-db?",
    route: "diagnose-cpu",
    graph: nodes(...one("cpu", "diagnose-cpu", { target: "orders-db" })),
    script: model("diagnose-cpu", plan(...one("cpu", "diagnose-cpu", { target: "orders-db" }))),
  },
  {
    id: "lag-then-scale",
    tags: ["chain", "diagnose", "apply"],
    intent: "orders-replica-2 is falling behind the primary, sort it out",
    route: "diagnose-replica-lag",
    graph: nodes(
      { id: "diag", capabilityId: "diagnose-replica-lag", args: { target: "orders-replica-2" } },
      {
        id: "scale",
        capabilityId: "scale-read-replicas",
        args: { target: "orders-replica-2", addReplicas: 1 },
        dependsOn: ["diag"],
      }
    ),
    script: model(
      "diagnose-replica-lag",
      plan(
        { id: "diag", capabilityId: "diagnose-replica-lag", args: { target: "orders-replica-2" } },
        {
          id: "scale",
          capabilityId: "scale-read-replicas",
          args: { target: "orders-replica-2", addReplicas: 1 },
          dependsOn: ["diag"],
        }
      )
    ),
  },
  {
    id: "cpu-fix-chain-repair",
    tags: ["chain", "diagnose", "assess", "apply", "repair"],
    intent: "billing-db CPU is pinned. Find the cause, check the fix is safe, then apply it.",
    route: "diagnose-cpu",
    graph: nodes(
      { id: "diag", capabilityId: "diagnose-cpu", args: { target: "billing-db" } },
      {
        id: "assess",
        capabilityId: "assess-remediation",
        args: { target: "billing-db", domain: "cpu" },
        dependsOn: ["diag"],
      },
      {
        id: "fix",
        capabilityId: "apply-remediation",
        args: { target: "billing-db" },
        dependsOn: ["assess"],
      }
    ),
    // Turn 0 invents a capability that is not in the catalogue (the validator rejects it with
    // `unknown-capability` and feeds that back); turn 1 repairs it. The one case that exercises ask-validate-retry.
    script: model(
      "diagnose-cpu",
      plan(
        { id: "diag", capabilityId: "diagnose-cpu", args: { target: "billing-db" } },
        { id: "fix", capabilityId: "fix-cpu", args: { target: "billing-db" }, dependsOn: ["diag"] }
      ),
      plan(
        { id: "diag", capabilityId: "diagnose-cpu", args: { target: "billing-db" } },
        {
          id: "assess",
          capabilityId: "assess-remediation",
          args: { target: "billing-db", domain: "cpu" },
          dependsOn: ["diag"],
        },
        {
          id: "fix",
          capabilityId: "apply-remediation",
          args: { target: "billing-db" },
          dependsOn: ["assess"],
        }
      )
    ),
  },
  {
    id: "cpu-and-locks-parallel",
    tags: ["parallel", "diagnose"],
    intent: "Check CPU and lock contention on ledger-db at the same time.",
    route: "diagnose-cpu",
    graph: nodes(
      { id: "cpu", capabilityId: "diagnose-cpu", args: { target: "ledger-db" } },
      { id: "locks", capabilityId: "diagnose-locks", args: { target: "ledger-db" } }
    ),
    script: model(
      "diagnose-cpu",
      plan(
        { id: "cpu", capabilityId: "diagnose-cpu", args: { target: "ledger-db" } },
        { id: "locks", capabilityId: "diagnose-locks", args: { target: "ledger-db" } }
      )
    ),
  },
  {
    id: "lag-and-page",
    tags: ["binding", "diagnose", "notify"],
    intent: "Diagnose the lag on reports-replica and tell the on-call channel what you find.",
    route: "diagnose-replica-lag",
    graph: nodes(
      { id: "diag", capabilityId: "diagnose-replica-lag", args: { target: "reports-replica" } },
      {
        id: "tell",
        capabilityId: "notify-oncall",
        args: { channel: "db-oncall", message: { $from: "diag.summary" } },
        dependsOn: ["diag"],
      }
    ),
    script: model(
      "diagnose-replica-lag",
      plan(
        { id: "diag", capabilityId: "diagnose-replica-lag", args: { target: "reports-replica" } },
        {
          id: "tell",
          capabilityId: "notify-oncall",
          args: { channel: "db-oncall", message: { $from: "diag.summary" } },
          dependsOn: ["diag"],
        }
      )
    ),
  },
  {
    id: "vacuum-one-table",
    tags: ["single", "maintenance"],
    intent: "Vacuum the events table on analytics-db.",
    route: "vacuum-table",
    graph: nodes(...one("vac", "vacuum-table", { target: "analytics-db", table: "events" })),
    script: model(
      "vacuum-table",
      plan(...one("vac", "vacuum-table", { target: "analytics-db", table: "events" }))
    ),
  },
  {
    id: "locks-single",
    tags: ["single", "diagnose"],
    intent: "Something is blocking writes on payments-db, who holds the locks?",
    route: "diagnose-locks",
    graph: nodes(...one("locks", "diagnose-locks", { target: "payments-db" })),
    script: model(
      "diagnose-locks",
      plan(...one("locks", "diagnose-locks", { target: "payments-db" }))
    ),
  },
  {
    id: "assess-pool-restart",
    tags: ["single", "assess"],
    intent: "Is it safe to restart the connection pool on orders-db?",
    route: "assess-remediation",
    graph: nodes(...one("risk", "assess-remediation", { target: "orders-db", domain: "pool" })),
    script: model(
      "assess-remediation",
      plan(...one("risk", "assess-remediation", { target: "orders-db", domain: "pool" }))
    ),
  },
  {
    id: "add-replicas",
    tags: ["single", "apply"],
    intent: "Add 2 read replicas to reports-db.",
    route: "scale-read-replicas",
    graph: nodes(...one("scale", "scale-read-replicas", { target: "reports-db", addReplicas: 2 })),
    script: model(
      "scale-read-replicas",
      plan(...one("scale", "scale-read-replicas", { target: "reports-db", addReplicas: 2 }))
    ),
  },
  {
    id: "notify-only",
    tags: ["single", "notify"],
    intent: "Let the on-call channel know that the nightly vacuum finished.",
    route: "notify-oncall",
    graph: nodes(
      ...one("tell", "notify-oncall", {
        channel: "db-oncall",
        message: "The nightly vacuum finished.",
      })
    ),
    script: model(
      "notify-oncall",
      plan(
        ...one("tell", "notify-oncall", {
          channel: "db-oncall",
          message: "The nightly vacuum finished.",
        })
      )
    ),
  },
  {
    id: "diamond-assess",
    tags: ["parallel", "fan-in", "diagnose", "assess"],
    intent:
      "For inventory-db look at CPU and locks together, then assess whether a restart is safe given both.",
    route: "diagnose-cpu",
    graph: nodes(
      { id: "cpu", capabilityId: "diagnose-cpu", args: { target: "inventory-db" } },
      { id: "locks", capabilityId: "diagnose-locks", args: { target: "inventory-db" } },
      {
        id: "assess",
        capabilityId: "assess-remediation",
        args: { target: "inventory-db", domain: "restart" },
        dependsOn: ["cpu", "locks"],
      }
    ),
    script: model(
      "diagnose-cpu",
      plan(
        { id: "cpu", capabilityId: "diagnose-cpu", args: { target: "inventory-db" } },
        { id: "locks", capabilityId: "diagnose-locks", args: { target: "inventory-db" } },
        {
          id: "assess",
          capabilityId: "assess-remediation",
          args: { target: "inventory-db", domain: "restart" },
          dependsOn: ["cpu", "locks"],
        }
      )
    ),
  },
  {
    id: "no-capability",
    tags: ["refusal"],
    intent: "Find me a good Italian restaurant for dinner tonight.",
    route: null,
    // Nothing in the catalogue fits: the router answers NONE and the planner can only return an empty plan, which
    // it refuses (typed `empty` failure after its bounded attempts) instead of inventing a step.
    graph: "refused:empty",
    script: model(null, JSON.stringify({ nodes: [] })),
  },
];
