import { memoryWriteBackEffect } from "@loomwork/agent";
import { isTainted } from "@loomwork/classify";
import { agent$ } from "@loomwork/core";
import { ToolEffect } from "@loomwork/effect-runtime";
import { InMemoryMemoryStore, TieredMemory } from "@loomwork/memory";
import { describe, expect, it } from "vitest";
import { boot, messages, until } from "./__fixtures__/harness";

// ADR 0149 D7: `agent.writeBack.distill` passes through the conversation layer unchanged, so each
// turn distills into the conversation's memory scope.
describe("conversation: per-turn distilled write-back (ADR 0149 D7)", () => {
  it("each turn distills facts into the conversation's scope; the end user's words make them tainted", async () => {
    const mem = new TieredMemory({
      store: new InMemoryMemoryStore(),
      tiers: { working: { maxEntries: 100 } },
    });
    const seen: { existing: unknown[] }[] = [];
    const b = boot({
      config: {
        agent: {
          definition: agent$({ id: "chat", name: "Chat", tools: [] }),
          modelToolId: "model",
          memory: mem,
          memoryScope: "conv-scope",
          writeBack: { toolId: "memwrite", distill: { toolId: "distill" } },
        } as never,
      },
      extraEffects: (e) => {
        e.register("memwrite", memoryWriteBackEffect(mem));
        e.register(
          "distill",
          new ToolEffect(async (input: unknown) => {
            const i = input as { prompt: unknown; existing: { id: string }[] };
            seen.push(i);
            return {
              add: [`turn ${seen.length}: user said something`],
              supersede: i.existing.map((x) => x.id),
            };
          })
        );
      },
    });
    const { conversationId: id } = await b.conv.start();
    await b.conv.sendTurn(id, "hello");
    await messages(b, id, 2);
    await until(
      async () => (await mem.recall("working", "conv-scope")).length === 1,
      "turn 1 facts"
    );
    await b.conv.sendTurn(id, "again");
    await messages(b, id, 4);
    await until(
      async () =>
        (await mem.recall("working", "conv-scope")).some((e) =>
          String(JSON.stringify(e.content)).includes("turn 2")
        ),
      "turn 2 facts"
    );
    const facts = await mem.recall("working", "conv-scope");
    // turn 2 superseded turn 1's fact: one fact, no raw user / assistant entries
    expect(facts.map((e) => e.role)).toEqual(["fact"]);
    expect(isTainted(facts[0]?.content)).toBe(true);
    expect(seen[1]?.existing).toHaveLength(1);
  });
});
