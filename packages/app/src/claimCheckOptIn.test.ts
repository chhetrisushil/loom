import { tainted } from "@loom/classify";
import type { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { isClaimCheck } from "@loom/middleware";
import { ArchiveStoresRequiredError, sweepUnpinnedContent } from "@loom/plugin-content";
import { EncryptingEventStore, InMemoryKeyStore } from "@loom/plugin-crypto";
import { describe, expect, it } from "vitest";
import {
  CloningEventStore,
  CountingContentStore,
  boot,
  payload,
} from "./__fixtures__/claimCheckHarness";
import {
  DEFAULT_CLAIM_CHECK_CAP_BYTES,
  DEFAULT_CLAIM_CHECK_PREVIEW_CHARS,
  defineConfig,
  normalizeConfig,
} from "./defineConfig";

// ADR 0140 -- `execution.claimCheck`: the documented, OPT-IN one-liner that claim-checks large tool outputs
// for an agent workload (issue #731, refs #730). These run a real `defineConfig` app and a real `agentLoop$`.

const DAY = 86_400_000;

/** The recorded output of each tool step (`a#turn:N:tool:J`), in order. */
async function toolOutputs(store: InMemoryAsyncEventStore, id: string): Promise<unknown[]> {
  return (await store.read(id))
    .filter(
      (e) =>
        e.eventType === "STEP_COMPLETED" &&
        /#turn:\d+:tool:\d+$/.test(String((e.payload as { stepId: string }).stepId))
    )
    .map((e) => (e.payload as { output: unknown }).output);
}

/** Run an agent to its park, returning everything a follow-up needs. */
async function runToPark(o: Parameters<typeof boot>[0]) {
  const b = boot({ ...o, park: true });
  const h = await b.app.runtime.start(b.flow, {}, { executionId: "x" });
  await h.waitForSuspend();
  return b;
}

describe("execution.claimCheck - the opt-in (ADR 0140)", () => {
  it("offloads an over-cap tool result and leaves a small one inline", async () => {
    const content = new CountingContentStore();
    const b = await runToPark({
      turns: 6,
      toolFor: (n) => (n % 2 === 0 ? "big" : "small"),
      claimCheck: { store: content, toolIds: ["big", "small"] },
    });
    const outputs = await toolOutputs(b.eventStore, "x");
    expect(outputs).toHaveLength(6);
    const bigOnes = outputs.filter((o) => isClaimCheck(o));
    const inline = outputs.filter((o) => !isClaimCheck(o));
    expect(bigOnes).toHaveLength(3);
    expect(inline).toEqual([{ ok: 1 }, { ok: 3 }, { ok: 5 }]);
    expect(b.counts).toMatchObject({ big: 3, small: 3 });
    // each envelope points at the exact JSON the tool returned, and records the default preview
    for (const [i, env] of bigOnes.entries()) {
      const e = env as {
        ref: { __loomContent: string };
        size: number;
        digest: { preview: string };
      };
      const raw = JSON.stringify(payload(i * 2));
      expect(e.size).toBe(new TextEncoder().encode(raw).byteLength);
      expect(new TextDecoder().decode((await content.get(e.ref))!)).toBe(raw);
      expect(e.digest).toEqual({ preview: raw.slice(0, DEFAULT_CLAIM_CHECK_PREVIEW_CHARS) });
    }
    expect(content.calls.put).toBe(3);
    // the log holds NO big tool text: the model's later requests carry envelopes, not bodies
    expect(JSON.stringify(await b.eventStore.read("x")).length).toBeLessThan(40_000);
    const lastRequest = JSON.stringify(b.requests.at(-1));
    expect(lastRequest).toContain("__loomClaimCheck");
    expect(lastRequest).not.toContain(payload(0).text.slice(300, 400));
  });

  it("the model sees the envelope plus a declared digest, which replaces the default preview", async () => {
    const content = new CountingContentStore();
    const b = await runToPark({
      turns: 2,
      claimCheck: {
        store: content,
        toolIds: ["big"],
        digests: { big: (r) => ({ rows: (r as { n: number }).n }) },
      },
    });
    const outputs = (await toolOutputs(b.eventStore, "x")) as Array<{ digest: unknown }>;
    expect(outputs.map((o) => o.digest)).toEqual([{ rows: 0 }, { rows: 1 }]);
    expect(JSON.stringify(b.requests.at(-1))).toContain('\\"rows\\":0');
  });

  it("preview: false records ref and size only; a custom preview length is honoured", async () => {
    const none = await runToPark({
      turns: 1,
      claimCheck: { store: new CountingContentStore(), toolIds: ["big"], preview: false },
    });
    const [env] = (await toolOutputs(none.eventStore, "x")) as Array<Record<string, unknown>>;
    expect(Object.keys(env!).sort()).toEqual(["__loomClaimCheck", "ref", "size"]);
    const short = await runToPark({
      turns: 1,
      claimCheck: { store: new CountingContentStore(), toolIds: ["big"], preview: 40 },
    });
    const [env2] = (await toolOutputs(short.eventStore, "x")) as Array<{
      digest: { preview: string };
    }>;
    expect(env2!.digest.preview).toHaveLength(40);
  });

  it("only the listed tools are offloaded: an over-cap model response stays inline", async () => {
    const content = new CountingContentStore();
    const long = "y".repeat(5000);
    const b = await runToPark({
      turns: 1,
      finalText: long,
      claimCheck: { store: content, toolIds: ["big"] },
    });
    expect(content.calls.put).toBe(1); // the one big tool call, nothing else
    const events = await b.eventStore.read("x");
    const model = events.filter(
      (e) =>
        e.eventType === "STEP_COMPLETED" &&
        /#turn:1$/.test(String((e.payload as { stepId: string }).stepId))
    );
    expect(JSON.stringify(model)).toContain(long);
    // and a tool not listed is untouched even though it is over the cap
    const c2 = new CountingContentStore();
    const b2 = await runToPark({ turns: 1, claimCheck: { store: c2, toolIds: ["small"] } });
    expect(c2.calls.put ?? 0).toBe(0);
    expect(isClaimCheck((await toolOutputs(b2.eventStore, "x"))[0])).toBe(false);
  });

  it("DEFAULT UNCHANGED: without the opt-in no middleware is added and nothing is offloaded", async () => {
    const plain = boot({ turns: 2, park: true });
    expect((plain.app.effectRuntime as unknown as { middleware: unknown[] }).middleware).toEqual(
      []
    );
    const withIt = boot({
      turns: 2,
      park: true,
      claimCheck: { store: new CountingContentStore(), toolIds: ["big"] },
    });
    expect(
      (withIt.app.effectRuntime as unknown as { middleware: unknown[] }).middleware
    ).toHaveLength(1);
    await (await plain.app.runtime.start(plain.flow, {}, { executionId: "x" })).waitForSuspend();
    const outputs = await toolOutputs(plain.eventStore, "x");
    expect(outputs.some((o) => isClaimCheck(o))).toBe(false);
    expect(outputs[0]).toEqual(payload(0));
  });

  it("a tainted result is never previewed (the digest would launder the taint into the prompt)", async () => {
    const b = await runToPark({
      turns: 1,
      output: (_t, n) => tainted(payload(n), "mcp:untrusted"),
      claimCheck: { store: new CountingContentStore(), toolIds: ["big"] },
    });
    const [env] = (await toolOutputs(b.eventStore, "x")) as Array<Record<string, unknown>>;
    expect(isClaimCheck(env)).toBe(true);
    expect(env).not.toHaveProperty("digest");
  });

  it("validates its shape at boot, and the flat spelling is refused", () => {
    const store = new CountingContentStore();
    const make = (claimCheck: unknown) =>
      defineConfig({
        storage: { kind: "memory" },
        autostart: false,
        execution: { claimCheck: claimCheck as never },
      });
    expect(() => make({ store })).toThrow(/toolIds must be a non-empty array/);
    expect(() => make({ store, toolIds: [] })).toThrow(/toolIds must be a non-empty array/);
    expect(() => make({ store, toolIds: [""] })).toThrow(/non-empty strings/);
    expect(() => make({ toolIds: ["t"] })).toThrow(/store must be a content store/);
    expect(() => make({ store, toolIds: ["t"], inlineCapBytes: -1 })).toThrow(/inlineCapBytes/);
    expect(() => make({ store, toolIds: ["t"], preview: 1.5 })).toThrow(/preview/);
    expect(() => make("yes")).toThrow(/store must be a content store|must be an object/);
    expect(() => make({ store, toolIds: ["t"] })).not.toThrow();
    expect(() =>
      normalizeConfig({
        storage: { kind: "memory" },
        claimCheck: { store, toolIds: ["t"] },
      } as never)
    ).toThrow(/`claimCheck` → `execution.claimCheck`/);
    expect(DEFAULT_CLAIM_CHECK_CAP_BYTES).toBe(1024);
  });

  it("the default cap is 1 KiB of JSON text: exactly 1024 bytes stays inline, 1025 is offloaded", async () => {
    const content = new CountingContentStore();
    const exactly = (bytes: number) => "a".repeat(bytes - 2); // JSON adds the two quotes
    const b = await runToPark({
      turns: 2,
      output: (_t, n) => exactly(n === 0 ? 1024 : 1025),
      claimCheck: { store: content, toolIds: ["big"] },
    });
    const [at, over] = await toolOutputs(b.eventStore, "x");
    expect(at).toBe(exactly(1024));
    expect(isClaimCheck(over)).toBe(true);
    expect(DEFAULT_CLAIM_CHECK_CAP_BYTES).toBe(1024);
  });

  it("sits OUTSIDE user middleware (they see the real result) and the stored bytes are what the tool returned", async () => {
    const content = new CountingContentStore();
    const seen: unknown[] = [];
    const b = boot({
      turns: 1,
      park: true,
      claimCheck: { store: content, toolIds: ["big"] },
      effectMiddleware: [
        async (ctx, _input, next) => {
          const out = await next();
          if (ctx.toolId === "big") seen.push(out);
          return out;
        },
      ],
    });
    await (await b.app.runtime.start(b.flow, {}, { executionId: "x" })).waitForSuspend();
    expect(seen).toEqual([payload(0)]); // the inner middleware saw the raw result, not the envelope
    expect(isClaimCheck((await toolOutputs(b.eventStore, "x"))[0])).toBe(true);
  });

  it("inlineCapBytes moves the threshold", async () => {
    const content = new CountingContentStore();
    const b = await runToPark({
      turns: 2,
      claimCheck: { store: content, toolIds: ["big"], inlineCapBytes: 100_000 },
    });
    expect(content.calls.put ?? 0).toBe(0);
    expect((await toolOutputs(b.eventStore, "x")).some((o) => isClaimCheck(o))).toBe(false);
  });
});

describe("replay and resume serve the recorded envelope: ZERO content-store reads (ADR 0054)", () => {
  it("a fresh app resumes the parked run over the same log without touching the content store, a tool or the model", async () => {
    const content = new CountingContentStore();
    const first = await runToPark({
      turns: 5,
      claimCheck: { store: content, toolIds: ["big"] },
    });
    expect(content.calls.put).toBe(5);
    content.reset();

    // A brand-new app over the same stores: it replays every recorded turn from the log.
    const second = boot({
      turns: 5,
      park: true,
      eventStore: first.eventStore,
      snapshotStore: first.snapshotStore,
      archiveStore: first.archiveStore,
      claimCheck: { store: content, toolIds: ["big"] },
    });
    const h = await second.app.runtime.resume("x", { eventType: "go", payload: {} });
    const done = await h.waitForCompletion();
    expect(done.status).toBe("completed");
    expect(second.counts).toEqual({ model: 0, big: 0, small: 0 }); // nothing re-ran
    expect(content.calls).toEqual({}); // not one put, get, getMany, has or touch
  });

  it("holds even after the blobs are erased: the envelope IS the recorded value", async () => {
    const content = new CountingContentStore();
    const first = await runToPark({ turns: 3, claimCheck: { store: content, toolIds: ["big"] } });
    // erase every blob (the TTL sweep's job), then resume in a fresh app
    for (const o of await toolOutputs(first.eventStore, "x")) {
      await content.delete((o as { ref: { __loomContent: string } }).ref);
    }
    content.reset();
    const second = boot({
      turns: 3,
      park: true,
      eventStore: first.eventStore,
      snapshotStore: first.snapshotStore,
      claimCheck: { store: content, toolIds: ["big"] },
    });
    const done = await (
      await second.app.runtime.resume("x", { eventType: "go", payload: {} })
    ).waitForCompletion();
    expect(done.status).toBe("completed");
    expect(content.calls).toEqual({});
  });
});

describe("the erasing content sweep (ADR 0055 / 0138) and claim-checked agent outputs", () => {
  const sweep = (
    b: Awaited<ReturnType<typeof runToPark>>,
    content: CountingContentStore,
    now: number,
    extra: { archive?: boolean } = {}
  ) =>
    sweepUnpinnedContent({
      eventStores: [b.eventStore],
      snapshotStores: [b.snapshotStore],
      ...(extra.archive !== false && { archiveStores: [b.archiveStore] }),
      contentStore: content,
      pinnedEventTypes: [],
      olderThanMs: DAY,
      now,
      reclaimOrphans: { completeScan: true, snapshotsTouchContent: true },
    });

  it("keeps what a live log cites inside the TTL, reclaims a true orphan, and replay survives the TTL erase", async () => {
    const clock = { now: 1_000 };
    const content = new CountingContentStore(() => clock.now);
    const b = await runToPark({ turns: 4, claimCheck: { store: content, toolIds: ["big"] } });
    const orphan = await content.put(new TextEncoder().encode("cited by nothing"));
    const refs = (await toolOutputs(b.eventStore, "x")).map(
      (o) => (o as { ref: { __loomContent: string } }).ref
    );
    // inside the TTL: every envelope blob is kept; the orphan is too young to go
    clock.now = 1_000 + DAY / 2;
    let r = await sweep(b, content, 1_000 + DAY / 2);
    expect(r.reclaimed).toEqual([]);
    expect(r.orphansReclaimed).toEqual([]);
    for (const ref of refs) expect(await content.get(ref)).not.toBeNull();
    // past the TTL: the orphan goes; the live log's envelope blobs are telemetry (ADR 0054), reclaimable, and
    // erasing them is invisible to replay (covered above)
    clock.now = 1_000 + 100 * DAY;
    r = await sweep(b, content, 1_000 + 100 * DAY);
    expect(r.orphansReclaimed).toEqual([orphan.__loomContent]);
    expect([...r.reclaimed].sort()).toEqual(refs.map((ref) => ref.__loomContent).sort());
    for (const ref of refs) expect(await content.get(ref)).toBeNull();
    // ...and a fresh app still resumes the run: the erased blobs were never read
    const again = boot({
      turns: 4,
      park: true,
      eventStore: b.eventStore,
      snapshotStore: b.snapshotStore,
      claimCheck: { store: content, toolIds: ["big"] },
    });
    content.reset();
    const done = await (
      await again.app.runtime.resume("x", { eventType: "go", payload: {} })
    ).waitForCompletion();
    expect(done.status).toBe("completed");
    expect(content.calls).toEqual({});
  });

  it("a pinned event kind citing the output keeps it past the TTL", async () => {
    const clock = { now: 1_000 };
    const content = new CountingContentStore(() => clock.now);
    const b = await runToPark({ turns: 2, claimCheck: { store: content, toolIds: ["big"] } });
    const refs = (await toolOutputs(b.eventStore, "x")).map(
      (o) => (o as { ref: { __loomContent: string } }).ref
    );
    clock.now = 1_000 + 100 * DAY;
    const r = await sweepUnpinnedContent({
      eventStores: [b.eventStore],
      snapshotStores: [b.snapshotStore],
      archiveStores: [b.archiveStore],
      contentStore: content,
      pinnedEventTypes: ["STEP_COMPLETED"], // the app declares tool results evidence
      olderThanMs: DAY,
      now: 1_000 + 100 * DAY,
      reclaimOrphans: { completeScan: true, snapshotsTouchContent: true },
    });
    expect(r.reclaimed).toEqual([]);
    for (const ref of refs) expect(await content.get(ref)).not.toBeNull();
  });

  it("after a compaction the archive pins them past the TTL, and the erasing pass REFUSES without the archive", async () => {
    const clock = { now: 1_000 };
    const content = new CountingContentStore(() => clock.now);
    const b = await runToPark({
      turns: 4,
      claimCheck: { store: content, toolIds: ["big"] },
      snapshotEvery: 2,
    });
    const refs = (await toolOutputs(b.eventStore, "x")).map(
      (o) => (o as { ref: { __loomContent: string } }).ref
    );
    expect(await b.app.lifecycle.compact("x")).not.toBeNull();
    // the tool steps left the live log: the archive is the only event store that still cites them
    const live = JSON.stringify(await b.eventStore.read("x"));
    for (const ref of refs) expect(live).not.toContain(ref.__loomContent);
    const archived = JSON.stringify(await b.app.lifecycle.readArchived("x"));
    for (const ref of refs) expect(archived).toContain(ref.__loomContent);

    clock.now = 1_000 + 100 * DAY;
    // without the archive the erasing pass refuses and erases nothing
    await expect(sweep(b, content, 1_000 + 100 * DAY, { archive: false })).rejects.toBeInstanceOf(
      ArchiveStoresRequiredError
    );
    for (const ref of refs) expect(await content.get(ref)).not.toBeNull();
    // with it, past the TTL, nothing the recoverable history names is erased
    const r = await sweep(b, content, 1_000 + 100 * DAY);
    expect(r.reclaimed).toEqual([]);
    expect(r.orphansReclaimed).toEqual([]);
    for (const ref of refs) expect(await content.get(ref)).not.toBeNull();
    // The checkpoint snapshot also names these refs, so isolate the ARCHIVE's pin: a TTL pass that scans the
    // log and the archive but no snapshots must still keep them (the archived envelope is the only citation).
    const archiveOnly = await sweepUnpinnedContent({
      eventStores: [b.eventStore],
      archiveStores: [b.archiveStore],
      contentStore: content,
      pinnedEventTypes: [],
      olderThanMs: DAY,
      now: 1_000 + 100 * DAY,
    });
    expect(archiveOnly.reclaimed).toEqual([]);
    expect(archiveOnly.refsPinned).toBeGreaterThanOrEqual(refs.length);
    for (const ref of refs) expect(await content.get(ref)).not.toBeNull();
  });
});

describe("encryption is unaffected", () => {
  it("a sealing event store still seals the recorded envelope (digest included) and the run replays", async () => {
    const raw = new CloningEventStore();
    const keys = new InMemoryKeyStore();
    const events = new EncryptingEventStore(raw, keys, {
      sensitive: { STEP_COMPLETED: ["output"], STEP_STARTED: ["input"] },
    });
    const content = new CountingContentStore();
    const b = boot({
      turns: 2,
      park: true,
      eventStore: events as never,
      claimCheck: { store: content, toolIds: ["big"] },
      extra: {
        security: {
          strict: false,
          crypto: { events, allowPlaintextCheckpoints: true },
          compliance: {
            subjectOf: (e) => (e.eventType === "EXECUTION_STARTED" ? "alice" : undefined),
            erase: { shred: async () => {} },
          },
        },
      },
    });
    await (await b.app.runtime.start(b.flow, {}, { executionId: "x" })).waitForSuspend();
    const sealedLog = JSON.stringify(await raw.read("x"));
    expect(sealedLog).not.toContain(payload(0).text.slice(0, 40)); // the envelope and the model input that carries its preview are sealed at rest
    const outputs = await toolOutputs(events as never, "x");
    expect(outputs.every((o) => isClaimCheck(o))).toBe(true); // opened through the app's store
    const done = await (
      await b.app.runtime.resume("x", { eventType: "go", payload: {} })
    ).waitForCompletion();
    expect(done.status).toBe("completed");
  });
});
