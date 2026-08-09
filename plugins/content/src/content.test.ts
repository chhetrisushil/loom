import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { foldEvents } from "@loom/replay-vm";
import { describe, expect, it } from "vitest";
import { ContentResolvingEventStore } from "./ContentResolvingEventStore";
import { InMemoryContentStore } from "./ContentStore";
import { isContentRef } from "./content";
import { ContentMissingError } from "./errors";

const EXTERNALIZE = { STEP_COMPLETED: ["output.doc"] };

function ev(
  executionId: string,
  sequence: number,
  eventType: string,
  payload: unknown
): EventEnvelope {
  return {
    id: `${executionId}-${sequence}`,
    workflowId: "wf",
    executionId,
    eventType,
    sequence,
    timestamp: 1000 + sequence,
    payload,
  };
}

function setup() {
  const inner = new InMemoryAsyncEventStore();
  const content = new InMemoryContentStore();
  const store = new ContentResolvingEventStore(inner, content, { externalize: EXTERNALIZE });
  return { inner, content, store };
}

describe("externalization across arrays (#260)", () => {
  it("externalizes every element behind a `[]` path and resolves them all back", async () => {
    const inner = new InMemoryAsyncEventStore();
    const content = new InMemoryContentStore();
    const store = new ContentResolvingEventStore(inner, content, {
      externalize: { STEP_COMPLETED: ["output.docs[].body"] },
    });
    const payload = {
      output: {
        docs: [
          { body: "…long text A…", id: "a" },
          { body: "…long text B…", id: "b" },
        ],
      },
    };
    await store.append(ev("e1", 0, "STEP_COMPLETED", payload));

    // The log holds refs, not bodies — one blob per distinct element.
    const [stored] = await inner.read("e1");
    const logged = stored?.payload as { output: { docs: { body: unknown; id: string }[] } };
    expect(Array.isArray(logged.output.docs)).toBe(true);
    expect(logged.output.docs.map((d) => isContentRef(d.body))).toEqual([true, true]);
    expect(logged.output.docs.map((d) => d.id)).toEqual(["a", "b"]); // siblings untouched
    expect(content.size).toBe(2);

    // Reading resolves them, so the fold is identical to the un-externalized payload (G1).
    const [resolved] = await store.read("e1");
    expect(resolved?.payload).toEqual(payload);
  });

  it("dedups identical elements to one blob, as content addressing implies", async () => {
    const inner = new InMemoryAsyncEventStore();
    const content = new InMemoryContentStore();
    const store = new ContentResolvingEventStore(inner, content, {
      externalize: { STEP_COMPLETED: ["output.docs[].body"] },
    });
    await store.append(
      ev("e1", 0, "STEP_COMPLETED", { output: { docs: [{ body: "same" }, { body: "same" }] } })
    );
    expect(content.size).toBe(1);
    const [resolved] = await store.read("e1");
    expect(resolved?.payload).toEqual({ output: { docs: [{ body: "same" }, { body: "same" }] } });
  });

  it("is inert when the `[]` path does not resolve", async () => {
    const inner = new InMemoryAsyncEventStore();
    const content = new InMemoryContentStore();
    const store = new ContentResolvingEventStore(inner, content, {
      externalize: { STEP_COMPLETED: ["output.docs[].body"] },
    });
    const payload = { output: { other: 1 } };
    await store.append(ev("e1", 0, "STEP_COMPLETED", payload));
    expect(content.size).toBe(0);
    expect((await store.read("e1"))[0]?.payload).toEqual(payload);
  });
});

