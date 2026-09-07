import { InMemoryMemoryStore } from "@loom/memory";
import { describe, expect, it } from "vitest";
import { openKnowledgeBase } from "./KnowledgeBase";
import type { DecideFn, KnowledgeBase } from "./KnowledgeBase";

const decide: DecideFn = async (_key, compute) => compute();
const corpus = (): KnowledgeBase =>
  openKnowledgeBase(new InMemoryMemoryStore(), { scope: "runbooks" });

/** The authored half: a wiki export, reconciled on a schedule. */
const WIKI = [
  { id: "RB-101", title: "Replica lag", text: "Cancel the blocking query." },
  { id: "RB-204", title: "Pool", text: "Recycle the pool first." },
];

/** The learned half: what an agent worked out from feedback, written one at a time. */
const LEARNED = {
  id: "learned:pool-saturation",
  title: "Recycling cleared the queue (3 incidents)",
  text: "Every time the pool saturated, recycling cleared the queue within 40 seconds.",
};

describe("two writers, one corpus", () => {
  it("a wiki sync does not delete what the agent learned", async () => {
    // The hazard this field exists for. `sync` is a destructive reconcile over everything
    // the manifest holds, so before ownership the nightly wiki job would delete every
    // learned document — they are not in the set the wiki produced, and never will be.
    const kb = corpus();
    await kb.sync(WIKI, { source: "wiki" });
    await kb.putDoc(LEARNED, { source: "agent" });

    const second = await kb.sync(WIKI, { source: "wiki" });
    expect(second.removed).toEqual([]);
    expect(second.retained).toEqual(["learned:pool-saturation"]);
    expect((await kb.listDocs()).map((d) => d.docId)).toContain("learned:pool-saturation");
  });

  it("and the learned half is still retrievable beside the authored half", async () => {
    const kb = corpus();
    await kb.sync(WIKI, { source: "wiki" });
    await kb.putDoc(LEARNED, { source: "agent" });
    await kb.sync(WIKI, { source: "wiki" });

    const hits = await kb.retrieve("pool saturated recycling", { decide });
    expect(hits.map((p) => p.docId)).toContain("learned:pool-saturation");
    expect(hits.map((p) => p.docId)).toContain("RB-204");
  });

  it("each writer still reconciles its OWN documents fully", async () => {
    // Ownership must not turn `sync` into an append-only operation for its own set —
    // a wiki page deleted upstream must still stop answering.
    const kb = corpus();
    await kb.sync(WIKI, { source: "wiki" });
    await kb.putDoc(LEARNED, { source: "agent" });

    const pruned = await kb.sync([WIKI[0] as (typeof WIKI)[number]], { source: "wiki" });
    expect(pruned.removed).toEqual(["RB-204"]);
    expect(pruned.retained).toEqual(["learned:pool-saturation"]);
  });

  it("an agent's own reconcile can retire its own learnings without touching the wiki", async () => {
    const kb = corpus();
    await kb.sync(WIKI, { source: "wiki" });
    await kb.putDoc(LEARNED, { source: "agent" });

    const forgotten = await kb.sync([], { source: "agent" });
    expect(forgotten.removed).toEqual(["learned:pool-saturation"]);
    expect(forgotten.retained.sort()).toEqual(["RB-101", "RB-204"]);
    expect((await kb.listDocs()).map((d) => d.docId).sort()).toEqual(["RB-101", "RB-204"]);
  });

  it("refuses a write to a document another writer owns", async () => {
    // Loud rather than silently re-stamping: two writers claiming one document would each
    // delete the other's revision on alternate syncs, and every individual run would look
    // correct while the corpus flapped forever.
    const kb = corpus();
    await kb.sync(WIKI, { source: "wiki" });
    await expect(kb.putDoc(WIKI[0] as (typeof WIKI)[number], { source: "agent" })).rejects.toThrow(
      /managed by source "wiki"/
    );
    await expect(kb.sync(WIKI, { source: "agent" })).rejects.toThrow(/one writer/);
  });

  it("treats the default writer as a source of its own, not as a wildcard", async () => {
    // An unstamped corpus keeps working exactly as before — and a named source cannot
    // quietly adopt its documents, which is what a wildcard would allow.
    const kb = corpus();
    await kb.sync(WIKI);
    expect((await kb.sync([], { source: "wiki" })).retained.sort()).toEqual(["RB-101", "RB-204"]);
    expect((await kb.sync([])).removed.sort()).toEqual(["RB-101", "RB-204"]);
  });

  it("planSync previews ownership too, so a dry run never under-reports what it protects", async () => {
    const kb = corpus();
    await kb.sync(WIKI, { source: "wiki" });
    await kb.putDoc(LEARNED, { source: "agent" });
    const plan = await kb.planSync([], { source: "wiki" });
    expect(plan.removed.sort()).toEqual(["RB-101", "RB-204"]);
    expect(plan.retained).toEqual(["learned:pool-saturation"]);
    // …and it wrote nothing.
    expect((await kb.listDocs()).length).toBe(3);
  });
});
