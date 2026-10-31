import { isTainted, taintOf, tainted } from "@loom/classify";
import type { InMemoryAsyncEventStore } from "@loom/event-runtime";
import {
  InMemorySecretResolver,
  claimCheckMiddleware,
  isClaimCheck,
  previewDigest,
  redactionMiddleware,
} from "@loom/middleware";
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
import { testPrincipalCodec } from "./principalTestSupport";

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
      // H4: the preview says it is a head (the tail is withheld from the model)
      expect(e.digest).toEqual({
        preview: raw.slice(0, DEFAULT_CLAIM_CHECK_PREVIEW_CHARS),
        truncated: true,
      });
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
    expect(Object.keys(env!).sort()).toEqual(["__loomClaimCheck", "ref", "retain", "size"]);
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

  it("a tainted result is never previewed AND the recorded envelope stays tainted (H3: no laundering)", async () => {
    const b = await runToPark({
      turns: 1,
      output: (_t, n) => tainted(payload(n), "mcp:untrusted"),
      claimCheck: { store: new CountingContentStore(), toolIds: ["big"] },
    });
    const [out] = await toolOutputs(b.eventStore, "x");
    // the envelope is wrapped, so agentLoop$ fences it and records `sawTaintFrom`
    expect(isTainted(out)).toBe(true);
    expect(taintOf(out)?.origin).toBe("mcp:untrusted");
    const env = (out as { value: Record<string, unknown> }).value;
    expect(isClaimCheck(env)).toBe(true);
    expect(env).not.toHaveProperty("digest");
    // the model's next request carries the fenced content, not a clean-looking envelope
    expect(JSON.stringify(b.requests.at(-1))).toContain("mcp:untrusted");
  });

  it("a DECLARED digest on a top-level tainted (MCP-style) result is still tainted, and the sweep still finds the envelope", async () => {
    const content = new CountingContentStore();
    const b = await runToPark({
      turns: 1,
      output: (_t, n) => tainted(payload(n), "mcp:acme/search"),
      claimCheck: {
        store: content,
        toolIds: ["big"],
        digests: { big: () => ({ rows: 7 }) },
      },
    });
    const [out] = await toolOutputs(b.eventStore, "x");
    expect(isTainted(out)).toBe(true);
    expect((out as { value: { digest: unknown } }).value.digest).toEqual({ rows: 7 });
    // a nested marker (an A2A-style `content` field) taints it all the same
    const nested = await runToPark({
      turns: 1,
      output: (_t, n) => ({ ...payload(n), content: tainted("peer says hi", "a2a:peer") }),
      claimCheck: { store: new CountingContentStore(), toolIds: ["big"] },
    });
    const [nout] = await toolOutputs(nested.eventStore, "x");
    expect(taintOf(nout)?.origin).toBe("a2a:peer");
    // the retained blob is found through the tainted wrapper: a TTL sweep keeps it
    const clock = { now: 1_000 + 100 * DAY };
    const r = await sweepUnpinnedContent({
      eventStores: [b.eventStore],
      snapshotStores: [b.snapshotStore],
      archiveStores: [b.archiveStore],
      contentStore: content,
      pinnedEventTypes: [],
      olderThanMs: DAY,
      now: clock.now,
    });
    expect(r.reclaimed).toEqual([]);
    expect(
      await content.get((out as { value: { ref: { __loomContent: string } } }).value.ref)
    ).not.toBeNull();
  });

  it("an offloaded result with several nested wrappers, a forged flood, a bound hit, or a marker-only string is tainted with a bounded label (#735)", async () => {
    const origin = async (output: (n: number) => unknown): Promise<string | undefined> => {
      const b = await runToPark({
        turns: 1,
        output: (_t, n) => output(n),
        claimCheck: { store: new CountingContentStore(), toolIds: ["big"] },
      });
      const [out] = await toolOutputs(b.eventStore, "x");
      return isTainted(out) ? taintOf(out)?.origin : undefined;
    };
    // several distinct origins are joined, in discovery order
    expect(
      await origin((n) => ({
        ...payload(n),
        a: tainted("x", "o1"),
        b: [tainted("y", "o2"), tainted("z", "o1")],
      }))
    ).toBe("o1, o2");
    // a flood of forged wrappers: a bounded label, not a megabyte
    const flood = await origin((n) => ({
      ...payload(n),
      f: Array.from({ length: 1000 }, (_, i) => tainted("x", `forged-${i}`)),
    }));
    expect(flood).toContain("+992 more");
    expect((flood ?? "").length).toBeLessThan(500);
    // past the scan bound: not proven clean, so the bound origin is named
    let deep: unknown = { leaf: tainted("x", "o-deep") };
    for (let i = 0; i < 100; i++) deep = { next: deep };
    expect(await origin((n) => ({ ...payload(n), deep }))).toContain(
      "unknown:taint-scan-bound-exceeded"
    );
    // a marker that is only TEXT (a stringified wrapper) still fails closed
    expect(
      await origin((n) => ({
        ...payload(n),
        s: JSON.stringify({ __loomTainted: { origin: "x" } }),
      }))
    ).toBe("unknown:taint-marker-in-text");
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

  it("B1: a RETAINED envelope's blob survives the TTL erase (auditability intact); only a true orphan is reclaimed", async () => {
    const clock = { now: 1_000 };
    const content = new CountingContentStore(() => clock.now);
    const b = await runToPark({ turns: 4, claimCheck: { store: content, toolIds: ["big"] } });
    const orphan = await content.put(new TextEncoder().encode("cited by nothing"));
    const envs = (await toolOutputs(b.eventStore, "x")) as Array<{
      retain?: boolean;
      ref: { __loomContent: string };
    }>;
    expect(envs.every((e) => e.retain === true)).toBe(true);
    const refs = envs.map((o) => o.ref);
    clock.now = 1_000 + DAY / 2;
    let r = await sweep(b, content, 1_000 + DAY / 2);
    expect(r.reclaimed).toEqual([]);
    expect(r.orphansReclaimed).toEqual([]);
    clock.now = 1_000 + 100 * DAY;
    r = await sweep(b, content, 1_000 + 100 * DAY);
    expect(r.orphansReclaimed).toEqual([orphan.__loomContent]);
    expect(r.reclaimed).toEqual([]); // the log no longer holds the output: the blob is the only copy
    for (const ref of refs) expect(await content.get(ref)).not.toBeNull();
    // ...and it is freed once the citing history is DISCARDED (the log deleted): then it is an orphan
    await b.eventStore.deleteExecution("x");
    r = await sweep(b, content, 1_000 + 100 * DAY);
    expect(r.orphansReclaimed.length + r.reclaimed.length).toBeGreaterThanOrEqual(refs.length);
  });

  it("B1: reclaimable: [tool] is the explicit audit trade - those blobs are TTL-reclaimed and replay survives", async () => {
    const clock = { now: 1_000 };
    const content = new CountingContentStore(() => clock.now);
    const cc = { store: content, toolIds: ["big"], reclaimable: ["big"] };
    const b = await runToPark({ turns: 4, claimCheck: cc });
    const envs = (await toolOutputs(b.eventStore, "x")) as Array<{
      retain?: boolean;
      ref: { __loomContent: string };
    }>;
    expect(envs.some((e) => e.retain !== undefined)).toBe(false);
    const refs = envs.map((o) => o.ref);
    clock.now = 1_000 + 100 * DAY;
    const r = await sweep(b, content, 1_000 + 100 * DAY);
    expect([...r.reclaimed].sort()).toEqual(refs.map((ref) => ref.__loomContent).sort());
    for (const ref of refs) expect(await content.get(ref)).toBeNull();
    const again = boot({
      turns: 4,
      park: true,
      eventStore: b.eventStore,
      snapshotStore: b.snapshotStore,
      claimCheck: cc,
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

describe("security.crypto / compliance.erase fail closed (ADR 0140 D8)", () => {
  const sealing = () => {
    const raw = new CloningEventStore();
    const events = new EncryptingEventStore(raw, new InMemoryKeyStore(), {
      sensitive: { STEP_COMPLETED: ["output"], STEP_STARTED: ["input"] },
    });
    return events;
  };

  it("B2(a): execution.claimCheck with security.crypto is REFUSED at boot unless the store seals per subject", () => {
    const events = sealing();
    expect(() =>
      boot({
        turns: 1,
        eventStore: events as never,
        claimCheck: { store: new CountingContentStore(), toolIds: ["big"] },
        extra: { security: { strict: false, crypto: { events, allowPlaintextCheckpoints: true } } },
      })
    ).toThrow(/security\.crypto is refused.*PLAINTEXT.*sealsContent/s);
  });

  it("B2(a): a store that DECLARES sealsContent is accepted, and the sealed run replays", async () => {
    const events = sealing();
    const content = Object.assign(new CountingContentStore(), { sealsContent: true as const });
    const b = boot({
      turns: 2,
      park: true,
      eventStore: events as never,
      claimCheck: { store: content, toolIds: ["big"] },
      extra: { security: { strict: false, crypto: { events, allowPlaintextCheckpoints: true } } },
    });
    await (await b.app.runtime.start(b.flow, {}, { executionId: "x" })).waitForSuspend();
    const outputs = await toolOutputs(events as never, "x");
    expect(outputs.every((o) => isClaimCheck(o))).toBe(true);
    const done = await (
      await b.app.runtime.resume("x", { eventType: "go", payload: {} })
    ).waitForCompletion();
    expect(done.status).toBe("completed");
  });

  it("B2: compliance.erase over a store that cannot delete is refused at boot", () => {
    const noDelete = { put: (b: Uint8Array) => new CountingContentStore().put(b) };
    expect(() =>
      boot({
        turns: 1,
        claimCheck: { store: noDelete, toolIds: ["big"] },
        extra: {
          security: {
            strict: false,
            principalCodec: testPrincipalCodec(),
            compliance: { subjectOf: () => "alice", erase: { shred: async () => {} } },
          },
        },
      })
    ).toThrow(/needs a content store that can delete/);
  });
});

describe("B2(b): erasing a subject reaches the claim-checked blobs (plaintext store)", () => {
  async function twoSubjects() {
    const content = new CountingContentStore();
    // alice's tool outputs are payload(0), payload(1); bob's is payload(0) (an identical, deduplicated blob)
    const b = boot({
      turns: 2,
      claimCheck: { store: content, toolIds: ["big"] },
      extra: {
        security: {
          strict: false,
          principalCodec: testPrincipalCodec(),
          compliance: {
            subjectOf: (e) =>
              e.eventType === "EXECUTION_STARTED"
                ? e.executionId === "alice-run"
                  ? "alice"
                  : "bob"
                : undefined,
            erase: { shred: async () => {} },
          },
        },
      },
    });
    await (await b.app.runtime.start(b.flow, {}, { executionId: "alice-run" })).waitForCompletion();
    const bob = boot({
      turns: 1,
      claimCheck: { store: content, toolIds: ["big"] },
      eventStore: b.eventStore,
      snapshotStore: b.snapshotStore,
      archiveStore: b.archiveStore,
      extra: {
        security: {
          strict: false,
          principalCodec: testPrincipalCodec(),
          compliance: {
            subjectOf: (e) =>
              e.eventType === "EXECUTION_STARTED"
                ? e.executionId === "alice-run"
                  ? "alice"
                  : "bob"
                : undefined,
            erase: { shred: async () => {} },
          },
        },
      },
    });
    await (
      await bob.app.runtime.start(bob.flow, {}, { executionId: "bob-run" })
    ).waitForCompletion();
    // the index of `b` learns bob's start from the shared event stream only through its own onEvent: rebuild
    return { content, alice: b, bob };
  }

  it("deletes the subject's blobs, KEEPS the one another subject's execution still cites, and records it", async () => {
    const { content, alice, bob } = await twoSubjects();
    const aliceEnvs = (await toolOutputs(alice.eventStore, "alice-run")) as Array<{
      ref: { __loomContent: string };
    }>;
    expect(aliceEnvs).toHaveLength(2);
    const [shared, own] = aliceEnvs.map((e) => e.ref);
    const bobEnvs = (await toolOutputs(bob.eventStore, "bob-run")) as Array<{
      ref: { __loomContent: string };
    }>;
    expect(bobEnvs[0]!.ref.__loomContent).toBe(shared!.__loomContent); // dedupe: ONE blob, two owners
    const r = await alice.app.eraseSubject("alice");
    expect(r.outcome).toBe("erased");
    expect(r.contentDeleted).toEqual({ deleted: 1, retained: 1 });
    expect(await content.get(own!)).toBeNull(); // alice's own blob is GONE
    expect(await content.get(shared!)).not.toBeNull(); // bob still cites the identical one
    const control = await alice.eventStore.read("__loom_erasure__");
    const types = control.map((e) => e.eventType);
    expect(types.indexOf("ERASURE_CONTENT_DELETE_INTENDED")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("ERASURE_CONTENT_DELETE_INTENDED")).toBeLessThan(
      types.indexOf("ERASURE_CONTENT_DELETED")
    );
    const done = control.find((e) => e.eventType === "ERASURE_CONTENT_DELETED")!;
    expect(done.payload).toMatchObject({ subjectId: "alice", deleted: 1, retained: 1 });
  });

  it("exportSubject returns the RESOLVED blobs, not just the envelopes", async () => {
    const { alice } = await twoSubjects();
    const exp = await alice.app.exportSubject("alice");
    const blobs = exp.executions[0]!.claimChecked!;
    expect(blobs.map((x) => x.value)).toEqual([payload(0), payload(1)]);
    expect(blobs.every((x) => x.size! > 1024)).toBe(true);
  });
});

describe("tool-frame scoping, media, forged envelopes, hook failures (M5-M7, L9)", () => {
  it("M5: invokeTransient of a listed tool is NOT offloaded", async () => {
    const content = new CountingContentStore();
    const b = boot({ turns: 0, claimCheck: { store: content, toolIds: ["big"] } });
    const out = await b.app.effectRuntime.invokeTransient("big", { n: 3 });
    expect(isClaimCheck(out)).toBe(false);
    expect(out).toEqual(payload(3));
    expect(content.calls.put ?? 0).toBe(0);
  });

  it("M5: only an agent TOOL frame is offloaded: not a flow task of another kind or id, even for a listed tool", async () => {
    const content = new CountingContentStore();
    const b = boot({ turns: 0, claimCheck: { store: content, toolIds: ["big"] } });
    const task = (kind: string, id: string) =>
      ({ _tag: "TaskDefinition", kind, id, toolId: "big" }) as never;
    const flow = {
      definition: { ...b.flow.definition, id: "other" },
      runner: async (ctx: { execute: (t: never, i: unknown) => Promise<unknown> }) => ({
        // id shaped like a tool frame, but kind "memory"
        a: await ctx.execute(task("memory", "o#turn:0:tool:0"), { n: 1 }),
        // kind "tool", but not an agent frame id
        b: await ctx.execute(task("tool", "plain-step"), { n: 2 }),
        // a genuine agent tool frame
        c: await ctx.execute(task("tool", "o#turn:1:tool:0"), { n: 3 }),
      }),
    } as never;
    const out = (await (
      await b.app.runtime.start(flow, {}, { executionId: "y" })
    ).waitForCompletion()) as unknown as { a: unknown; b: unknown; c: unknown };
    expect(isClaimCheck(out.a)).toBe(false);
    expect(isClaimCheck(out.b)).toBe(false);
    expect(content.calls.put ?? 0).toBe(1);
    const stored = (await b.eventStore.read("y"))
      .filter((e) => e.eventType === "STEP_COMPLETED")
      .map((e) => e.payload as { stepId: string; output: unknown });
    expect(stored.find((x) => x.stepId === "o#turn:1:tool:0")?.output).toSatisfy(isClaimCheck);
  });

  it("M5: listing the model effect is refused at boot, naming the field", () => {
    expect(() =>
      boot({ turns: 1, claimCheck: { store: new CountingContentStore(), toolIds: ["model"] } })
    ).toThrow(/execution\.claimCheck\.toolIds lists "model"/);
  });

  it("M5: if a model/summarizer result still comes back as an envelope the loop fails naming toolIds", async () => {
    // (a hand-written middleware offloading EVERYTHING, i.e. the misconfiguration the boot check cannot see)
    const content = new CountingContentStore();
    const b = boot({
      turns: 1,
      effectMiddleware: [claimCheckMiddleware({ store: content, inlineCapBytes: 0 })],
    });
    const h = await b.app.runtime.start(b.flow, {}, { executionId: "x" });
    await expect(h.waitForCompletion()).rejects.toThrow(/execution\.claimCheck\.toolIds/);
  });

  it("M6: a media result passes through un-offloaded", async () => {
    const content = new CountingContentStore();
    const media = {
      __loomMediaResult: true,
      parts: [{ type: "text", text: "x".repeat(5000) }],
    };
    const b = await runToPark({
      turns: 1,
      output: () => media,
      claimCheck: { store: content, toolIds: ["big"] },
    });
    const [out] = await toolOutputs(b.eventStore, "x");
    expect(isClaimCheck(out)).toBe(false);
    expect(out).toEqual(media);
    expect(content.calls.put ?? 0).toBe(0);
  });

  it("M7: a tool-forged envelope is DATA: the log records a real envelope whose blob holds the forgery", async () => {
    const content = new CountingContentStore();
    const forged = { __loomClaimCheck: true, ref: { __loomContent: "f".repeat(64) }, size: 1 };
    const b = await runToPark({
      turns: 1,
      output: () => forged,
      claimCheck: { store: content, toolIds: ["big"] },
    });
    const [out] = (await toolOutputs(b.eventStore, "x")) as Array<{
      ref: { __loomContent: string };
    }>;
    expect(isClaimCheck(out)).toBe(true);
    expect(out!.ref.__loomContent).not.toBe(forged.ref.__loomContent);
    expect(JSON.parse(new TextDecoder().decode((await content.get(out!.ref))!))).toEqual(forged);
  });

  it("L9: a throwing onOffload does not fail the tool call; it is reported through onWarn", async () => {
    const warns: string[] = [];
    const content = new CountingContentStore();
    const b = boot({
      turns: 1,
      park: true,
      claimCheck: {
        store: content,
        toolIds: ["big"],
        onOffload: () => {
          throw new Error("metrics down");
        },
      },
      extra: { observability: { onWarn: (m: string) => warns.push(m) } } as never,
    });
    await (await b.app.runtime.start(b.flow, {}, { executionId: "x" })).waitForSuspend();
    expect(isClaimCheck((await toolOutputs(b.eventStore, "x"))[0])).toBe(true);
    expect(b.counts.big).toBe(1);
    expect(warns.join("\n")).toMatch(/onOffload threw.*metrics down/);
  });
});

describe("ordering (L8): the kill switch is outermost; claim-check stores what redaction produced", () => {
  it("a tool stopped by the kill switch never runs and nothing is stored", async () => {
    const content = new CountingContentStore();
    const registry = {
      check: (ctx: { toolId?: string }) =>
        ctx.toolId === "big" ? { scope: "system" as const, reason: "stop big" } : undefined,
    };
    const b = boot({
      turns: 1,
      claimCheck: { store: content, toolIds: ["big"] },
      extra: { security: { strict: false, killSwitch: registry as never } },
    });
    const h = await b.app.runtime.start(b.flow, {}, { executionId: "x" });
    await h.waitForCompletion().catch(() => {});
    expect(b.counts.big).toBe(0);
    expect(content.calls.put ?? 0).toBe(0);
  });

  it("composed outside redaction, the preview and the blob are made from the REDACTED bytes", async () => {
    const resolver = new InMemorySecretResolver(new Map());
    const cc = claimCheckMiddleware({
      store: new CountingContentStore(),
      inlineCapBytes: 0,
      defaultDigest: previewDigest(500),
    });
    const red = redactionMiddleware({ resolver, redactOutput: () => ["token"] });
    const ctx = {
      executionId: "e",
      stepId: "s",
      workflowId: "w",
      attempt: 1,
      toolId: "t",
      emit: () => {},
    } as never;
    const out = (await cc(ctx, {}, () =>
      red(ctx, {}, async () => ({ token: "sk_REAL_SECRET", ok: true }))
    )) as { digest: { preview: string }; ref: { __loomContent: string } };
    expect(JSON.stringify(out)).not.toContain("sk_REAL_SECRET");
    expect(out.digest.preview).toContain("__loomSecret");
  });
});
