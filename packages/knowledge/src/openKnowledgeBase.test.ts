import { InMemoryMemoryStore } from "@loom/memory";
import { describe, expect, it } from "vitest";
import { openKnowledgeBase } from "./KnowledgeBase";
import type { DecideFn } from "./KnowledgeBase";

const decide: DecideFn = async (_key, compute) => compute();

describe("openKnowledgeBase", () => {
  it("builds a corpus over a store with no tier wiring", async () => {
    const kb = openKnowledgeBase(new InMemoryMemoryStore(), { scope: "runbooks" });
    await kb.putDoc({ id: "RB-101", title: "Replica lag", text: "Cancel the blocking query." });
    expect((await kb.retrieve("blocking query", { decide })).map((p) => p.docId)).toEqual([
      "RB-101",
    ]);
  });

  it("creates the named tier, so a non-default tier is not an unknown-tier error", async () => {
    const kb = openKnowledgeBase(new InMemoryMemoryStore(), {
      scope: "procedures",
      tier: "procedural",
    });
    await kb.putDoc({ id: "P-1", text: "Drain the replica first." });
    expect(kb.tieredMemory.tierNames).toEqual(["procedural"]);
    expect(await kb.tieredMemory.recall("procedural", "procedures")).toHaveLength(1);
  });

  it("makes the corpus tier unbounded, whatever the caller passes elsewhere", () => {
    // The one invariant this helper exists to guarantee: a corpus tier that evicts drops
    // passages the manifest still counts, and the constructor's refusal is the last line
    // of defence — a helper that could produce a bounded tier would be a trap.
    const kb = openKnowledgeBase(new InMemoryMemoryStore(), { scope: "c" });
    expect(kb.tieredMemory.tierPolicy("semantic")).toEqual({});
  });
});
