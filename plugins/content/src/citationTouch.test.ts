import { runSnapshotStoreDecoratorConformance } from "@loom/conformance";
import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContentMissingError,
  ContentResolvingEventStore,
  type ContentStore,
  ContentTouchingSnapshotStore,
  InMemoryContentStore,
  type TouchReport,
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
    if (tip.head === null || tip.anchor === null)
      throw new Error("the execution exists, so its observation carries a head and an anchor");
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

describe("onTouchError reports what the touches could not do (ADR 0055 D6 amendment 2)", () => {
  function hooked(content: InMemoryContentStore) {
    const raw = new InMemoryAsyncEventStore();
    const reports: Array<{ err: unknown; info: TouchReport }> = [];
    const resolving = new ContentResolvingEventStore(raw, content, {
      externalize: {},
      onTouchError: (err, info) => reports.push({ err, info }),
    });
    return { raw, resolving, reports };
  }

  it("an after-touch that throws is reported (phase, operation, execution, addresses) and the durable write still succeeds", async () => {
    const { content } = setup();
    const ref = await content.put(encodeValue("r"));
    const { raw, resolving, reports } = hooked(content);
    const real = content.touch.bind(content);
    let n = 0;
    content.touch = async (a) => {
      if (++n === 2) throw new Error("store down");
      return real(a);
    };
    await resolving.append(evt("e", 0, { output: ref }));
    expect((await raw.read("e")).length).toBe(1);
    expect(reports).toHaveLength(1);
    expect((reports[0]!.err as Error).message).toBe("store down");
    expect(reports[0]!.info).toEqual({
      phase: "after",
      operation: "append",
      executionId: "e",
      addresses: [ref.__loomContent],
      missing: [],
    });
  });

  it("a cited bare ref the store reports MISSING is reported as a ContentMissingError, from either touch, on every write path", async () => {
    const { content } = setup();
    const ghost = { __loomContent: `sha256:${"b".repeat(64)}` };
    const { raw, resolving, reports } = hooked(content);
    await resolving.append(evt("a", 0, { output: ghost }));
    expect(reports.map((r) => r.info.phase)).toEqual(["before", "after"]); // gone at both touches
    expect(reports[0]!.err).toBeInstanceOf(ContentMissingError);
    expect((reports[0]!.err as ContentMissingError).contentAddress).toBe(ghost.__loomContent);
    expect(reports[0]!.info.missing).toEqual([ghost.__loomContent]);
    reports.length = 0;
    await resolving.appendBatch!([evt("b", 0, { output: ghost })]);
    await raw.append(evt("p", 0, { output: ghost }));
    await resolving.copyPrefix!("p", "f", 0, {});
    expect(reports.map((r) => r.info.operation)).toEqual([
      "appendBatch",
      "appendBatch",
      "copyPrefix",
      "copyPrefix",
    ]);
  });

  it("a missing claim-check envelope ref is NOT reported (it may be reclaimed on a TTL by design), nor is anything when all blobs are present", async () => {
    const { content } = setup();
    const present = await content.put(encodeValue("p"));
    const { resolving, reports } = hooked(content);
    const gone = {
      __loomClaimCheck: true,
      ref: { __loomContent: `sha256:${"c".repeat(64)}` },
      size: 1,
    };
    await resolving.append(evt("e", 0, { output: gone }));
    await resolving.append(evt("e", 1, { output: present }));
    expect(reports).toEqual([]);
  });

  it("a throwing observer cannot fail or change a write; a before-touch failure still rejects and is not reported", async () => {
    const { content, raw } = setup();
    const ghost = { __loomContent: `sha256:${"d".repeat(64)}` };
    const resolving = new ContentResolvingEventStore(raw, content, {
      externalize: {},
      onTouchError: () => {
        throw new Error("logger broke");
      },
    });
    await resolving.append(evt("e", 0, { output: ghost }));
    expect((await raw.read("e")).length).toBe(1);
    content.touch = async () => {
      throw new Error("before fails");
    };
    await expect(resolving.append(evt("e", 1, { output: ghost }))).rejects.toThrow(/before fails/);
    expect((await raw.read("e")).length).toBe(1);
  });
});

