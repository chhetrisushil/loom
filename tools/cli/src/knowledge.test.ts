import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cmdKnowledgeList, cmdKnowledgeSearch, cmdKnowledgeSync, readCorpusDir } from "./knowledge";

let dir: string;

/**
 * A built config module, exactly what `--config` takes: CommonJS, default-exporting a
 * LoomApp. `durable` decides whether it configures a `memoryStore` — the distinction the
 * command refuses on.
 */
function configModule(durable: boolean): string {
  const path = join(dir, durable ? "config.js" : "config-volatile.js");
  writeFileSync(
    path,
    `const { defineConfig } = require(${JSON.stringify(require.resolve("@loom/app"))});
const { InMemoryMemoryStore } = require(${JSON.stringify(require.resolve("@loom/memory"))});
module.exports = defineConfig({
  storage: { kind: "memory" },
  ${durable ? "memoryStore: new InMemoryMemoryStore()," : ""}
});
`
  );
  return path;
}

function corpusDir(files: Record<string, string>): string {
  const root = join(dir, "docs");
  for (const [name, body] of Object.entries(files)) {
    const full = join(root, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loom-knowledge-cli-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readCorpusDir", () => {
  it("ids a document by its path relative to the directory, and titles it from its heading", () => {
    const root = corpusDir({
      "runbooks/replica-lag.md": "# Replica lag\n\nCancel the blocking query.",
      "notes/plain.txt": "no heading here",
    });
    const { docs } = readCorpusDir(root);
    // The id is the path: it is what makes a second sync recognise the same document.
    expect(docs.map((d) => d.id)).toEqual(["notes/plain.txt", "runbooks/replica-lag.md"]);
    expect(docs.map((d) => d.title)).toEqual(["plain", "Replica lag"]);
  });

  it("puts nothing in meta — a passage's meta is indexed, and the path is already the id", () => {
    const root = corpusDir({ "a/b/c.md": "# T\n\nbody" });
    const [doc] = readCorpusDir(root).docs;
    expect(doc?.id).toBe("a/b/c.md");
    expect(doc?.meta).toBeUndefined();
  });

  it("REPORTS what it skipped rather than quietly ingesting less than the directory holds", () => {
    const root = corpusDir({
      "keep.md": "# Keep\n\nbody",
      "huge.md": `# Huge\n\n${"x".repeat(2000)}`,
      "empty.md": "   \n\n  ",
      "ignored.pdf": "binary-ish",
    });
    const { docs, skipped } = readCorpusDir(root, { maxBytes: 500 });
    expect(docs.map((d) => d.id)).toEqual(["keep.md"]);
    // An extension nobody asked for is not a skip — it was never a candidate. A file that
    // WOULD have been ingested and was not is the one worth naming.
    expect(skipped.map((s) => s.file).sort()).toEqual(["empty.md", "huge.md"]);
    expect(skipped.find((s) => s.file === "huge.md")?.reason).toMatch(/exceeds/);
  });

  it("does not follow symlinks", () => {
    const root = corpusDir({ "real.md": "# Real\n\nbody" });
    const outside = join(dir, "outside.md");
    writeFileSync(outside, "# Outside\n\nsecret");
    symlinkSync(outside, join(root, "link.md"));
    const { docs, skipped } = readCorpusDir(root);
    // Out of the tree it would ingest a file the operator never pointed at; back into it,
    // the same file under two ids — which `sync` would treat as two documents forever.
    expect(docs.map((d) => d.id)).toEqual(["real.md"]);
    expect(skipped.map((s) => s.reason)).toEqual(["symlink (not followed)"]);
  });

  it("refuses a --dir that is not a directory", () => {
    expect(() => readCorpusDir(join(dir, "nope"))).toThrow(/not a directory/);
  });
});

describe("loom knowledge sync", () => {
  it("is a DRY RUN by default and writes nothing", async () => {
    const config = configModule(true);
    const root = corpusDir({ "a.md": "# A\n\nalpha" });
    const { text, result } = await cmdKnowledgeSync({ config, scope: "runbooks", dir: root });

    expect(result.written).toEqual(["a.md"]);
    expect(text).toContain("dry run — nothing written");
    // The corpus is untouched — the preview is a preview.
    const listed = await cmdKnowledgeList({ config, scope: "runbooks" });
    expect(listed.docs).toBe(0);
  });

  it("writes under --apply, and a second run writes nothing", async () => {
    const config = configModule(true);
    const root = corpusDir({ "a.md": "# A\n\nalpha", "b.md": "# B\n\nbravo" });
    const first = await cmdKnowledgeSync({ config, scope: "runbooks", dir: root, apply: true });
    expect(first.result.written).toEqual(["a.md", "b.md"]);

    const second = await cmdKnowledgeSync({ config, scope: "runbooks", dir: root, apply: true });
    expect(second.result).toEqual({
      written: [],
      unchanged: ["a.md", "b.md"],
      removed: [],
      retained: [],
    });
  });

  it("names the documents a run would REMOVE, because the reconcile is destructive", async () => {
    const config = configModule(true);
    const root = corpusDir({ "a.md": "# A\n\nalpha", "b.md": "# B\n\nbravo" });
    await cmdKnowledgeSync({ config, scope: "runbooks", dir: root, apply: true });

    rmSync(join(root, "b.md"));
    const { text, result } = await cmdKnowledgeSync({ config, scope: "runbooks", dir: root });
    expect(result.removed).toEqual(["b.md"]);
    expect(text).toContain("REMOVE (1): b.md");
    // Still a dry run: the document is only gone once --apply says so.
    expect((await cmdKnowledgeList({ config, scope: "runbooks" })).docs).toBe(2);
  });

  it("reconciles only what the named source owns", async () => {
    // The reason `--source` exists: a corpus written by more than one thing. This command
    // owns a directory; an agent writing down what it learned owns its own documents, and a
    // nightly directory sync must not delete them.
    const config = configModule(true);
    const root = corpusDir({ "a.md": "# A\n\nalpha" });
    await cmdKnowledgeSync({ config, scope: "runbooks", dir: root, source: "docs", apply: true });

    const kb = require(config).knowledge("runbooks");
    await kb.putDoc({ id: "learned:1", text: "recycling cleared the queue" }, { source: "agent" });

    const { text, result } = await cmdKnowledgeSync({
      config,
      scope: "runbooks",
      dir: root,
      source: "docs",
      apply: true,
    });
    expect(result.removed).toEqual([]);
    expect(result.retained).toEqual(["learned:1"]);
    expect(text).toContain("kept (another writer's) (1): learned:1");
    expect((await cmdKnowledgeList({ config, scope: "runbooks" })).docs).toBe(2);
  });

  it("refuses an app whose memoryStore was never configured", async () => {
    // It would ingest into a store this process discards on exit, and print a summary
    // that looks like it worked.
    const config = configModule(false);
    const root = corpusDir({ "a.md": "# A\n\nalpha" });
    await expect(
      cmdKnowledgeSync({ config, scope: "runbooks", dir: root, apply: true })
    ).rejects.toThrow(/throws away on exit/);
  });
});

describe("loom knowledge search / list", () => {
  it("retrieves, and says the retrieval was not recorded", async () => {
    const config = configModule(true);
    const root = corpusDir({
      "lag.md": "# Replica lag\n\nCancel the blocking query before touching replication.",
      "pool.md": "# Pool\n\nRecycle the pool first.",
    });
    await cmdKnowledgeSync({ config, scope: "runbooks", dir: root, apply: true });

    const { text, hits } = await cmdKnowledgeSearch({
      config,
      scope: "runbooks",
      query: "blocking query",
    });
    expect(hits).toBeGreaterThan(0);
    expect(text).toContain("lag.md#0");
    // A transcript of this command must never be read as what an execution saw.
    expect(text).toContain("NOT a recorded retrieval");
  });

  it("lists documents with their passage counts", async () => {
    const config = configModule(true);
    const root = corpusDir({ "a.md": "# A\n\nalpha\n\nbravo" });
    await cmdKnowledgeSync({ config, scope: "runbooks", dir: root, apply: true });
    const { text, docs } = await cmdKnowledgeList({ config, scope: "runbooks" });
    expect(docs).toBe(1);
    expect(text).toContain("a.md");
    expect(text).toContain("passage(s)");
  });
});
