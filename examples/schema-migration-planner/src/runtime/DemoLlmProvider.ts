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
// is a one-line swap in runtime/services.ts:
//
//   import { AnthropicProvider } from "@loom/llm";
//   export const llm = new AnthropicProvider({ model: "claude-opus-4-8" });
//
// Nothing downstream (Planner/Intent/Agent/streaming widgets) changes.

// Keep in sync with the capability ids registered in the catalog. A *simple*
// migration (a nullable, metadata-only column) auto-applies; a *complex* one
// (backfilling a NOT NULL column on a huge table) routes to `plan-migration`,
// which the Orchestrator intercepts for branch exploration.
const SIMPLE_PLAN = ["diagnose-schema", "assess-migration", "apply-migration"];
const COMPLEX_PLAN = ["diagnose-schema", "assess-migration", "plan-migration"];

function goalOf(request: LlmRequest): string {
  const raw = request.messages.map((m) => m.content).join("\n");
  // The planner/intent prompts embed a capability menu. Classify off the actual
  // goal line only — "Goal: …" or "Request: …" — falling back to the whole prompt
  // for the narrator role.
  const match = /(?:goal|request):\s*([^\n]*)/i.exec(raw);
  return (match?.[1] ?? raw).toLowerCase();
}

// A migration is "complex" (needs a table rewrite / backfill → branch) unless it's
// an explicitly metadata-only change (a nullable column, no backfill).
function isComplexGoal(goal: string): boolean {
  if (/nullable|metadata|notes\b/.test(goal)) return false;
  return /not.?null|backfill|region|large|rewrite|40m|million/.test(goal) || true;
}

function planFor(goal: string): string {
  const complex = isComplexGoal(goal);
  const ids = complex ? COMPLEX_PLAN : SIMPLE_PLAN;
  const rationale = complex
    ? [
        "Inspect the target table's size, indexes and write load",
        "Weigh the risk of the schema change",
        "Plan the migration — multiple viable strategies to compare",
      ]
    : [
        "Inspect the target table",
        "Weigh the risk of the schema change",
        "Apply the metadata-only change once risk is understood",
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

    // Intent routing: reply with exactly one capability id (always diagnose first).
    if (system.includes("route")) {
      return { content: "diagnose-schema", stopReason: "end_turn" };
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
    if (isComplexGoal(goal)) {
      return (
        "Backfilling a NOT NULL column onto a 40M-row table under active writes has no single " +
        "right answer: an online chunked copy trades a longer runtime for a tiny cutover lock, a " +
        "shadow-copy-and-swap is fastest but drops the original (no rollback), and a dual-write " +
        "backfill takes zero lock but needs careful application coordination. These are mutually " +
        "exclusive — the right move is to simulate each and pick a winner, not to merge them."
      );
    }
    return (
      "Adding a nullable column is a metadata-only change: the table is not rewritten and no " +
      "backfill runs, so it completes in well under a second with no meaningful lock. It is safe " +
      "to auto-apply under policy."
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
