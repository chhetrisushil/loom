import { unwrapTainted } from "@loom/classify";
import type { FlowDefinition } from "@loom/core";
import { type EventStore, InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { ReservedStreamArchiveRequiredError } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineConfig as defineConfigBase,
  type defineConfig as defineConfigRaw,
} from "./defineConfig";
import { withPrincipalCodec } from "./principalTestSupport";

// a composed compliance plugin requires crypto or a principalCodec (ADR 0111 D1)
const defineConfig: typeof defineConfigRaw = (config) =>
  defineConfigBase(withPrincipalCodec(config));

// ADR 0139 (#728) through defineConfig: the compaction archive is also where the inbox's reserved streams
// MOVE what a trim or a retired chain removes; exportSubject returns it; a custom durable storage with no
// archive trims nothing and says so.

const io = { inputSchema: z.any(), outputSchema: z.any() };
const definition: FlowDefinition<unknown, unknown> = {
  _tag: "FlowDefinition",
  id: "inbox-archive",
  name: "inbox-archive",
  version: "1.0.0",
  ...io,
  steps: [],
};
const runner: FlowRunner<unknown, unknown> = async (ctx) => {
  for (let i = 0; i < 4; i++) unwrapTainted(await ctx.receive("a"));
  await ctx.suspend({ on: "hold" });
  return "done";
};

const until = async (pred: () => Promise<boolean>, ms = 8000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("defineConfig - the inbox archive (ADR 0139)", () => {
  it("memory storage: a trim and the retired chain's streams MOVE into the archive; exportSubject returns them", async () => {
    const app = defineConfig({
      storage: { kind: "memory" },
      autostart: false,
      kernel: { features: { inbox: true } },
      security: {
        compliance: {
          subjectOf: (e) =>
            e.eventType === "EXECUTION_STARTED"
              ? (e.payload as { input?: { who?: string } } | null)?.input?.who
              : undefined,
        },
      },
    });
    app.runtime.registerFlow(definition, runner);
    const h = await app.runtime.start(
      { definition, runner },
      { who: "acme" },
      { executionId: "ib1" }
    );
    await h.waitForSuspend();
    for (let i = 0; i < 6; i++) {
      await app.runtime.send("ib1", {
        topic: "a",
        payload: `p${i}`,
        messageId: `m${i}`,
        sender: { actor: "alice", tenant: "t1" },
      } as never);
    }
    const stream = "__loom_inbox__:ib1";
    // the trim is background work after the park: wait for its archive segment
    await until(async () => ((await app.stores.archiveStore?.headers(stream)) ?? []).length > 0);
    await until(async () => (await app.runtime.loadState("ib1"))?.suspendedOn?.on === "hold");
    const h2 = (await app.stores.archiveStore?.headers(stream)) ?? [];
    expect(h2[0]?.from).toBe(0);

    await app.runtime.resume("ib1", { eventType: "hold", payload: null });
    await until(async () => (await app.runtime.loadState("ib1"))?.status === "completed");
    await until(async () => (await app.stores.eventStore.read(stream)).length === 0);

    const out = await app.exportSubject("acme");
    const reserved = out.executions[0]?.reservedStreams ?? [];
    expect(reserved.map((r) => r.streamId)).toEqual([stream]);
    // all six envelopes (ids, timestamps, senders) are recoverable from the export
    expect(reserved[0]?.events.map((e) => e.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(reserved[0]?.events[2]).toMatchObject({
      id: `${stream}-2`,
      payload: { messageId: "m2", topic: "a", sender: expect.anything() },
    });
    expect(reserved[0]?.unarchived).toEqual([]);
    await app.close();
  });

  it("a custom DURABLE storage with no archive: nothing is trimmed, the refusal is reported, the stream is intact", async () => {
    const errors: unknown[] = [];
    // not an InMemoryAsyncEventStore as far as the composition root can tell: a durable store
    const inner = new InMemoryAsyncEventStore();
    const delegate: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(InMemoryAsyncEventStore.prototype)) {
      if (key !== "constructor") {
        delegate[key] = (...a: unknown[]) =>
          (inner as unknown as Record<string, (...x: unknown[]) => unknown>)[key]!(...a);
      }
    }
    const eventStore = delegate as unknown as EventStore;
    const app = defineConfig({
      storage: { kind: "custom", eventStore, snapshotStore: new InMemoryAsyncSnapshotStore() },
      autostart: false,
      kernel: { features: { inbox: true } },
      observability: { onWarn: () => undefined, onStorageError: (_id, e) => errors.push(e) },
    });
    app.runtime.registerFlow(definition, runner);
    const h = await app.runtime.start({ definition, runner }, {}, { executionId: "ib2" });
    await h.waitForSuspend();
    for (let i = 0; i < 6; i++) {
      await app.runtime.send("ib2", { topic: "a", payload: i, messageId: `m${i}` });
    }
    await until(async () => errors.some((e) => e instanceof ReservedStreamArchiveRequiredError));
    await until(async () => (await app.runtime.loadState("ib2"))?.suspendedOn?.on === "hold");
    expect((await eventStore.read("__loom_inbox__:ib2")).map((e) => e.sequence)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    // sanity: the in-memory control (an in-memory custom event store DOES get an archive)
    const mem = defineConfig({
      storage: {
        kind: "custom",
        eventStore: new InMemoryAsyncEventStore(),
        snapshotStore: new InMemoryAsyncSnapshotStore(),
      },
      autostart: false,
      kernel: { features: { inbox: true } },
    });
    expect(mem.stores.archiveStore).toBeDefined();
    await mem.close();
    await app.close();
  });
});
