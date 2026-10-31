import { isClaimCheck, resolveClaimCheck } from "@loom/middleware";
import { sweepUnpinnedContent } from "@loom/plugin-content";
import {
  ContentAccessRequiredError,
  EncryptingContentStore,
  EncryptingEventStore,
  InMemoryKeyStore,
  shredSubject,
} from "@loom/plugin-crypto";
import { describe, expect, it } from "vitest";
import { CloningEventStore, CountingContentStore, boot } from "./__fixtures__/claimCheckHarness";
import { payload } from "./__fixtures__/claimCheckHarness";

// ADR 0143 -- `execution.claimCheck` under `security.crypto` with the EncryptingContentStore: a real
// `defineConfig` app, a real `agentLoop$`, a sealing log AND a sealing content store over ONE KeyStore.

const DAY = 86_400_000;
const NO_SNAPSHOTS = { loadLatest: async () => null };

function world(turns = 2) {
  const keys = new InMemoryKeyStore();
  const raw = new CloningEventStore();
  const events = new EncryptingEventStore(raw, keys, { sensitive: {} });
  const inner = new CountingContentStore();
  const content = new EncryptingContentStore(inner, keys);
  const security = (
    subjectOf = (e: { eventType: string; payload: unknown }) =>
      e.eventType === "EXECUTION_STARTED"
        ? (e.payload as { input?: { userId?: string } }).input?.userId
        : undefined
  ) => ({
    strict: false,
    crypto: { events, allowPlaintextCheckpoints: true },
    compliance: {
      subjectOf,
      erase: {
        shred: (_s: string, ids: readonly string[]) =>
          shredSubject(keys, raw, ids[0] as string, {
            subjectId: ids[0] as string,
            executionIds: [...ids],
            snapshotStore: NO_SNAPSHOTS,
          }),
      },
    },
  });
  const start = async (executionId = "x", userId = "ann") => {
    const b = boot({
      turns,
      park: true,
      eventStore: events as never,
      claimCheck: { store: content, toolIds: ["big"] },
      extra: { security: security() as never },
    });
    const h = await b.app.runtime.start(b.flow, { userId }, { executionId });
    await h.waitForSuspend();
    return b;
  };
  return { keys, raw, events, inner, content, security, start };
}

async function envelopes(events: EncryptingEventStore, id: string) {
  return (await events.read(id))
    .filter(
      (e) =>
        e.eventType === "STEP_COMPLETED" &&
        /#turn:\d+:tool:\d+$/.test(String((e.payload as { stepId: string }).stepId))
    )
    .map((e) => (e.payload as { output: unknown }).output) as Array<{
    ref: { __loomContent: string };
    retain?: true;
  }>;
}

/** Let a parked run finish: erasure waits for a subject's executions to be terminal. */
async function finish(b: Pick<Awaited<ReturnType<typeof boot>>, "app">, id: string): Promise<void> {
  await (await b.app.runtime.resume(id, { eventType: "go", payload: {} })).waitForCompletion();
}

async function innerBytes(inner: CountingContentStore): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  const page = await inner.listPage({ limit: 100 });
  for (const e of page.entries) out.push((await inner.get({ __loomContent: e.address }))!);
  return out;
}

