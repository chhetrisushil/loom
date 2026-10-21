import { EraseCoordinator, SubjectIndex } from "@loom/compliance";
import type { EventStore } from "@loom/event-runtime";
import {
  EncryptingEventStore,
  InMemoryKeyStore,
  type KeyStore,
  shredSubject,
} from "@loom/plugin-crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inboxBackends } from "./__tests__/r2Backends";
import { build, eventsOf, flow, sealedSnapshots, until } from "./__tests__/r2Harness";

// Erasure of an execution that holds a FENCE. `shredSubject` is a lifecycle writer that appends
// out of band (ERASURE_PENDING, PAYLOAD_SHREDDED); an unfenced append to a log whose fence token is
// >= 1 is refused with StaleFenceError, so the erasure could never complete. These tests run the REAL
// shredder behind the REAL EraseCoordinator (no fake shredder), and pin both halves of the repair:
// a fenced log is shredded, and a never-fenced log is NOT given a fence just to be shredded.

const PRINCIPAL_PATHS = [
  "principal.identity.tenant",
  "principal.identity.actor",
  "principal.identity.onBehalfOf",
];
// The sealed principal is what puts sealed data (and so a key) in every execution's log.
const SENSITIVE = { EXECUTION_STARTED: PRINCIPAL_PATHS };
const principal = { actor: "alice", tenant: "t1" };
const subjectOf = (e: { executionId: string }): string =>
  e.executionId.startsWith("alice-") ? "alice" : e.executionId;

// SQLite has no fencing (no `acquireFence`), so the defect cannot occur there: memory and Postgres.
for (const backend of inboxBackends("erfence").filter((b) => b.name !== "sqlite")) {
  describe.skipIf(backend.skip === true)(`erasing fenced executions on ${backend.name}`, () => {
    beforeAll(() => backend.setup());
    afterAll(() => backend.teardown());
    let seq = 0;
    const id = () => `alice-${backend.name}-${++seq}-${Math.random().toString(36).slice(2, 6)}`;

    function app() {
      const raw = backend.make();
      const keys: KeyStore = new InMemoryKeyStore();
      const store = new EncryptingEventStore(raw.eventStore, keys, {
        sensitive: SENSITIVE,
        subjectOf,
      });
      const h = build(
        { principalIdentity: "encrypted" },
        { ...raw, eventStore: store, snapshotStore: sealedSnapshots(store, raw.snapshotStore) }
      );
      const acquire = vi.spyOn(
        raw.eventStore as Required<Pick<EventStore, "acquireFence">>,
        "acquireFence"
      );
      const coordinator = async (ids: string[]) => {
        const events = (await Promise.all(ids.map((e) => raw.eventStore.read(e)))).flat();
        return new EraseCoordinator({
          index: SubjectIndex.fromEvents(events, subjectOf),
          eventStore: raw.eventStore,
          snapshotStore: h.snapshotStore,
          destroyed: (s) => keys.wasDestroyed?.(s) ?? false,
          // The documented wiring (docs/compliance.md): the REAL shredder.
          shred: async (subjectId, executionIds) => {
            await shredSubject(keys, raw.eventStore, executionIds[0] as string, {
              subjectId,
              executionIds: [...executionIds],
              snapshotStore: raw.snapshotStore,
            });
          },
          cancel: (executionId, reason) => h.rt.cancel(executionId, reason, h.rt.systemOptions()),
        });
      };
      return { raw, keys, h, acquire, coordinator };
    }

    const parksOnGate = () =>
      flow("w", async (ctx) => {
        await ctx.suspend({ on: "Go" });
        return "done";
      });
    const quick = () => flow("w", async () => "done");

    /** The log holds a fence token >= 1: a plain (unfenced) append is refused. */
    async function expectFenced(raw: ReturnType<typeof app>["raw"], e: string) {
      const tip = (await raw.eventStore.read(e)).length;
      await expect(
        raw.eventStore.append({
          id: `${e}-probe`,
          workflowId: "",
          executionId: e,
          eventType: "ERASURE_PENDING",
          sequence: tip,
          timestamp: 0,
          payload: { subjectId: "probe" },
        })
      ).rejects.toMatchObject({ name: "StaleFenceError" });
    }

    it("an execution resumed under a fence (every inbox wake and fenced resume) is shredded: erased, with a tombstone", async () => {
      const { raw, keys, h, coordinator } = app();
      const f = parksOnGate();
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e, principal })).waitForSuspend();
      const parked = await h.rt.parkedAtSequence(e, h.rt.systemOptions());
      const resumed = await h.rt.resume(
        e,
        { eventType: "Go", payload: null },
        { ...h.rt.systemOptions(), fenceIfParkedAt: parked as number }
      );
      await resumed.waitForCompletion();
      await until(
        async () => (await raw.eventStore.read(e)).at(-1)?.eventType === "EXECUTION_COMPLETED"
      );
      await expectFenced(raw, e);

      const r = await (await coordinator([e])).eraseSubject("alice");
      expect(r).toMatchObject({ outcome: "erased", erased: [e], pending: [] });
      expect(await eventsOf(raw.eventStore, e, "PAYLOAD_SHREDDED")).toHaveLength(1);
      expect(await keys.get("alice")).toBeNull();
    });

    it('a parked owner cancelled by { parked: "shred" } (Loom fences the cancel) is shredded: erased, with a tombstone', async () => {
      const { raw, keys, h, coordinator } = app();
      const f = parksOnGate();
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e, principal })).waitForSuspend();

      const r = await (await coordinator([e])).eraseSubject("alice", undefined, {
        parked: "shred",
      });
      expect(r).toMatchObject({ outcome: "erased", erased: [e], parkedShredded: [e] });
      const kinds = (await raw.eventStore.read(e)).map((x) => x.eventType);
      expect(kinds.slice(-3)).toEqual([
        "EXECUTION_CANCELLED",
        "ERASURE_PENDING",
        "PAYLOAD_SHREDDED",
      ]);
      expect(await keys.get("alice")).toBeNull();
    });

    it("a never-fenced execution is shredded WITHOUT acquiring a fence", async () => {
      const { raw, keys, h, acquire, coordinator } = app();
      const f = quick();
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e, principal })).waitForCompletion();
      acquire.mockClear();

      const r = await (await coordinator([e])).eraseSubject("alice");
      expect(r).toMatchObject({ outcome: "erased", erased: [e] });
      expect(await eventsOf(raw.eventStore, e, "PAYLOAD_SHREDDED")).toHaveLength(1);
      expect(await keys.get("alice")).toBeNull();
      expect(acquire).not.toHaveBeenCalled();
    });
  });
}
