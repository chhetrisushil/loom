import { isTainted, taintOf, unwrapTainted } from "@loom/classify";
import { InMemoryMemoryStore, TieredMemory, searchableText, tokenize } from "@loom/memory";
import type { MemoryEntry, MemoryStore } from "@loom/memory";
import { describe, expect, it } from "vitest";
import { KnowledgeBase } from "./KnowledgeBase";
import type { DecideFn } from "./KnowledgeBase";
import type { KnowledgeDoc } from "./types";

/** A pass-through `ctx.decide` — enough for everything that is not about the decision seam. */
const decide: DecideFn = async (_key, compute) => compute();

const RUNBOOK: KnowledgeDoc = {
  id: "RB-101",
  title: "Replica lag",
  text: `Replica lag is the delay between the primary WAL position and the replica replay position.

The usual cause is a long-running query on the replica holding back replay.`,
};

const POOL: KnowledgeDoc = {
  id: "RB-204",
  title: "Connection pool exhaustion",
  text: "The checkout API times out while the database is idle: the pool is saturated.",
};

function corpus(store: MemoryStore = new InMemoryMemoryStore()): {
  kb: KnowledgeBase;
  memory: TieredMemory;
} {
  const memory = new TieredMemory({ tiers: { semantic: {} }, store });
  return { kb: new KnowledgeBase({ memory, scope: "runbooks" }), memory };
}