describe("claim-check under security.crypto with the EncryptingContentStore (ADR 0143)", () => {
  it("is ACCEPTED at boot, offloads sealed blobs, and the inner store never holds plaintext", async () => {
    const w = world();
    await w.start();
    const envs = await envelopes(w.events, "x");
    expect(envs).toHaveLength(2);
    expect(envs.every((e) => isClaimCheck(e) && e.retain === true)).toBe(true);
    const needle = new TextEncoder().encode(payload(0).text.slice(0, 80));
    const blobs = await innerBytes(w.inner);
    expect(blobs.length).toBe(2);
    for (const b of blobs) expect(Buffer.from(b).includes(Buffer.from(needle))).toBe(false);
    // the owner reads it back
    const back = await resolveClaimCheck(w.content, envs[0] as never, {
      executionId: "x",
      workflowId: "agent",
    });
    expect(back).toEqual(payload(0));
  });

  it("resume in a fresh app makes ZERO content-store calls and re-runs nothing", async () => {
    const w = world(3);
    const first = await w.start();
    w.inner.reset();
    const second = boot({
      turns: 3,
      park: true,
      eventStore: w.events as never,
      snapshotStore: first.snapshotStore,
      archiveStore: first.archiveStore,
      claimCheck: { store: w.content, toolIds: ["big"] },
      extra: { security: w.security() as never },
    });
    const done = await (
      await second.app.runtime.resume("x", { eventType: "go", payload: {} })
    ).waitForCompletion();
    expect(done.status).toBe("completed");
    expect(second.counts).toEqual({ model: 0, big: 0, small: 0 });
    expect(w.inner.calls).toEqual({});
  });

  it("exportSubject returns the RESOLVED blobs for the subject", async () => {
    const w = world();
    const b = await w.start();
    const exp = await b.app.exportSubject("ann");
    const blobs = exp.executions[0]!.claimChecked!;
    expect(blobs.map((x) => x.value)).toEqual([payload(0), payload(1)]);
  });

  it("eraseSubject records the sealed completion, deletes the ciphertext, and leaves nothing readable", async () => {
    const w = world();
    const b = await w.start();
    const envs = await envelopes(w.events, "x");
    await finish(b, "x");
    const r = await b.app.eraseSubject("ann");
    expect(r.outcome).toBe("erased");
    expect(r.contentDeleted).toEqual({ deleted: 2, retained: 0, sealed: 2 });
    const control = await w.raw.read("__loom_erasure__");
    const types = control.map((e) => e.eventType);
    expect(types.indexOf("ERASURE_CONTENT_DELETE_INTENDED")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("ERASURE_CONTENT_DELETE_INTENDED")).toBeLessThan(
      types.indexOf("ERASURE_CONTENT_DELETED")
    );
    const intent = control.find((e) => e.eventType === "ERASURE_CONTENT_DELETE_INTENDED")!;
    expect(intent.payload).toMatchObject({ sealed: true });
    const done = control.find((e) => e.eventType === "ERASURE_CONTENT_DELETED")!;
    expect(done.payload).toMatchObject({ subjectId: "ann", deleted: 2, sealed: 2 });
    // no plaintext copy anywhere: the ciphertext is gone, and the key is destroyed
    expect(await innerBytes(w.inner)).toEqual([]);
    expect(await w.keys.get("x")).toBeNull();
    expect(await w.content.get(envs[0]!.ref, { executionId: "x", workflowId: "agent" })).toBeNull(); // deleted: absent reads as null
  });

  it("erasure with an inner store that cannot delete still records it; the shred leaves the ciphertext unreadable", async () => {
    const w = world();
    const noDelete = Object.assign(Object.create(w.inner), {
      delete: undefined,
    }) as CountingContentStore;
    const content = new EncryptingContentStore(noDelete, w.keys);
    Object.defineProperty(content, "delete", { value: undefined });
    const b = boot({
      turns: 2,
      park: true,
      eventStore: w.events as never,
      claimCheck: { store: content, toolIds: ["big"] },
      extra: { security: w.security() as never },
    });
    await (
      await b.app.runtime.start(b.flow, { userId: "ann" }, { executionId: "x" })
    ).waitForSuspend();
    const envs = await envelopes(w.events, "x");
    await finish(b, "x");
    const r = await b.app.eraseSubject("ann");
    expect(r.contentDeleted).toEqual({ deleted: 0, retained: 0, sealed: 2 });
    expect((await innerBytes(w.inner)).length).toBe(2); // ciphertext remains, unreadable
    await expect(
      content.get(envs[0]!.ref, { executionId: "x", workflowId: "agent" })
    ).rejects.toMatchObject({ name: "PayloadShreddedError" });
  });

  it("an identical tool output under two subjects is two unrelated blobs: erasing one leaves the other readable", async () => {
    const w = world(1);
    const a = await w.start("run-a", "ann");
    const bb = await w.start("run-b", "bob");
    await finish(a, "run-a");
    await finish(bb, "run-b");
    const [ea] = await envelopes(w.events, "run-a");
    const [eb] = await envelopes(w.events, "run-b");
    expect(ea!.ref.__loomContent).not.toBe(eb!.ref.__loomContent); // payload(0) both, different addresses
    await a.app.eraseSubject("ann");
    expect(
      await resolveClaimCheck(w.content, eb as never, { executionId: "run-b", workflowId: "agent" })
    ).toEqual(payload(0));
  });

  it("the content sweep keeps the retained sealed blobs by address and needs no key", async () => {
    const w = world();
    const b = await w.start();
    const refs = (await envelopes(w.events, "x")).map((e) => e.ref.__loomContent);
    await w.keys.destroy("unrelated"); // the sweep never touches a key
    const r = await sweepUnpinnedContent({
      eventStores: [w.raw],
      snapshotStores: [b.snapshotStore],
      archiveStores: [b.archiveStore],
      contentStore: w.content,
      pinnedEventTypes: [],
      olderThanMs: DAY,
      now: Date.now() + 100 * DAY,
      reclaimOrphans: { completeScan: true, snapshotsTouchContent: true },
    });
    expect(r.reclaimed).toEqual([]);
    expect(r.orphansReclaimed).toEqual([]);
    const held = (await innerBytes(w.inner)).length;
    expect(held).toBe(refs.length);
  });

  it("a content call without the owner is refused, never sealed under a guess", async () => {
    const w = world();
    await expect(w.content.put(new Uint8Array([1]))).rejects.toBeInstanceOf(
      ContentAccessRequiredError
    );
  });
});

