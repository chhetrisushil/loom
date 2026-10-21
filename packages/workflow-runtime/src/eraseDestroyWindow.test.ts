import { EraseCoordinator, SubjectIndex } from "@loom/compliance";
import type { EventEnvelope, ExecutionState } from "@loom/core";
import { type EventStore, INBOX_STREAM_PREFIX, isKeyUnavailable } from "@loom/event-runtime";
import {
  EncryptingSnapshotStore,
  InMemoryKeyStore,
  ShredIncompleteError,
  shredSubject,
} from "@loom/plugin-crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inboxBackends } from "./__tests__/r2Backends";

// The erasure retry window with a SEALED snapshot (`sealState: true`): the key is destroyed (the
// ERASURE_PENDING intent is in the log) but the PAYLOAD_SHREDDED tombstones are not written (a
// crash, a write conflict). The coordinator must read the checkpoint through the erased-tolerant
// path or the erasure can never finish; and what it infers from an unreadable checkpoint must
// not purge a live successor's inbox, nor treat a parked owner as finished.

let seq = 0;
const uid = (): string => `${++seq}-${Math.random().toString(36).slice(2, 6)}`;

const ev = (x: string, sequence: number, eventType: string, payload: unknown): EventEnvelope => ({
  id: `${x}-${sequence}`,
  workflowId: "wf",
  executionId: x,
  eventType,
  sequence,
  timestamp: 1000 + sequence,
  payload,
  // lifecycle facts are kernel-stamped, as the runtime writes them (the fold ignores unstamped ones)
  ...(eventType.startsWith("EXECUTION_") && { metadata: { kernel: true } }),
});
const st = (x: string, status: string, sequence: number) =>
  ({
    executionId: x,
    workflowId: "wf",
    workflowVersion: "1.0.0",
    status,
    frames: {},
    variables: { _input: { ssn: "123-45-6789" } },
    sequence,
    startedAt: 0,
    updatedAt: 0,
  }) as unknown as ExecutionState;
const started = (x: string, user: string, extra: object = {}) =>
  ev(x, 0, "EXECUTION_STARTED", { ...extra, input: { userId: user } });
const userOf = (e: EventEnvelope): string | undefined =>
  e.eventType === "EXECUTION_STARTED"
    ? (e.payload as { input?: { userId?: string } }).input?.userId
    : undefined;