describe("KnowledgeBase — the document ↔ passage mapping", () => {
  it("ingests a document as retrievable passages, tainted with their origin", async () => {
    const { kb } = corpus();
    const stored = await kb.putDoc(RUNBOOK);
    expect(stored.length).toBeGreaterThan(0);

    const hits = await kb.retrieve("replica replay delay", { decide });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.docId).toBe("RB-101");
    expect(hits[0]?.title).toBe("Replica lag");
    // Taint applied at INGEST survives the store round trip — the property the whole
    // prompt-safety argument rests on (ADR 0085).
    expect(isTainted(hits[0]?.text)).toBe(true);
    expect(taintOf(hits[0]?.text)?.origin).toBe("knowledge:runbooks:RB-101");
  });

  it("re-ingesting an unchanged document does not duplicate it", async () => {
    // The defect the whole class exists to prevent: `append` is a list, so a corpus
    // re-ingested nightly grows a copy of itself per night, and retrieval starts
    // returning the same passage several times over.
    const { kb, memory } = corpus();
    await kb.putDoc(RUNBOOK);
    const first = await memory.recall("semantic", "runbooks");
    await kb.putDoc(RUNBOOK);
    const second = await memory.recall("semantic", "runbooks");
    expect(second).toHaveLength(first.length);
  });

  it("a revised document supersedes its old passages — the stale text stops retrieving", async () => {
    const { kb } = corpus();
    await kb.putDoc({ id: "RB-317", text: "Spread the flush by raising the completion target." });
    await kb.putDoc({ id: "RB-317", text: "Checkpoint tuning was replaced by autotuning." });

    // Not merely "the new text is found first": the old text must be GONE. Ranked
    // alongside, a superseded instruction is worse than an absent one — the answer cites a
    // real document and quotes a procedure nobody follows any more.
    expect(await kb.retrieve("flush completion target", { decide })).toEqual([]);
    const current = await kb.retrieve("autotuning", { decide });
    expect(current.map((p) => unwrapTainted(p.text))).toEqual([
      "Checkpoint tuning was replaced by autotuning.",
    ]);
  });

  it("a shorter revision leaves no orphan passages behind", async () => {
    // Three passages down to one: the ids of the removed two are derived from the OLD
    // count, which is why the manifest stores the count rather than recomputing it.
    const memory = new TieredMemory({ tiers: { semantic: {} }, store: new InMemoryMemoryStore() });
    const kb = new KnowledgeBase({
      memory,
      scope: "runbooks",
      chunker: (doc: KnowledgeDoc) => doc.text.split("|"),
    });
    await kb.putDoc({ id: "D", text: "alpha|bravo|charlie" });
    await kb.putDoc({ id: "D", text: "delta" });
    expect(await memory.recall("semantic", "runbooks")).toHaveLength(1);
    expect(await kb.retrieve("bravo", { decide })).toEqual([]);
  });

  it("removeDoc removes one document and leaves the rest of the corpus", async () => {
    const { kb } = corpus();
    await kb.putDoc(RUNBOOK);
    await kb.putDoc(POOL);
    await kb.removeDoc("RB-101");

    expect(await kb.retrieve("replica replay", { decide })).toEqual([]);
    expect((await kb.retrieve("saturated pool", { decide })).map((p) => p.docId)).toEqual([
      "RB-204",
    ]);
    expect((await kb.listDocs()).map((d) => d.docId)).toEqual(["RB-204"]);
  });

  it("removeDoc is idempotent and ignores an unknown document", async () => {
    const { kb } = corpus();
    await kb.putDoc(RUNBOOK);
    await kb.removeDoc("RB-101");
    await kb.removeDoc("RB-101");
    await kb.removeDoc("never-existed");
    expect(await kb.listDocs()).toEqual([]);
  });

  it("keeps the manifest out of the searchable corpus", async () => {
    // A manifest row in the corpus scope would be an entry that matches queries about
    // document ids and answers nothing.
    const { kb, memory } = corpus();
    await kb.putDoc(RUNBOOK);
    const entries = await memory.recall("semantic", "runbooks");
    expect(entries.every((e) => e.id?.startsWith("RB-101#") === true)).toBe(true);
    expect(entries.some((e) => "chunkCount" in (e.content as object))).toBe(false);
  });

  it("keeps the document id and the chunk ordinal OUT of the searchable text", async () => {
    // A store indexes the string and number LEAVES of `content`. Storing `docId` there
    // would make a document's own id match all of its passages, and storing `index` would
    // make "0" match the first passage of every document in the corpus — the same widening
    // that made a tainted value's `origin` unindexable, and the rule the SPI states for
    // `MemoryEntry.id`. Both survive in the entry id, which is not indexed.
    const { kb, memory } = corpus();
    await kb.putDoc(RUNBOOK);
    const stored = (await memory.recall("semantic", "runbooks"))[0] as MemoryEntry;
    expect(searchableText(stored)).not.toContain("RB-101");
    expect(tokenize(searchableText(stored))).not.toContain("0");
    // …and the passage that comes back out still knows both.
    const [passage] = await kb.retrieve("replica replay", { decide });
    expect(passage?.docId).toBe("RB-101");
    expect(passage?.index).toBe(0);
  });

  it("DOES index the title and meta — high signal, and a footgun worth knowing", async () => {
    // Titles are what a question is often phrased in, so indexing them is deliberate.
    // `meta` is the caller's, and it is indexed by the same rule: a `{ team: "payments" }`
    // stamped on 300 documents makes "payments" match all 300. That is useful as a filter
    // and surprising as a relevance term, so it is pinned here rather than left to be found.
    const { kb } = corpus();
    await kb.putDoc({
      id: "D",
      title: "Vacuum tuning",
      text: "unrelated body",
      meta: { team: "payments" },
    });
    expect((await kb.retrieve("vacuum", { decide })).map((p) => p.docId)).toEqual(["D"]);
    expect((await kb.retrieve("payments", { decide })).map((p) => p.docId)).toEqual(["D"]);
  });

  it("refuses a corpus entry it did not write, rather than citing an unnamed document", async () => {
    // The corpus scope belongs to the KnowledgeBase. An entry appended by hand has no
    // passage id, so its document cannot be named — and a `docId: undefined` would flow
    // straight into a citation.
    const { kb, memory } = corpus();
    await kb.putDoc(RUNBOOK);
    await memory.remember("semantic", "runbooks", { content: { text: "smuggled replica note" } });
    await expect(kb.retrieve("replica", { decide })).rejects.toThrow(/has no id/);
  });

  it("refuses a tier that evicts", () => {
    const memory = new TieredMemory({
      tiers: { working: { maxEntries: 20 } },
      store: new InMemoryMemoryStore(),
    });
    // A bounded tier drops passages the manifest still counts, so a document retrieves as
    // a fragment of itself and nothing downstream can tell.
    expect(() => new KnowledgeBase({ memory, scope: "c", tier: "working" })).toThrow(/evicts/);
    expect(() => new KnowledgeBase({ memory, scope: "c", tier: "semantic" })).toThrow(
      /unknown memory tier/
    );
  });
});

