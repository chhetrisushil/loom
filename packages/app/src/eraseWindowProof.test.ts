import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { InMemoryAsyncEventStore, isKeyUnavailable } from "@loom/event-runtime";
import {
  EncryptingEventStore,
  InMemoryKeyStore,
  type KeyStore,
  ShredIncompleteError,
  shredSubject,
} from "@loom/plugin-crypto";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConfig } from "./defineConfig";

// ADR 0130 D7 round 6 - defineConfig wires the erase/export destruction proof from the crypto key
// store's own `wasDestroyed`, an explicit `compliance.erase.destroyed` overrides it, a store without
// the method fails closed, and the operator asserts it per call with `force`.

const io = { inputSchema: z.any(), outputSchema: z.any() };
const def: FlowDefinition<unknown, unknown> = {
  _tag: "FlowDefinition",
  id: "done",
  name: "done",
  version: "1.0.0",
  ...io,
  steps: [],
};
const runner: FlowRunner<unknown, unknown> = async () => ({ done: true });
const flow = { definition: def, runner } as RegisteredFlow;

const NO_SNAPSHOTS = { loadLatest: async () => null };

async function boot(opts: { bare?: boolean; destroyed?: (s: string) => boolean } = {}) {
  const raw = new InMemoryAsyncEventStore();
  const real = new InMemoryKeyStore();
  // a key store that cannot prove destruction: the same store with `wasDestroyed` stripped
  const keys: KeyStore = opts.bare
    ? {
        getOrCreate: (s) => real.getOrCreate(s),
        get: (s) => real.get(s),
        destroy: (s) => real.destroy(s),
      }
    : real;
  const events = new EncryptingEventStore(raw, keys, { sensitive: {}, onShredded: "throw" });
  // the first tombstone append fails: key destroyed, no tombstone = the ShredIncomplete window
  let fail = true;
  const flaky = Object.assign(Object.create(raw) as InMemoryAsyncEventStore, {
    append: async (e: EventEnvelope) => {
      if (e.eventType === "PAYLOAD_SHREDDED" && fail) {
        fail = false;
        throw new Error("write conflict");
      }
      return raw.append(e);
    },
  });
  const app = defineConfig({
    storage: {
      kind: "custom",
      eventStore: events,
      snapshotStore: new InMemoryAsyncSnapshotStore(),
    },
    flows: [flow],
    autostart: false,
    security: {
      strict: false,
      crypto: { events },
      compliance: {
        subjectOf: (e) =>
          e.eventType === "EXECUTION_STARTED"
            ? (e.payload as { input?: { userId?: string } }).input?.userId
            : undefined,
        erase: {
          shred: (_s, ids, o) =>
            shredSubject(keys, flaky, "e1", {
              subjectId: "e1",
              executionIds: [...ids],
              snapshotStore: NO_SNAPSHOTS,
              ...(o?.force !== undefined && { force: o.force }),
            }),
          ...(opts.destroyed !== undefined && { destroyed: opts.destroyed }),
        },
      },
    },
    observability: { onWarn: () => {} },
  });
  const h = await app.runtime.start(
    flow,
    { userId: "ann" },
    { executionId: "e1", principal: { actor: "ann", tenant: "t1" } }
  );
  await h.waitForCompletion();
  const tombstones = async () =>
    (await raw.read("e1")).filter((e) => e.eventType === "PAYLOAD_SHREDDED");
  return { app, raw, tombstones };
}

describe("defineConfig wires the destruction proof from the crypto key store", () => {
  it("eraseSubject completes the genuine retry window with NO compliance.erase.destroyed", async () => {
    const w = await boot();
    await expect(w.app.eraseSubject("ann")).rejects.toBeInstanceOf(ShredIncompleteError);
    expect((await w.app.eraseSubject("ann")).outcome).toBe("erased");
    expect(await w.tombstones()).toHaveLength(1);
    await w.app.close();
  });

  it("exportSubject reads the genuine retry window with NO compliance.erase.destroyed", async () => {
    const w = await boot();
    await expect(w.app.eraseSubject("ann")).rejects.toBeInstanceOf(ShredIncompleteError);
    const out = await w.app.exportSubject("ann");
    expect(out.executions).toHaveLength(1);
    await w.app.close();
  });

  it("an explicit compliance.erase.destroyed overrides the key store's proof", async () => {
    const w = await boot({ destroyed: () => false });
    await expect(w.app.eraseSubject("ann")).rejects.toBeInstanceOf(ShredIncompleteError);
    await expect(w.app.eraseSubject("ann")).rejects.toSatisfy(isKeyUnavailable);
    await expect(w.app.exportSubject("ann")).rejects.toSatisfy(isKeyUnavailable);
    await w.app.close();
  });

  it("a key store WITHOUT wasDestroyed still refuses, then completes with the per-call force", async () => {
    const w = await boot({ bare: true });
    await expect(w.app.eraseSubject("ann")).rejects.toBeInstanceOf(ShredIncompleteError);
    await expect(w.app.eraseSubject("ann")).rejects.toSatisfy(isKeyUnavailable);
    await expect(w.app.exportSubject("ann")).rejects.toSatisfy(isKeyUnavailable);
    expect(await w.tombstones()).toHaveLength(0);
    const out = await w.app.exportSubject("ann", { force: "key-destroyed-elsewhere" });
    expect(out.executions).toHaveLength(1);
    const r = await w.app.eraseSubject("ann", undefined, { force: "key-destroyed-elsewhere" });
    expect(r.outcome).toBe("erased");
    expect(await w.tombstones()).toHaveLength(1);
    await w.app.close();
  });
});
