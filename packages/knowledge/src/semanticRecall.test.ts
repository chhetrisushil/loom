import { EmbeddingMemoryStore, HashingEmbeddingProvider, InMemoryMemoryStore } from "@loom/memory";
import { describe, expect, it } from "vitest";
import { openKnowledgeBase } from "./KnowledgeBase";
import type { DecideFn } from "./KnowledgeBase";

const decide: DecideFn = async (_key, compute) => compute();

// R18 (ADR 0124): a corpus over an EmbeddingMemoryStore ranks by embedding similarity with no
// change to KnowledgeBase - the seam is the MemoryStore it already takes.
describe("a knowledge base over an EmbeddingMemoryStore", () => {
  it("retrieves by embedding similarity and re-ingest still supersedes the old passages", async () => {
    const store = new EmbeddingMemoryStore({
      store: new InMemoryMemoryStore(),
      provider: new HashingEmbeddingProvider({ dimensions: 512 }),
      minScore: 0.2,
    });
    const kb = openKnowledgeBase(store, { scope: "runbooks" });
    await kb.putDoc({
      id: "RB-1",
      title: "Replica lag",
      text: "Cancel the blocking query on the primary.",
    });
    await kb.putDoc({ id: "RB-2", title: "Disk full", text: "Expand the volume and vacuum." });
    expect((await kb.retrieve("blocking query primary", { decide })).map((p) => p.docId)).toEqual([
      "RB-1",
    ]);
    await kb.putDoc({ id: "RB-1", title: "Replica lag", text: "Restart the standby and reseed." });
    const after = await kb.retrieve("blocking query primary", { decide });
    expect(after.map((p) => p.docId)).not.toContain("RB-1");
    expect((await kb.retrieve("restart standby reseed", { decide })).map((p) => p.docId)).toEqual([
      "RB-1",
    ]);
  });
});