describe("KnowledgeBase.sync — reconciling against a source", () => {
  it("writes new documents, leaves identical ones alone, removes dropped ones", async () => {
    const { kb } = corpus();
    const first = await kb.sync([RUNBOOK, POOL]);
    expect(first).toEqual({
      written: ["RB-101", "RB-204"],
      unchanged: [],
      removed: [],
      retained: [],
    });

    const second = await kb.sync([RUNBOOK, { ...POOL, text: "Recycle the pool first." }]);
    expect(second).toEqual({
      written: ["RB-204"],
      unchanged: ["RB-101"],
      removed: [],
      retained: [],
    });

    const third = await kb.sync([RUNBOOK]);
    expect(third).toEqual({
      written: [],
      unchanged: ["RB-101"],
      removed: ["RB-204"],
      retained: [],
    });
    expect(await kb.retrieve("recycle pool", { decide })).toEqual([]);
  });

  it("treats a changed title or meta as a revision, not as unchanged", async () => {
    // Both reach the prompt through every passage, so a fingerprint over `text` alone
    // would leave the corpus serving a title nobody can find in the source any more.
    const { kb } = corpus();
    await kb.sync([RUNBOOK]);
    expect((await kb.sync([{ ...RUNBOOK, title: "Replica lag (v2)" }])).written).toEqual([
      "RB-101",
    ]);
    expect(
      (await kb.sync([{ ...RUNBOOK, title: "Replica lag (v2)", meta: { owner: "db" } }])).written
    ).toEqual(["RB-101"]);
  });

  it("writes NOTHING when the source has not changed", async () => {
    const store = new RecordingStore();
    const memory = new TieredMemory({ tiers: { semantic: {} }, store });
    const kb = new KnowledgeBase({ memory, scope: "runbooks" });
    await kb.sync([RUNBOOK, POOL]);
    store.calls.length = 0;
    await kb.sync([RUNBOOK, POOL]);
    // The reason `sync` is usable on a schedule: an unchanged corpus costs one manifest
    // read, not a rewrite. A "no-op" that rewrites everything is how a nightly job
    // becomes the biggest writer in the system.
    expect(store.calls.filter((c) => c !== "read")).toEqual([]);
  });

  it("compacts superseded manifest rows instead of accumulating them", async () => {
    // Rows are appended rather than replaced (that is what makes the crash window safe),
    // so without pruning the manifest would grow by two rows per revision forever — and
    // the manifest read is on the hot path of every sync.
    const { kb, memory } = corpus();
    for (const text of ["one", "two", "three"]) await kb.putDoc({ id: "D", text });
    expect(await memory.recall("semantic", "runbooks::docs")).toHaveLength(1);
    expect((await kb.listDocs())[0]?.committed).toBe(true);
  });

  it("refuses duplicate ids in one sync", async () => {
    const { kb } = corpus();
    // Two documents sharing an id would each supersede the other, so the corpus would
    // alternate between them on every run and never converge.
    await expect(kb.sync([RUNBOOK, { ...RUNBOOK, text: "different" }])).rejects.toThrow(
      /duplicate document id/
    );
  });

  it("recovers a document whose passages never landed (crash between manifest and passages)", async () => {
    // The interleaving that a fingerprint alone cannot survive: the manifest claims the
    // new revision, the passages were never written, so a fingerprint comparison says
    // "unchanged" forever and the document is silently absent from a corpus that lists it.
    const store = new FailAfterAppends(2);
    const memory = new TieredMemory({ tiers: { semantic: {} }, store });
    const kb = new KnowledgeBase({ memory, scope: "runbooks" });

    await expect(kb.putDoc({ id: "RB-999", text: "one\n\ntwo\n\nthree" })).rejects.toThrow(/boom/);
    expect((await kb.listDocs())[0]?.committed).toBe(false);

    store.armed = false;
    const after = await kb.sync([{ id: "RB-999", text: "one\n\ntwo\n\nthree" }]);
    expect(after.written).toEqual(["RB-999"]);
    expect((await kb.listDocs())[0]?.committed).toBe(true);
    expect((await kb.retrieve("three", { decide })).length).toBeGreaterThan(0);
  });
});

