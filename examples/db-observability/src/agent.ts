import type { LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";
import type { Topic } from "./catalogue";
import { TOPIC_MODELS } from "./topics";

export type QuestionKind = "what" | "why";
export interface Classification {
  topic: Topic;
  kind: QuestionKind;
}

// A deterministic, offline LlmProvider that plays the "intent classifier" role: it
// categorises a question into a topic + kind and replies with JSON. Swap in
// `new AnthropicProvider({ model: "claude-opus-4-8" })` and the classifier is unchanged.
export class ObservabilityLlmProvider implements LlmProvider {
  async complete(request: LlmRequest): Promise<LlmResponse> {
    const q = request.messages
      .map((m) => m.content)
      .join("\n")
      .toLowerCase();
    const topic = classifyTopic(q);
    const kind: QuestionKind = /\bwhy\b|because|cause|reason|root/.test(q) ? "why" : "what";
    return { content: JSON.stringify({ topic, kind }), stopReason: "end_turn" };
  }
}

function classifyTopic(q: string): Topic {
  let best: Topic = "cpu";
  let bestScore = 0;
  for (const [topic, model] of Object.entries(TOPIC_MODELS)) {
    const score = model.keywords.reduce((n, k) => (q.includes(k) ? n + 1 : n), 0);
    if (score > bestScore) {
      bestScore = score;
      best = topic as Topic;
    }
  }
  return best;
}

// The "agent": ask the model to categorise the question, parse its structured reply.
export async function classifyIntent(
  provider: LlmProvider,
  question: string
): Promise<Classification> {
  const res = await provider.complete({
    system:
      "You are an intent classifier for a database observability assistant. Categorise the user's question into a topic (cpu, connections, replication, queries) and a kind (what | why). Reply with JSON { topic, kind }.",
    messages: [{ role: "user", content: `Question: ${question}` }],
  });
  try {
    const parsed = JSON.parse(res.content) as Classification;
    if (parsed.topic in TOPIC_MODELS && (parsed.kind === "what" || parsed.kind === "why")) {
      return parsed;
    }
  } catch {
    // fall through to a safe default
  }
  return { topic: "cpu", kind: "what" };
}