describe("boot refusals (ADR 0143 D6): the blobs must sit under the SAME keys as the log", () => {
  const cfg = (events: EncryptingEventStore, content: EncryptingContentStore) =>
    boot({
      turns: 1,
      eventStore: events as never,
      claimCheck: { store: content, toolIds: ["big"] },
      extra: { security: { strict: false, crypto: { events, allowPlaintextCheckpoints: true } } },
    });

  it("a different KeyStore is refused", () => {
    const events = new EncryptingEventStore(new CloningEventStore(), new InMemoryKeyStore(), {
      sensitive: {},
    });
    const content = new EncryptingContentStore(new CountingContentStore(), new InMemoryKeyStore());
    expect(() => cfg(events, content)).toThrow(/different KeyStore/);
  });

  it("a different subjectOf is refused", () => {
    const keys = new InMemoryKeyStore();
    const events = new EncryptingEventStore(new CloningEventStore(), keys, { sensitive: {} });
    const content = new EncryptingContentStore(new CountingContentStore(), keys, {
      subjectOf: (e) => `t:${e.executionId}`,
    });
    expect(() => cfg(events, content)).toThrow(/different subjectOf/);
  });

  it("the same keys and the default subjectOf boot", () => {
    const keys = new InMemoryKeyStore();
    const events = new EncryptingEventStore(new CloningEventStore(), keys, { sensitive: {} });
    expect(() =>
      cfg(events, new EncryptingContentStore(new CountingContentStore(), keys))
    ).not.toThrow();
  });

  it("a plain store is still refused with the wiring to use", () => {
    const keys = new InMemoryKeyStore();
    const events = new EncryptingEventStore(new CloningEventStore(), keys, { sensitive: {} });
    expect(() =>
      boot({
        turns: 1,
        eventStore: events as never,
        claimCheck: { store: new CountingContentStore(), toolIds: ["big"] },
        extra: { security: { strict: false, crypto: { events, allowPlaintextCheckpoints: true } } },
      })
    ).toThrow(/EncryptingContentStore/);
  });
});
