import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unwrapTainted } from "@loom/classify";
import { TieredMemory } from "@loom/memory";
import { SqliteMemoryStore } from "@loom/plugin-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "./KnowledgeBase";
import type { DecideFn } from "./KnowledgeBase";

const decide: DecideFn = async (_key, compute) => compute();

// The same corpus operations on a DURABLE backend with a real index and a real
// `remove`. The in-memory suite proves the logic; this proves the logic is not a
// property of the in-memory store — a revision that supersedes correctly in a Map
// and leaves the old passage in an FTS index would pass every test above.
describe("KnowledgeBase over SqliteMemoryStore", () => {
  let dir: string;
  let store: SqliteMemoryStore;
  let kb: KnowledgeBase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-knowledge-"));
    store = new SqliteMemoryStore(join(dir, "corpus.db"));
    kb = new KnowledgeBase({
      memory: new TieredMemory({ tiers: { semantic: {} }, store }),
      scope: "runbooks",
    });
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("retrieves an ingested document through the FTS index", async () => {
    await kb.putDoc({ id: "RB-101", title: "Replica lag", text: "Cancel the blocking query." });
    const hits = await kb.retrieve("blocking query", { decide });
    expect(hits.map((p) => unwrapTainted(p.text))).toEqual(["Cancel the blocking query."]);
  });

  it("supersedes a revision in the index, not just in the rows", async () => {
    await kb.putDoc({ id: "RB-317", text: "Raise the checkpoint completion target." });
    await kb.putDoc({ id: "RB-317", text: "Checkpoint tuning is now automatic." });
    expect(await kb.retrieve("completion target", { decide })).toEqual([]);
    expect((await kb.retrieve("automatic", { decide })).length).toBe(1);
  });

  it("survives a restart: a corpus written by one process is retrievable by the next", async () => {
    const path = join(dir, "restart.db");
    const first = new SqliteMemoryStore(path);
    const writer = new KnowledgeBase({
      memory: new TieredMemory({ tiers: { semantic: {} }, store: first }),
      scope: "runbooks",
    });
    await writer.sync([{ id: "RB-204", text: "Recycle the pool before raising the ceiling." }]);
    await first.close();

    const second = new SqliteMemoryStore(path);
    const reader = new KnowledgeBase({
      memory: new TieredMemory({ tiers: { semantic: {} }, store: second }),
      scope: "runbooks",
    });
    try {
      // Including the MANIFEST: a corpus whose passages persist but whose document
      // records do not is a corpus that can never be revised again.
      expect((await reader.listDocs()).map((d) => d.docId)).toEqual(["RB-204"]);
      expect(
        (
          await reader.sync([
            { id: "RB-204", text: "Recycle the pool before raising the ceiling." },
          ])
        ).unchanged
      ).toEqual(["RB-204"]);
      expect((await reader.retrieve("recycle pool", { decide })).length).toBe(1);
    } finally {
      await second.close();
    }
  });
});