describe("ContentResolvingEventStore (ADR 0046)", () => {
  it("externalizes marked fields to the content store; the log holds only a ref", async () => {
    const { inner, content, store } = setup();
    const doc = { title: "Contract", body: "…long PII-bearing text…" };
    await store.append(ev("e1", 0, "EXECUTION_STARTED", { input: {} }));
    await store.append(ev("e1", 1, "STEP_COMPLETED", { stepId: "s", output: { doc, ok: true } }));

    // On disk (inner store): the marked field is a content ref, not the value.
    const raw = await inner.read("e1");
    const rawOutput = (raw[1]?.payload as { output: { doc: unknown; ok: unknown } }).output;
    expect(isContentRef(rawOutput.doc)).toBe(true);
    expect(JSON.stringify(raw)).not.toContain("PII-bearing");
    expect(rawOutput.ok).toBe(true); // unmarked sibling stays inline (G2)
    expect(content.size).toBe(1); // exactly one blob stored

    // Through the wrapper: the value is resolved back, identical.
    const resolved = await store.read("e1");
    expect((resolved[1]?.payload as { output: { doc: unknown } }).output.doc).toEqual(doc);
  });

  it("preserves the fold — replay over resolved events equals replay over inline values (determinism)", async () => {
    const { store } = setup();
    await store.append(ev("e1", 0, "EXECUTION_STARTED", { input: { n: 1 } }));
    await store.append(
      ev("e1", 1, "STEP_COMPLETED", { stepId: "s", output: { doc: { a: 1 }, ok: true } })
    );
    await store.append(ev("e1", 2, "EXECUTION_COMPLETED", { output: { done: true } }));

    const externalizedFold = foldEvents(await store.read("e1"), { executionId: "e1" });
    // The same events with the value inline (no externalization) must fold identically.
    const plainFold = foldEvents(
      [
        ev("e1", 0, "EXECUTION_STARTED", { input: { n: 1 } }),
        ev("e1", 1, "STEP_COMPLETED", { stepId: "s", output: { doc: { a: 1 }, ok: true } }),
        ev("e1", 2, "EXECUTION_COMPLETED", { output: { done: true } }),
      ],
      { executionId: "e1" }
    );
    expect(externalizedFold).toEqual(plainFold);
  });

  it("is content-addressed: identical values across executions share ONE blob (dedup)", async () => {
    const { content, store } = setup();
    const doc = { shared: "same-bytes" };
    await store.append(ev("a", 0, "STEP_COMPLETED", { stepId: "s", output: { doc } }));
    await store.append(ev("b", 0, "STEP_COMPLETED", { stepId: "s", output: { doc } }));
    expect(content.size).toBe(1); // same content → same address → one blob
  });

  it("reads unmarked events verbatim (zero overhead, G2)", async () => {
    const { content, store } = setup();
    await store.append(ev("e1", 0, "EXECUTION_STARTED", { input: { name: "Ann" } }));
    expect(content.size).toBe(0); // nothing externalized
    const [e] = await store.read("e1");
    expect((e?.payload as { input: unknown }).input).toEqual({ name: "Ann" });
  });

  it("fails LOUDLY when externalized bytes are erased (ContentMissingError, G1)", async () => {
    const { content, store } = setup();
    await store.append(ev("e1", 0, "STEP_COMPLETED", { stepId: "s", output: { doc: { x: 1 } } }));
    expect(await store.read("e1")).toBeDefined(); // resolves fine while the blob lives

    // Physically erase the blob. Content-addressing means re-putting identical bytes returns
    // the SAME ref, so this deletes the very blob the log points at.
    const ref = await content.put(new TextEncoder().encode(JSON.stringify({ x: 1 })));
    await content.delete(ref);

    await expect(store.read("e1")).rejects.toBeInstanceOf(ContentMissingError);
  });

  it("copyPrefix shares blobs — a fork reads the parent's externalized content (no re-wrap)", async () => {
    const { content, store } = setup();
    await store.append(ev("p", 0, "EXECUTION_STARTED", { input: {} }));
    await store.append(ev("p", 1, "STEP_COMPLETED", { stepId: "s", output: { doc: { v: 42 } } }));

    await store.copyPrefix?.("p", "p@fork", 1, { forkedFrom: "p" });

    // The fork resolves the SAME blob (content-addressed refs copied verbatim) — one blob total.
    const forked = await store.read("p@fork");
    expect((forked[1]?.payload as { output: { doc: unknown } }).output.doc).toEqual({ v: 42 });
    expect(content.size).toBe(1);
  });
});