describe("touch problems with no onTouchError hook (ADR 0055 D6 amendment 2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("an async hook that rejects is not an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { content, raw } = setup();
      const ghost = { __loomContent: `sha256:${"e".repeat(64)}` };
      const resolving = new ContentResolvingEventStore(raw, content, {
        externalize: {},
        onTouchError: (async () => {
          throw new Error("async logger broke");
        }) as unknown as () => void,
      });
      await resolving.append(evt("e", 0, { output: ghost }));
      // unhandledRejection fires after the microtask queue drains; one macrotask turn is the condition.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("warns ONCE per process (code LOOM_CONTENT_TOUCH) for a missing bare ref or a failed after-touch", async () => {
    vi.resetModules();
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const mod = await import("./index");
    const { InMemoryAsyncEventStore: Mem } = await import("@loom/event-runtime");
    const content = new mod.InMemoryContentStore({ now: () => OLD });
    const raw = new Mem();
    const resolving = new mod.ContentResolvingEventStore(raw, content, { externalize: {} });
    const ghost = { __loomContent: `sha256:${"f".repeat(64)}` };
    await resolving.append(evt("e", 0, { output: ghost }));
    await resolving.append(evt("e", 1, { output: ghost }));
    const touchWarnings = warn.mock.calls.filter(
      (c) => (c[1] as { code?: string } | undefined)?.code === "LOOM_CONTENT_TOUCH"
    );
    expect(touchWarnings).toHaveLength(1);
    expect(String(touchWarnings[0]![0])).toMatch(/already gone/);
  });

  it("a hook, when given, replaces the warning", async () => {
    vi.resetModules();
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const mod = await import("./index");
    const { InMemoryAsyncEventStore: Mem } = await import("@loom/event-runtime");
    const content = new mod.InMemoryContentStore({ now: () => OLD });
    const seen: unknown[] = [];
    const resolving = new mod.ContentResolvingEventStore(new Mem(), content, {
      externalize: {},
      onTouchError: (e) => seen.push(e),
    });
    await resolving.append(evt("e", 0, { output: { __loomContent: `sha256:${"a".repeat(64)}` } }));
    expect(seen.length).toBeGreaterThan(0);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("ContentTouchingSnapshotStore (the fork's seed snapshot is a citation path)", () => {
  const snapshot = (executionId: string, sequence: number, state: unknown) =>
    ({
      id: `${executionId}-${sequence}`,
      executionId,
      workflowId: "wf",
      sequence,
      state,
      createdAt: OLD,
    }) as never;

  it("touches the cited addresses of a saved state (R5 media source and claim-check envelope included), before and after, then stores it unchanged", async () => {
    const { clock, content } = setup();
    const media = await content.put(encodeValue("media"));
    const offloaded = await content.put(encodeValue("offloaded"));
    const inner = new InMemoryAsyncSnapshotStore();
    const store = new ContentTouchingSnapshotStore(inner, content);
    clock.now = NOW;
    const state = {
      frames: {
        s: {
          output: {
            clip: { kind: "ref", ref: { address: media.__loomContent } },
            rows: { __loomClaimCheck: true, ref: offloaded, size: 1 },
          },
        },
      },
    };
    await store.save(snapshot("c", 3, state));
    expect(await touchedAt(content, media.__loomContent)).toBe(NOW);
    expect(await touchedAt(content, offloaded.__loomContent)).toBe(NOW);
    expect((await store.loadLatest("c"))?.state).toEqual(state);
    expect((await store.loadAt("c", 3))?.sequence).toBe(3);
    await store.deleteExecution!("c");
    expect(await store.loadLatest("c")).toBeNull();
  });

  it("a before-touch failure aborts the save; an after-touch failure is reported and the save stands; a ref-free state costs no touch", async () => {
    const { content } = setup();
    const ref = await content.put(encodeValue("r"));
    const inner = new InMemoryAsyncSnapshotStore();
    const reports: TouchReport[] = [];
    const store = new ContentTouchingSnapshotStore(inner, content, {
      onTouchError: (_e, info) => reports.push(info),
    });
    let calls = 0;
    const real = content.touch.bind(content);
    content.touch = async (a) => {
      calls++;
      if (calls === 1) throw new Error("no touch");
      if (calls === 3) throw new Error("no touch after"); // 2 = the next save's before-touch
      return real(a);
    };
    await expect(store.save(snapshot("c", 1, { x: ref }))).rejects.toThrow(/no touch/);
    expect(await inner.loadLatest("c")).toBeNull();
    await store.save(snapshot("c", 2, { x: ref }));
    expect((await inner.loadLatest("c"))?.sequence).toBe(2);
    expect(reports.map((r) => [r.phase, r.operation])).toEqual([["after", "snapshotSave"]]);
    calls = 0;
    await store.save(snapshot("c", 3, { plain: 1 }));
    expect(calls).toBe(0);
  });
});

runSnapshotStoreDecoratorConformance(
  "ContentTouchingSnapshotStore",
  (inner) => new ContentTouchingSnapshotStore(inner, new InMemoryContentStore())
);