describe("KnowledgeBase.retrieve — the recorded retrieval", () => {
  it("records the passage CONTENT, so a replay survives the corpus being deleted", async () => {
    const { kb } = corpus();
    await kb.putDoc(RUNBOOK);

    const log = new Map<string, unknown>();
    const recording: DecideFn = async (key, compute) => {
      const value = await compute();
      log.set(key, value);
      return value;
    };
    const live = await kb.retrieve("long-running query", { decide: recording, limit: 2 });
    expect(live.length).toBeGreaterThan(0);

    // Replay: the corpus is gone, and `decide` serves the recorded value.
    await kb.removeDoc("RB-101");
    const replaying: DecideFn = async (key, compute) =>
      log.has(key) ? (log.get(key) as never) : compute();
    const replayed = await kb.retrieve("long-running query", { decide: replaying, limit: 2 });

    expect(replayed.map((p) => unwrapTainted(p.text))).toEqual(
      live.map((p) => unwrapTainted(p.text))
    );
    // Ids would not have survived this: the passages they name no longer exist.
    expect(isTainted(replayed[0]?.text)).toBe(true);
  });

  it("fails loudly on a store that cannot search, rather than returning the newest entries", async () => {
    const { kb } = corpus(new NoSearchStore());
    await kb.putDoc(RUNBOOK);
    await expect(kb.retrieve("anything", { decide })).rejects.toThrow(/does not implement search/);
  });
});

/** Records which SPI verbs were called, to prove a no-op sync writes nothing. */
class RecordingStore extends InMemoryMemoryStore {
  readonly calls: string[] = [];
  override async append(key: string, entry: MemoryEntry): Promise<void> {
    this.calls.push("append");
    await super.append(key, entry);
  }
  override async read(key: string): Promise<MemoryEntry[]> {
    this.calls.push("read");
    return super.read(key);
  }
  override async clear(key: string): Promise<void> {
    this.calls.push("clear");
    await super.clear(key);
  }
  override async remove(key: string, ids: readonly string[]): Promise<void> {
    this.calls.push("remove");
    await super.remove(key, ids);
  }
}

/** Throws on the Nth append, standing in for a process that dies mid-ingest. */
class FailAfterAppends extends InMemoryMemoryStore {
  armed = true;
  private seen = 0;
  constructor(private readonly failAfter: number) {
    super();
  }
  override async append(key: string, entry: MemoryEntry): Promise<void> {
    if (this.armed && ++this.seen > this.failAfter) throw new Error("boom");
    await super.append(key, entry);
  }
}

/** A backend with no `search` — the one case that must not degrade into `read`. */
class NoSearchStore implements MemoryStore {
  private readonly inner = new InMemoryMemoryStore();
  append(key: string, entry: MemoryEntry): Promise<void> {
    return this.inner.append(key, entry);
  }
  read(key: string): Promise<MemoryEntry[]> {
    return this.inner.read(key);
  }
  clear(key: string): Promise<void> {
    return this.inner.clear(key);
  }
  remove(key: string, ids: readonly string[]): Promise<void> {
    return this.inner.remove(key, ids);
  }
}
