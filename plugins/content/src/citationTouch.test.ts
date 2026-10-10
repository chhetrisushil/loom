import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import {
  ContentResolvingEventStore,
  type ContentStore,
  InMemoryContentStore,
  encodeValue,
} from "./index";

// ADR 0055 D6 amendment 2 — a citation that enters a log WITHOUT a put touches the blob.

const OLD = 1_000;
const NOW = 9_000;

const evt = (executionId: string, sequence: number, payload: unknown): EventEnvelope => ({
  id: `${executionId}-${sequence}`,
  workflowId: "wf",
  executionId,
  eventType: sequence === 0 ? "EXECUTION_STARTED" : "STEP_COMPLETED",
  sequence,
  timestamp: OLD,
  payload,
});

function setup() {
  const clock = { now: OLD };
  const content = new InMemoryContentStore({ now: () => clock.now });
  const raw = new InMemoryAsyncEventStore();
  const resolving = new ContentResolvingEventStore(raw, content, { externalize: {} });
  return { clock, content, raw, resolving };
}

/** The touch time of one address, read through listPage. */
async function touchedAt(content: InMemoryContentStore, address: string): Promise<number> {
  const page = await content.listPage({});
  const hit = page.entries.find((e) => e.address === address);
  if (hit === undefined) throw new Error(`no ${address}`);
  return hit.touchedAt;
}

describe("InMemoryContentStore.touch", () => {
  it("bumps existing blobs to the store clock, never backwards", async () => {
    const { clock, content } = setup();
    const ref = await content.put(encodeValue("x"));
    clock.now = NOW;
    expect(await content.touch([ref.__loomContent, ref.__loomContent])).toEqual([]);
    expect(await touchedAt(content, ref.__loomContent)).toBe(NOW);
    clock.now = OLD; // the clock stepped back
    await content.touch([ref.__loomContent]);
    expect(await touchedAt(content, ref.__loomContent)).toBe(NOW);
  });

  it("is a no-op for an unknown address: nothing inserted, reported as missing; [] is legal", async () => {
    const { content } = setup();
    const ghost = `sha256:${"a".repeat(64)}`;
    expect(await content.touch([ghost])).toEqual([ghost]);
    expect(await content.touch([])).toEqual([]);
    expect(content.size).toBe(0);
  });
});

describe("ContentResolvingEventStore touches citations that arrive without a put", () => {
  it("append of a payload carrying an existing ref bumps its touch time", async () => {
    const { clock, content, resolving } = setup();
    const ref = await content.put(encodeValue("recalled"));
    clock.now = NOW;
    await resolving.append(evt("e", 0, { input: {} }));
    expect(await touchedAt(content, ref.__loomContent)).toBe(OLD); // a ref-free append touches nothing
    await resolving.append(evt("e", 1, { output: { nested: [ref] } }));
    expect(await touchedAt(content, ref.__loomContent)).toBe(NOW);
  });

  it("appendBatch and appendIfUnchanged touch too, in one batched call per write", async () => {
    const { clock, content, raw, resolving } = setup();
    const a = await content.put(encodeValue("a"));
    const b = await content.put(encodeValue("b"));
    const calls: string[][] = [];
    const real = content.touch.bind(content);
    content.touch = async (addresses) => {
      calls.push([...addresses]);
      return real(addresses);
    };
    clock.now = NOW;
    await resolving.appendBatch!([evt("e", 0, { input: {} }), evt("e", 1, { output: a })]);
    expect(await touchedAt(content, a.__loomContent)).toBe(NOW);
    expect(calls[0]).toEqual([a.__loomContent]); // before the write; one call, not one per ref
    clock.now = NOW + 5;
    const tip = await raw.appendIfUnchanged!("e", null);
    if (tip.appended) throw new Error("an observation does not append");
    const r = await resolving.appendIfUnchanged!("e", evt("e", 2, { output: [b, b] }), {
      head: tip.head,
      fence: tip.fence,
      anchor: tip.anchor,
    });
    expect(r.appended).toBe(true);
    expect(await touchedAt(content, b.__loomContent)).toBe(NOW + 5);
    expect(calls.at(-1)).toEqual([b.__loomContent]); // deduped
  });

  it("copyPrefix touches every ref in the copied range and ONLY that range", async () => {
    const { clock, content, raw, resolving } = setup();
    const inRange = await content.put(encodeValue("in"));
    const beyond = await content.put(encodeValue("beyond"));
    await raw.append(evt("p", 0, { input: {} }));
    await raw.append(evt("p", 1, { output: inRange }));
    await raw.append(evt("p", 2, { output: beyond }));
    clock.now = NOW;
    await resolving.copyPrefix!("p", "f", 1, {});
    expect(await touchedAt(content, inRange.__loomContent)).toBe(NOW);
    expect(await touchedAt(content, beyond.__loomContent)).toBe(OLD);
    expect((await raw.read("f")).length).toBe(2);
  });

  it("a touch failure BEFORE the write aborts it (nothing landed); one AFTER it does not fail a durable write", async () => {
    const { content, raw, resolving } = setup();
    const ref = await content.put(encodeValue("r"));
    let n = 0;
    let failAt = 1;
    const real = content.touch.bind(content);
    content.touch = async (addresses) => {
      if (++n === failAt) throw new Error("touch unavailable");
      return real(addresses);
    };
    await expect(resolving.append(evt("e", 0, { output: ref }))).rejects.toThrow(/touch unavail/);
    expect(await raw.read("e")).toEqual([]);
    n = 0;
    failAt = 2; // the second (post-write) touch
    await resolving.append(evt("e", 0, { output: ref }));
    expect((await raw.read("e")).length).toBe(1);
  });

  it("a store WITHOUT touch is untouched: no walk, copyPrefix forwarded as-is", async () => {
    const inner = new InMemoryContentStore({ now: () => OLD });
    const bare: ContentStore = {
      put: (b) => inner.put(b),
      get: (r) => inner.get(r),
      delete: (r) => inner.delete(r),
    };
    const raw = new InMemoryAsyncEventStore();
    const resolving = new ContentResolvingEventStore(raw, bare, { externalize: {} });
    const ref = await inner.put(encodeValue("r"));
    await resolving.append(evt("p", 0, { input: {} }));
    await resolving.append(evt("p", 1, { output: ref }));
    await resolving.copyPrefix!("p", "f", 1, {});
    expect((await raw.read("f")).length).toBe(2);
  });

  it("a cyclic or very deep payload cannot overflow the walk (iterative, cycle-safe)", async () => {
    const { content, raw, resolving } = setup();
    const ref = await content.put(encodeValue("r"));
    const cyclic: Record<string, unknown> = { ref };
    cyclic.self = cyclic;
    let deep: unknown = { ref };
    for (let i = 0; i < 50_000; i++) deep = { d: deep };
    await resolving.append(evt("e", 0, cyclic));
    await resolving.append(evt("e", 1, deep));
    expect((await raw.read("e")).length).toBe(2);
  });
});