for (const backend of inboxBackends("erwin").filter((b) => b.name !== "sqlite")) {
  describe.skipIf(backend.skip === true)(
    `erasure in the destroy window with a sealed snapshot on ${backend.name}`,
    () => {
      beforeAll(() => backend.setup(), 60_000);
      afterAll(() => backend.teardown(), 60_000);

      /** A world whose first PAYLOAD_SHREDDED append fails (when `crash`): the destroy window. */
      function world(opts: { seal?: "state" | "paths"; subjects: Record<string, string> }) {
        const raw = backend.make();
        const events = raw.eventStore as EventStore & {
          deleteExecution(id: string): Promise<void>;
          truncatePrefix(id: string, through: number): Promise<void>;
        };
        const keys = new InMemoryKeyStore();
        const subjectOf = (s: { executionId: string }): string =>
          opts.subjects[s.executionId] ?? s.executionId;
        const sealed = new EncryptingSnapshotStore(
          raw.snapshotStore,
          keys,
          opts.seal === "paths"
            ? { sensitive: ["variables._input"], subjectOf }
            : { sealState: true, subjectOf }
        );
        let fail = true;
        const flaky = Object.assign(Object.create(events) as typeof events, {
          append: async (e: EventEnvelope) => {
            if (e.eventType === "PAYLOAD_SHREDDED" && fail) {
              fail = false;
              throw new Error("write conflict");
            }
            return events.append(e);
          },
        });
        const coordinator = async () => {
          const ids = Object.keys(opts.subjects);
          const all: EventEnvelope[] = [];
          for (const id of ids) all.push(...(await events.read(id)));
          const index = SubjectIndex.fromEvents(all, userOf);
          return new EraseCoordinator({
            index,
            eventStore: events,
            snapshotStore: sealed,
            destroyed: (s) => keys.wasDestroyed(s),
            shred: (s, ids2) =>
              shredSubject(keys, flaky, ids2[0] as string, {
                subjectId: s,
                executionIds: [...ids2],
                snapshotStore: sealed,
              }),
          });
        };
        const tombstones = async (x: string) =>
          (await events.read(x)).filter((e) => e.eventType === "PAYLOAD_SHREDDED");
        const save = (x: string, status: string, sequence: number) =>
          sealed.save({
            id: `s-${x}-${sequence}`,
            executionId: x,
            workflowId: "wf",
            sequence,
            state: st(x, status, sequence),
            createdAt: 0,
          });
        return { events, keys, sealed, coordinator, tombstones, save };
      }

      it("a terminal execution: the retry completes, shreds once, purges its inbox; a third call stays idempotent", async () => {
        const x = `e-${uid()}`;
        const w = world({ subjects: { [x]: "ann" } });
        await w.events.append(started(x, "ann"));
        await w.events.append(ev(x, 1, "EXECUTION_COMPLETED", {}));
        await w.save(x, "completed", 1);
        const inbox = `${INBOX_STREAM_PREFIX}${x}`;
        await w.events.append({ ...ev(inbox, 0, "MESSAGE_SENT", { n: 1 }), id: `m-${x}` });
        const coord = await w.coordinator();
        await expect(coord.eraseSubject("ann")).rejects.toBeInstanceOf(ShredIncompleteError);
        expect(await w.keys.get("ann")).toBeNull(); // the window: key gone ...
        expect(await w.tombstones(x)).toHaveLength(0); // ... no tombstone
        expect((await w.events.read(inbox)).length).toBe(1);
        const retry = await coord.eraseSubject("ann");
        expect(retry.outcome).toBe("erased");
        expect(retry.erased).toEqual([x]);
        expect(await w.tombstones(x)).toHaveLength(1);
        expect(await w.events.read(inbox)).toEqual([]);
        expect(coord.pendingSubjects()).toEqual([]);
        // the checkpoint now reads as shredded: the proven-shred branch of an opaque checkpoint
        expect((await coord.eraseSubject("ann")).outcome).toBe("erased");
        expect(await w.tombstones(x)).toHaveLength(1);
      });

      it("a parked request resumed by handleEvent after the crash completes and unparks", async () => {
        const x = `e-${uid()}`;
        const w = world({ subjects: { [x]: "ann" } });
        await w.events.append(started(x, "ann"));
        await w.save(x, "running", 0);
        const coord = await w.coordinator();
        expect((await coord.eraseSubject("ann")).outcome).toBe("parked");
        expect(coord.pendingSubjects()).toEqual(["ann"]);
        const done = ev(x, 1, "EXECUTION_COMPLETED", {});
        await w.events.append(done);
        await expect(coord.handleEvent(done)).rejects.toBeInstanceOf(ShredIncompleteError);
        expect(coord.pendingSubjects()).toEqual(["ann"]);
        await coord.handleEvent(done);
        expect(await w.tombstones(x)).toHaveLength(1);
        expect(coord.pendingSubjects()).toEqual([]);
        const pending = (await w.events.read("__loom_erasure__")).filter(
          (e) => e.eventType === "ERASURE_PENDING"
        );
        expect(pending).toHaveLength(1);
      });

      it("a restart (fresh coordinator + loadParked) after the crash finishes via eraseSubject", async () => {
        const x = `e-${uid()}`;
        const w = world({ subjects: { [x]: "ann" } });
        await w.events.append(started(x, "ann"));
        await w.save(x, "running", 0);
        const first = await w.coordinator();
        expect((await first.eraseSubject("ann")).outcome).toBe("parked");
        const done = ev(x, 1, "EXECUTION_COMPLETED", {});
        await w.events.append(done);
        await expect(first.handleEvent(done)).rejects.toBeInstanceOf(ShredIncompleteError);
        const restarted = await w.coordinator(); // a new process
        await restarted.loadParked();
        expect(restarted.pendingSubjects()).toEqual(["ann"]);
        expect((await restarted.eraseSubject("ann")).outcome).toBe("erased");
        expect(restarted.pendingSubjects()).toEqual([]);
        expect(await w.tombstones(x)).toHaveLength(1);
      });

      it("a continued predecessor in the window keeps its live successor's inbox", async () => {
        const a = `e-${uid()}`;
        const b = `e-${uid()}`;
        const w = world({ subjects: { [a]: "ann", [b]: "bob" } });
        await w.events.append(started(a, "ann"));
        await w.events.append(ev(a, 1, "EXECUTION_CONTINUED", { successorId: b }));
        await w.save(a, "continued", 1);
        await w.events.append(started(b, "bob", { chainId: a, generation: 1 }));
        const inbox = `${INBOX_STREAM_PREFIX}${a}`;
        await w.events.append({ ...ev(inbox, 0, "MESSAGE_SENT", { n: 1 }), id: `m-${a}` });
        const coord = await w.coordinator();
        await expect(coord.eraseSubject("ann")).rejects.toBeInstanceOf(ShredIncompleteError);
        expect((await coord.eraseSubject("ann")).outcome).toBe("erased");
        expect((await w.events.read(inbox)).length).toBe(1); // the live successor's mail survives
      });

      it("a compacted log, checkpoint at the tip: erases, and never claims a chain head it cannot prove", async () => {
        const x = `e-${uid()}`;
        const w = world({ subjects: { [x]: "ann" } });
        await w.events.append(started(x, "ann"));
        await w.events.append(ev(x, 1, "STEP_STARTED", { stepId: "a", stepType: "t", input: {} }));
        await w.events.append(ev(x, 2, "EXECUTION_COMPLETED", {}));
        await w.save(x, "completed", 2);
        await w.events.truncatePrefix(x, 2); // only sequence 0 is left
        const inbox = `${INBOX_STREAM_PREFIX}${x}`;
        await w.events.append({ ...ev(inbox, 0, "MESSAGE_SENT", { n: 1 }), id: `m-${x}` });
        const coord = await w.coordinator();
        await expect(coord.eraseSubject("ann")).rejects.toBeInstanceOf(ShredIncompleteError);
        expect((await coord.eraseSubject("ann")).outcome).toBe("erased");
        expect(await w.tombstones(x)).toHaveLength(1);
        expect((await w.events.read(inbox)).length).toBe(1); // head unproven: stream kept (sealed)
      });

      it("a compacted log whose tail shows the terminal: head proven, inbox purged", async () => {
        const x = `e-${uid()}`;
        const w = world({ subjects: { [x]: "ann" } });
        await w.events.append(started(x, "ann"));
        await w.events.append(ev(x, 1, "STEP_STARTED", { stepId: "a", stepType: "t", input: {} }));
        await w.save(x, "running", 1);
        await w.events.truncatePrefix(x, 1);
        await w.events.append(ev(x, 2, "EXECUTION_COMPLETED", {}));
        const inbox = `${INBOX_STREAM_PREFIX}${x}`;
        await w.events.append({ ...ev(inbox, 0, "MESSAGE_SENT", { n: 1 }), id: `m-${x}` });
        const coord = await w.coordinator();
        await expect(coord.eraseSubject("ann")).rejects.toBeInstanceOf(ShredIncompleteError);
        expect((await coord.eraseSubject("ann")).outcome).toBe("erased");
        expect(await w.events.read(inbox)).toEqual([]);
      });

      for (const seal of ["state", "paths"] as const) {
        it(`a suspended owner in the window stays parked (seal=${seal}), as with path sealing`, async () => {
          const x = `e-${uid()}`;
          const w = world({ seal, subjects: { [x]: "ann" } });
          await w.events.append(started(x, "ann"));
          await w.events.append(ev(x, 1, "EXECUTION_SUSPENDED", { suspendedOn: { type: "wait" } }));
          await w.save(x, "suspended", 1);
          const coord = await w.coordinator();
          // a direct shred of a parked owner is allowed (quiescent) and its tombstone fails
          await expect(
            shredSubject(
              w.keys,
              Object.assign(Object.create(w.events), {
                append: async (e: EventEnvelope) => {
                  if (e.eventType === "PAYLOAD_SHREDDED") throw new Error("x");
                  return w.events.append(e);
                },
              }) as typeof w.events,
              x,
              { subjectId: "ann", executionIds: [x], snapshotStore: w.sealed }
            )
          ).rejects.toBeInstanceOf(ShredIncompleteError);
          const r = await coord.eraseSubject("ann");
          expect(r.outcome).toBe("parked");
          expect(r.pending).toEqual([x]);
        });
      }

      it("a late re-open after the intent does not read as terminal", async () => {
        const x = `e-${uid()}`;
        const w = world({ subjects: { [x]: "ann" } });
        await w.events.append(started(x, "ann"));
        await w.events.append(ev(x, 1, "EXECUTION_COMPLETED", {}));
        await w.save(x, "completed", 1);
        const coord = await w.coordinator();
        await expect(coord.eraseSubject("ann")).rejects.toBeInstanceOf(ShredIncompleteError);
        const head = (await w.events.read(x)).length;
        await w.events.append(ev(x, head, "EXECUTION_RESUMED", {}));
        const r = await coord.eraseSubject("ann");
        expect(r.outcome).toBe("parked");
        expect(await w.tombstones(x)).toHaveLength(0);
      });

      it("an unavailable key that is not proved destroyed still throws; no intent still throws", async () => {
        const x = `e-${uid()}`;
        const w = world({ subjects: { [x]: "ann" } });
        await w.events.append(started(x, "ann"));
        await w.events.append(ev(x, 1, "EXECUTION_COMPLETED", {}));
        await w.save(x, "completed", 1);
        await w.keys.destroy("ann"); // key lost, but no erase was ever recorded
        const coord = await w.coordinator();
        const err = await coord.eraseSubject("ann").then(
          () => undefined,
          (e: unknown) => e
        );
        expect(isKeyUnavailable(err)).toBe(true);
        expect(await w.tombstones(x)).toHaveLength(0);
        const intents = (await w.events.read(x)).filter((e) => e.eventType === "ERASURE_PENDING");
        expect(intents).toHaveLength(0);

        // intent present (a crashed erasure) but the destruction is not proved: still refused
        const y = `e-${uid()}`;
        const v = world({ subjects: { [y]: "bea" } });
        await v.events.append(started(y, "bea"));
        await v.events.append(ev(y, 1, "EXECUTION_COMPLETED", {}));
        await v.save(y, "completed", 1);
        await expect((await v.coordinator()).eraseSubject("bea")).rejects.toBeInstanceOf(
          ShredIncompleteError
        );
        const noProof = new EraseCoordinator({
          index: SubjectIndex.fromEvents(await v.events.read(y), userOf),
          eventStore: v.events,
          shred: async () => {},
          snapshotStore: v.sealed,
          destroyed: () => false,
        });
        await expect(noProof.eraseSubject("bea")).rejects.toSatisfy(isKeyUnavailable);
      });
    }
  );
}
