import { createHash } from "node:crypto";
import type { ReasoningStore } from "@loom/llm";
import { describe, expect, it } from "vitest";
import { boot, lastUserText, messages } from "./__fixtures__/harness";

// ── ADR 0133 D5 — the conversation layer never carries reasoning across turns ───────────
//
// History is assembled from the carried window as plain text (user/assistant strings), and a
// rotation or the rolling summary only ever REMOVES from that window. So a reasoning part cannot
// survive an edit of the prefix here: the structural guarantee is that none crosses a turn at all.
// (Inside one turn, `agentLoop$` carries the blocks and drops them on its own compaction.)

function memStore(): ReasoningStore {
  const blobs = new Map<string, Uint8Array>();
  return {
    async put(bytes) {
      const address = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      blobs.set(address, bytes);
      return { __loomContent: address };
    },
    async get(ref) {
      return blobs.get(ref.__loomContent) ?? null;
    },
  };
}

describe("conversation history and reasoning", () => {
  it("no request after turn 1 carries a reasoning part, across rotation and the rolling summary", async () => {
    const b = boot({
      reasoning: { store: memStore() },
      config: {
        rotateEveryTurns: 2,
        budget: { contextWindow: 400, summarizerToolId: "summarize" },
      },
      reply: (req) => ({
        content: `re: ${lastUserText(req)}`,
        stopReason: "end_turn",
        reasoning: [{ kind: "summary", text: "THOUGHT", signature: "sig", provider: "anthropic" }],
      }),
    });
    const { conversationId: id } = await b.conv.start();
    for (let i = 1; i <= 6; i++) {
      await b.conv.sendTurn(id, `question number ${i} ${"padding ".repeat(12)}`);
      await messages(b, id, i * 2);
    }
    expect(b.requests).toHaveLength(6);
    for (const req of b.requests) {
      expect(JSON.stringify(req.messages)).not.toContain('"reasoning"');
      expect(JSON.stringify(req.messages)).not.toContain("THOUGHT");
    }
    // The reasoning WAS captured (the negative above is not vacuous).
    const logs = await Promise.all([
      b.eventStore.read(id),
      ...[1, 2].map((g) => b.eventStore.read(`${id}~${g}`)),
    ]);
    expect(JSON.stringify(logs)).toContain("LLM_REASONING_CAPTURED");
  });
});
