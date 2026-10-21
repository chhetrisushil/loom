import { EraseCoordinator, SubjectIndex } from "@loom/compliance";
import type { EventStore } from "@loom/event-runtime";
import {
  EncryptingEventStore,
  EncryptingSnapshotStore,
  InMemoryKeyStore,
  type KeyStore,
  ShredIncompleteError,
  shredSubject,
} from "@loom/plugin-crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inboxBackends } from "./__tests__/r2Backends";
import { Latch, build, eventsOf, flow, slow, until } from "./__tests__/r2Harness";

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

    function app(latch?: Latch) {
      const raw = backend.make();
      const keys: KeyStore = new InMemoryKeyStore();
      const store = new EncryptingEventStore(raw.eventStore, keys, {
        sensitive: SENSITIVE,
        subjectOf,
      });
      const h = build(
        { principalIdentity: "encrypted" },
        {
          ...raw,
          eventStore: store,
          snapshotStore: new EncryptingSnapshotStore(raw.snapshotStore, keys, {
            sealState: true,
            subjectOf,
          }),
          ...(latch !== undefined && { latch }),
        }
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
      /** A direct caller of the shredder (docs: plugins/crypto/README.md), no coordinator. */
      const shredDirect = (ids: string[], eventStore: EventStore = raw.eventStore) =>
        shredSubject(keys, eventStore, ids[0] as string, {
          subjectId: "alice",
          executionIds: ids,
          snapshotStore: raw.snapshotStore,
        });
      return { raw, keys, h, acquire, coordinator, shredDirect };
    }

    const parksOnGate = () =>
      flow("w", async (ctx) => {
        await ctx.suspend({ on: "Go" });
        return "done";
      });
    const parksThenRuns = () =>
      flow("w", async (ctx) => {
        await ctx.suspend({ on: "Go" });
        await ctx.run(slow, {});
        return "done";
      });
    /** Resume a parked execution under a fence (the token becomes >= 1). */
    const fencedResume = async (h: ReturnType<typeof app>["h"], e: string) =>
      h.rt.resume(
        e,
        { eventType: "Go", payload: null },
        {
          ...h.rt.systemOptions(),
          fenceIfParkedAt: (await h.rt.parkedAtSequence(e, h.rt.systemOptions())) as number,
        }
      );
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

    it("an execution resumed under a fence (a fenced resume or inbox wake) is shredded: erased, with a tombstone", async () => {
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

    /** Append one event to a fenced log under its CURRENT token (an audit row, a re-open, ...). */
    async function appendFenced(
      raw: ReturnType<typeof app>["raw"],
      e: string,
      eventType: string,
      payload: unknown = null
    ) {
      const seen = await raw.eventStore.appendIfUnchanged?.(e, null);
      if (seen === undefined || seen.appended || seen.head === null) throw new Error("no head");
      await raw.eventStore.append({
        id: `${e}-x-${seen.head + 1}`,
        workflowId: "",
        executionId: e,
        eventType,
        sequence: seen.head + 1,
        timestamp: 1,
        payload,
        metadata: { fence: seen.fence },
      } as never);
    }
    /** Park, fenced resume, complete: a TERMINAL execution whose fence token is >= 1. */
    async function completedFenced(ctx: ReturnType<typeof app>, e: string) {
      const f = parksOnGate();
      ctx.h.rt.registerFlow(f.definition, f.runner);
      await (await ctx.h.rt.start(f, {}, { executionId: e, principal })).waitForSuspend();
      await (await fencedResume(ctx.h, e)).waitForCompletion();
      await until(
        async () => (await ctx.raw.eventStore.read(e)).at(-1)?.eventType === "EXECUTION_COMPLETED"
      );
      await expectFenced(ctx.raw, e);
    }
    /** A sealed (sealState) snapshot covering the log's whole tip, as checkpoint-on-settle writes. */
    async function snapshotAtTip(ctx: ReturnType<typeof app>, e: string) {
      const state = await ctx.h.rt.loadState(e, ctx.h.rt.systemOptions());
      const events = await ctx.raw.eventStore.read(e);
      await ctx.h.snapshotStore.save({
        id: `${e}-snap`,
        executionId: e,
        workflowId: events[0]?.workflowId ?? "",
        sequence: events.at(-1)?.sequence ?? 0,
        state: state as never,
        createdAt: 1,
      });
      // the snapshot at rest really is a ciphertext envelope
      expect(JSON.stringify(await ctx.raw.snapshotStore.loadLatest(e))).toContain("__loomEnc");
    }

    it("a terminal execution COVERED BY A SEALED SNAPSHOT (empty tail) is shredded by the coordinator", async () => {
      const ctx = app();
      const e = id();
      await completedFenced(ctx, e);
      await snapshotAtTip(ctx, e);
      const r = await (await ctx.coordinator([e])).eraseSubject("alice");
      expect(r).toMatchObject({ outcome: "erased", erased: [e] });
      expect(await eventsOf(ctx.raw.eventStore, e, "PAYLOAD_SHREDDED")).toHaveLength(1);
      expect(await ctx.keys.get("alice")).toBeNull();
    });

    it("a terminal execution covered by a sealed snapshot WITH AN AUDIT EVENT after it is shredded (direct call, raw snapshot store)", async () => {
      const ctx = app();
      const e = id();
      await completedFenced(ctx, e);
      await snapshotAtTip(ctx, e);
      await appendFenced(ctx.raw, e, "EXECUTION_DENIED", { reason: "late" });
      await ctx.shredDirect([e]);
      expect(await eventsOf(ctx.raw.eventStore, e, "PAYLOAD_SHREDDED")).toHaveLength(1);
      expect(await ctx.keys.get("alice")).toBeNull();
    });

    it("the same, through the coordinator (encrypting snapshot store)", async () => {
      const ctx = app();
      const e = id();
      await completedFenced(ctx, e);
      await snapshotAtTip(ctx, e);
      await appendFenced(ctx.raw, e, "EXECUTION_DENIED", { reason: "late" });
      const r = await (await ctx.coordinator([e])).eraseSubject("alice");
      expect(r).toMatchObject({ outcome: "erased", erased: [e] });
      expect(await eventsOf(ctx.raw.eventStore, e, "PAYLOAD_SHREDDED")).toHaveLength(1);
    });

    it("GUARD: a terminal followed by a re-open (EXECUTION_RESUMED) reads as LIVE: refuses, key intact", async () => {
      const ctx = app();
      const e = id();
      await completedFenced(ctx, e);
      await appendFenced(ctx.raw, e, "EXECUTION_RESUMED", null);
      await expect(ctx.shredDirect([e])).rejects.toMatchObject({ name: "StaleFenceError" });
      expect(await ctx.keys.get("alice")).not.toBeNull();
      expect(await eventsOf(ctx.raw.eventStore, e, "ERASURE_PENDING")).toHaveLength(0);
    });

    it("GUARD: a resume landing between the classification and the escalation fails the compare-and-set: refuses, key intact", async () => {
      const ctx = app();
      const e = id();
      await completedFenced(ctx, e);
      let injected = false;
      const racing = new Proxy(ctx.raw.eventStore, {
        get(target, prop) {
          const v = Reflect.get(target, prop, target);
          if (prop !== "appendIfUnchanged") return typeof v === "function" ? v.bind(target) : v;
          return async (...args: unknown[]) => {
            if (!injected) {
              injected = true;
              await appendFenced(ctx.raw, e, "EXECUTION_RESUMED", null);
            }
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
      await expect(ctx.shredDirect([e], racing)).rejects.toMatchObject({
        name: "StaleFenceError",
      });
      expect(injected).toBe(true);
      expect(await ctx.keys.get("alice")).not.toBeNull();
      expect(await eventsOf(ctx.raw.eventStore, e, "ERASURE_PENDING")).toHaveLength(0);
    });

    it("GUARD: a direct shredSubject on a LIVE fenced execution refuses (StaleFenceError) before the key is destroyed", async () => {
      const latch = new Latch();
      const { raw, keys, h, shredDirect } = app(latch);
      const f = parksThenRuns();
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e, principal })).waitForSuspend();
      const resumed = await fencedResume(h, e);
      try {
        await latch.entered;
        await until(async () => (await eventsOf(raw.eventStore, e, "STEP_STARTED")).length > 0);
        await expectFenced(raw, e);
        const keyBefore = await keys.get("alice");
        expect(keyBefore).not.toBeNull();

        await expect(shredDirect([e])).rejects.toMatchObject({ name: "StaleFenceError" });
        // Nothing irreversible happened and nobody was superseded.
        expect(await keys.get("alice")).not.toBeNull();
        expect(await eventsOf(raw.eventStore, e, "ERASURE_PENDING")).toHaveLength(0);
        expect(await eventsOf(raw.eventStore, e, "PAYLOAD_SHREDDED")).toHaveLength(0);
      } finally {
        latch.release();
      }
      await resumed.waitForCompletion(); // the live holder was never fenced out
      expect((await h.rt.loadState(e, h.rt.systemOptions()))?.status).toBe("completed");
    });

    it("a ShredIncompleteError retry completes a FENCED log (key already gone)", async () => {
      const { raw, keys, h, shredDirect } = app();
      const f = parksOnGate();
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e, principal })).waitForSuspend();
      await (await fencedResume(h, e)).waitForCompletion();
      await until(
        async () => (await raw.eventStore.read(e)).at(-1)?.eventType === "EXECUTION_COMPLETED"
      );
      await expectFenced(raw, e);

      // The first tombstone append is lost (a transient failure); the intent and the destroy landed.
      let dropped = false;
      const flaky = new Proxy(raw.eventStore, {
        get(target, prop) {
          const v = Reflect.get(target, prop, target);
          if (prop !== "append") return typeof v === "function" ? v.bind(target) : v;
          return async (ev: { eventType: string }) => {
            if (ev.eventType === "PAYLOAD_SHREDDED" && !dropped) {
              dropped = true;
              throw new Error("transient");
            }
            return target.append(ev as never);
          };
        },
      });
      await expect(shredDirect([e], flaky)).rejects.toBeInstanceOf(ShredIncompleteError);
      expect(await keys.get("alice")).toBeNull();
      expect(await eventsOf(raw.eventStore, e, "PAYLOAD_SHREDDED")).toHaveLength(0);

      await shredDirect([e]); // the documented retry, same arguments
      expect(await eventsOf(raw.eventStore, e, "PAYLOAD_SHREDDED")).toHaveLength(1);
      expect(await eventsOf(raw.eventStore, e, "ERASURE_PENDING")).toHaveLength(1);
    });

    it("the defer path (handleEvent) completes a parked erasure once a fenced execution terminates", async () => {
      const { raw, keys, h, coordinator } = app();
      const f = parksOnGate();
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e, principal })).waitForSuspend();
      const coord = await coordinator([e]);
      expect(await coord.eraseSubject("alice")).toMatchObject({ outcome: "parked", pending: [e] });
      expect(await keys.get("alice")).not.toBeNull();

      await (await fencedResume(h, e)).waitForCompletion();
      await until(
        async () => (await raw.eventStore.read(e)).at(-1)?.eventType === "EXECUTION_COMPLETED"
      );
      await expectFenced(raw, e);
      const done = (await eventsOf(raw.eventStore, e, "EXECUTION_COMPLETED"))[0] as never;
      await coord.handleEvent(done);

      expect(await eventsOf(raw.eventStore, e, "PAYLOAD_SHREDDED")).toHaveLength(1);
      expect(await keys.get("alice")).toBeNull();
      expect(coord.pendingSubjects()).toEqual([]);
    });
  });
}
