import type { LlmProvider, LlmRequest, LlmResponse, LlmStreamChunk } from "@loom/llm";

// ── DemoLlmProvider ───────────────────────────────────────────────────────────
//
// A single deterministic, offline LlmProvider that plays every model role in the
// app so the whole pipeline runs with no API key:
//
//   • Planner  — returns an ordered JSON plan (goal → capability pipeline)
//   • Intent   — routes a goal to one capability id
//   • Narrator — streams an agent's natural-language reasoning token by token
//
// Because the framework's LlmProvider contract is provider-agnostic, going live
// is a one-line swap in main.tsx:
//
//   import { AnthropicProvider } from "@loom/llm";
//   export const llm = new AnthropicProvider({ model: "claude-opus-4-8" });
//
// Nothing downstream (Planner/Intent/Agent/streaming widgets) changes.

// Keep in sync with the capability ids registered in the catalog.
const CPU_PLAN = ["diagnose-cpu", "assess-remediation", "apply-remediation"];
const REPLICA_PLAN = ["diagnose-replica-lag", "assess-remediation", "scale-read-replicas"];

function goalOf(request: LlmRequest): string {
  const raw = request.messages.map((m) => m.content).join("\n");
  // The planner/intent prompts embed a capability menu (full of "replica"/"lag"
  // words). Classify off the actual goal line only — "Goal: …" or "Request: …" —
  // falling back to the whole prompt for the narrator role.
  const match = /(?:goal|request):\s*([^\n]*)/i.exec(raw);
  return (match?.[1] ?? raw).toLowerCase();
}

function isReplicaGoal(goal: string): boolean {
  return goal.includes("replica") || goal.includes("lag") || goal.includes("replication");
}

function planFor(goal: string): string {
  const ids = isReplicaGoal(goal) ? REPLICA_PLAN : CPU_PLAN;
  const rationale = isReplicaGoal(goal)
    ? [
        "Measure replica lag and locate the bottleneck",
        "Weigh the risk of the proposed remediation",
        "Add read-replica capacity to drain the backlog",
      ]
    : [
        "Find the source of the CPU saturation",
        "Weigh the risk of the proposed remediation",
        "Apply the fix once risk is understood",
      ];
  const steps = ids.map((capabilityId, i) => ({ capabilityId, rationale: rationale[i] }));
  return JSON.stringify(steps);
}

export class DemoLlmProvider implements LlmProvider {
  async complete(request: LlmRequest): Promise<LlmResponse> {
    const system = (request.system ?? "").toLowerCase();
    const goal = goalOf(request);

    // Planner: emit an ordered JSON plan the PlannerRuntime will parse.
    if (system.includes("planner")) {
      return { content: planFor(goal), stopReason: "end_turn" };
    }

    // Intent routing: reply with exactly one capability id.
    if (system.includes("route")) {
      const id = isReplicaGoal(goal) ? "diagnose-replica-lag" : "diagnose-cpu";
      return { content: id, stopReason: "end_turn" };
    }

    // Narrator fallback.
    return { content: this.narration(goal), stopReason: "end_turn" };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const text = this.narration(goalOf(request));
    for (const token of text.split(/(\s+)/)) {
      await delay(18);
      yield { delta: token, done: false };
    }
    yield { delta: "", done: true };
  }

  private narration(goal: string): string {
    if (isReplicaGoal(goal)) {
      return (
        "Read-replica lag is climbing because the primary's write throughput is " +
        "outpacing what two replicas can apply — the WAL apply queue is backing up. " +
        "Adding replica capacity spreads the apply load and drains the backlog. " +
        "This is horizontally scalable and reversible, so the remediation is low risk."
      );
    }
    return (
      "CPU is saturated because the connection pool is exhausted: queued queries are " +
      "spinning on lock acquisition, which pins the scheduler at ~90%. Recycling the " +
      "pool and raising its ceiling clears the queue. The pool restart is graceful and " +
      "reversible, so the remediation is low risk."
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
