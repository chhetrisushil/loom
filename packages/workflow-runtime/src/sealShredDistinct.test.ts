import type { EventEnvelope } from "@loom/core";
import {
  InMemoryAsyncEventStore,
  InMemoryTimerStore,
  KeyUnavailableError,
} from "@loom/event-runtime";
import { isPayloadShredded } from "@loom/event-runtime";
import {
  EncryptingEventStore,
  EncryptingSnapshotStore,
  InMemoryKeyStore,
  shredSubject,
} from "@loom/plugin-crypto";
import {
  InMemoryAsyncSnapshotStore,
  type Snapshot,
  type SnapshotStore,
} from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { TimerService } from "./TimerService";
import { build, echo, flow } from "./__tests__/r2Harness";
import { INBOX_WAKE_AT } from "./inbox";
import { isSealedUnreadable } from "./sealGuard";

// ADR 0130 residuals D7 review round: a REAL crypto-shred must never read as "key unavailable".

const SECRET = "123-45-6789";
const name = (e: unknown): unknown => (e as { name?: unknown } | null)?.name;

async function shreddedWithSnapshot(opts: { withEvents: boolean }) {
  const inner = new InMemoryAsyncEventStore();
  const rawSnaps = new InMemoryAsyncSnapshotStore();
  const keys = new InMemoryKeyStore();
  const events = new EncryptingEventStore(inner, keys, {
    sensitive: { STEP_COMPLETED: ["output"] },
  });
  const snaps = new EncryptingSnapshotStore(rawSnaps, keys, {
    sealState: true, // ADR 0130 D8: the kernel refuses a checkpoint that is not whole-state sealed
    ...(opts.withEvents && { events: inner }),
  });
  const timers = new InMemoryTimerStore();
  const denied: unknown[] = [];
  const h = build(
    { snapshotEvery: 1, onExecutionDenied: (...a: unknown[]) => denied.push(a) } as never,
    { eventStore: events, snapshotStore: snaps, timers }
  );
  const f = flow("shred-me", async (ctx) => {
    await ctx.run(echo, { ssn: SECRET });
    await ctx.suspend({ on: "Go" });
    return null;
  });
  h.rt.registerFlow(f.definition, f.runner);
  await (await h.rt.start(f, {}, { executionId: "x" })).waitForSuspend();
  // sequence 0 is UNSEALED; the snapshot (taken before the shred) cannot record it
  await shredSubject(keys, inner, "x", { snapshotStore: snaps });
  return { h, timers, denied };
}

describe("a real crypto-shred is never reported as a missing key", () => {
  for (const withEvents of [false, true]) {
    describe(withEvents
      ? "snapshot store given the raw log"
      : "snapshot store without `events`", () => {
      it("loadState gives the erasure error, cancel works, nothing is denied or backed off", async () => {
        const { h, timers, denied } = await shreddedWithSnapshot({ withEvents });
        const err = await h.rt.loadState("x").then(
          () => undefined,
          (e: unknown) => e
        );
        expect(name(err)).toBe("PayloadShreddedError");
        expect(isPayloadShredded(err)).toBe(true);
        expect(isSealedUnreadable(err)).toBe(false);
        expect(denied).toHaveLength(0);
        // a due timer row on the shredded stream is not backed off as a sealed refusal
        await timers.schedule({ executionId: "x", wakeAt: INBOX_WAKE_AT });
        const errors: unknown[] = [];
        let clock = 1_000_000;
        const svc = new TimerService(h.rt, timers, {
          now: () => clock,
          onError: (_i: string, e: unknown) => errors.push(e),
        });
        for (let i = 0; i < 3; i++) {
          clock += 10_000;
          await svc.tick(clock);
        }
        expect(errors.some((e) => isSealedUnreadable(e))).toBe(false);
        await expect(h.rt.cancel("x")).resolves.toBeDefined();
      });
    });
  }

  it("the kernel probe finds a PAYLOAD_SHREDDED tombstone ABOVE sequence 0 on its own", async () => {
    const raw = new InMemoryAsyncEventStore();
    const rawSnaps = new InMemoryAsyncSnapshotStore();
    const at = (sequence: number, eventType: string, payload: unknown): EventEnvelope =>
      ({
        id: `t-${sequence}`,
        executionId: "t",
        workflowId: "w",
        sequence,
        eventType,
        payload,
        timestamp: sequence,
      }) as never;
    await raw.append(at(0, "EXECUTION_STARTED", { input: {} }));
    await raw.append(at(1, "PAYLOAD_SHREDDED", { subjectId: "t" }));
    // a snapshot store that reports the key gone (it cannot prove a tombstone either way)
    const unavailable: SnapshotStore = {
      ...rawSnaps,
      save: (snap: Snapshot) => rawSnaps.save(snap),
      loadLatest: async () => {
        throw new KeyUnavailableError("t", "t");
      },
      loadAt: async () => null,
      loadLatestBefore: async () => null,
      close: async () => {},
    } as never;
    const h = build({}, { eventStore: raw, snapshotStore: unavailable });
    const err = await h.rt.loadState("t").then(
      () => undefined,
      (e: unknown) => e
    );
    expect(name(err)).toBe("PayloadShreddedError");
    expect(isPayloadShredded(err)).toBe(true);
    expect(isSealedUnreadable(err)).toBe(false);
  });
});
