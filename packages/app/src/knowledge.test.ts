import { memory$ } from "@loom/core";
import { InMemoryMemoryStore } from "@loom/memory";
import { describe, expect, it } from "vitest";
import { defineConfig } from "./defineConfig";

const decide = async <T>(_key: string, compute: () => Promise<T> | T): Promise<T> => compute();

const DOC = { id: "RB-101", title: "Replica lag", text: "Cancel the blocking query." };

describe("app.knowledge", () => {
  it("opens a corpus over the configured memoryStore, with no tier wiring", async () => {
    const store = new InMemoryMemoryStore();
    const app = defineConfig({ storage: { kind: "memory" }, memoryStore: store });
    const kb = app.knowledge("runbooks");
    await kb.putDoc(DOC);

    expect((await kb.retrieve("blocking query", { decide })).map((p) => p.docId)).toEqual([
      "RB-101",
    ]);
    // The SAME store as app.memory — two stores would be two corpora that look like one.
    expect((await store.read("semantic::runbooks")).length).toBeGreaterThan(0);
    await app.close();
  });

  it("returns the same corpus for the same scope, and different ones for different scopes", async () => {
    const app = defineConfig({
      storage: { kind: "memory" },
      memoryStore: new InMemoryMemoryStore(),
    });
    expect(app.knowledge("a")).toBe(app.knowledge("a"));
    expect(app.knowledge("a")).not.toBe(app.knowledge("b"));
    await app.close();
  });

  it("refuses options on an already-open corpus rather than ignoring them", async () => {
    // Silently ignoring them is the bad outcome: two parts of an app configuring one
    // corpus with different chunkers would chunk it differently on alternate ingests,
    // and the only symptom is retrieval quality.
    const app = defineConfig({
      storage: { kind: "memory" },
      memoryStore: new InMemoryMemoryStore(),
    });
    app.knowledge("runbooks", { chunker: (d) => [d.text] });
    expect(() => app.knowledge("runbooks", { chunker: (d) => d.text.split("|") })).toThrow(
      /already open/
    );
    expect(() => app.knowledge("runbooks")).not.toThrow();
    await app.close();
  });

  it("refuses a corpus tier that a registered memory$ would evict", async () => {
    // Both run over one store, and only the runtime that READS applies its own policy —
    // so a `memory$({ id: "semantic", maxEntries })` read through app.memory would evict
    // passages the corpus manifest still counts, leaving documents as fragments.
    const app = defineConfig({
      storage: { kind: "memory" },
      memoryStore: new InMemoryMemoryStore(),
      memories: [memory$({ id: "semantic", name: "Semantic", maxEntries: 20 })],
    });
    expect(() => app.knowledge("runbooks")).toThrow(/would evict/);
    // …and the escape it names actually works.
    expect(() => app.knowledge("runbooks", { tier: "knowledge" })).not.toThrow();
    await app.close();
  });

  it("allows a memory$ of the same name that does NOT evict", async () => {
    const app = defineConfig({
      storage: { kind: "memory" },
      memoryStore: new InMemoryMemoryStore(),
      memories: [memory$({ id: "semantic", name: "Semantic" })],
    });
    expect(() => app.knowledge("runbooks")).not.toThrow();
    await app.close();
  });

  it("exposes the memoryStore only when one was configured", async () => {
    const configured = defineConfig({
      storage: { kind: "memory" },
      memoryStore: new InMemoryMemoryStore(),
    });
    const defaulted = defineConfig({ storage: { kind: "memory" } });
    expect(configured.stores.memoryStore).toBeDefined();
    // Absent is the state worth detecting: memory and any corpus are lost on restart,
    // and an operator command writing into one would be writing into a throwaway.
    expect(defaulted.stores.memoryStore).toBeUndefined();
    // It still works — it just does not survive the process.
    await defaulted.knowledge("scratch").putDoc(DOC);
    expect(await defaulted.knowledge("scratch").listDocs()).toHaveLength(1);
    await configured.close();
    await defaulted.close();
  });
});
