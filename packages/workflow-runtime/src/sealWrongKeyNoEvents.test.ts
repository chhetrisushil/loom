import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import {
  EncryptingEventStore,
  EncryptingSnapshotStore,
  InMemoryKeyStore,
} from "@loom/plugin-crypto";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { build, echo, flow } from "./__tests__/r2Harness";
import { executionAccessPolicy } from "./executionAccessPolicy";

// ADR 0130 residuals D7 review round 2: a node holding a WRONG (empty) KeyStore and an
// EncryptingSnapshotStore built WITHOUT `events` must refuse a LIVE execution with the generic
// denial, never report it crypto-shredded (an existence oracle with no audit).

const STRANGER = { actor: "mallory", tenant: "t9" };
const FULL = { STEP_COMPLETED: ["output"] };

const secret = () =>
  flow("secret", async (ctx) => {
    await ctx.run(echo, { ssn: "123-45-6789" });
    await ctx.suspend({ on: "Go" });
    return null;
  });

const rejection = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e
  );
const shape = (e: unknown) => {
  const err = e as Error & { op?: unknown; reason?: unknown; executionId?: unknown };
  return {
    name: err.name,
    message: err.message,
    keys: Object.keys(err).sort(),
    json: JSON.stringify(err),
    op: err.op,
    reason: err.reason,
  };
};

function strict(stores: ConstructorParameters<typeof Object>[0] & object) {
  const denied: unknown[] = [];
  const f = secret();
  const h = build(
    {
      executionAuthorizer: executionAccessPolicy({ rules: { discard: "tenant" } }),
      executionAuthz: { requirePrincipal: true },
      onExecutionDenied: (r: { op: string }, reason?: string) => denied.push([r.op, reason]),
    },
    stores as never
  );
  h.rt.registerFlow(f.definition, f.runner);
  return { h, denied };
}

describe("a wrong-key node without `events` on the snapshot store", () => {
  it("loadState / cancel / resume give the generic denial, never PayloadShreddedError", async () => {
    const E = "x";
    // the baseline: an ordinary plaintext id with an unknown owner, on a strict node
    const plainInner = new InMemoryAsyncEventStore();
    const f0 = secret();
    const setup = build({ snapshotEvery: 1 } as never, {
      eventStore: plainInner,
      snapshotStore: new InMemoryAsyncSnapshotStore(),
    });
    setup.rt.registerFlow(f0.definition, f0.runner);
    await (await setup.rt.start(f0, {}, { executionId: E })).waitForSuspend();
    const base = strict({
      eventStore: plainInner,
      snapshotStore: new InMemoryAsyncSnapshotStore(),
    });

    // node A: real keys, a snapshot after every event
    const inner = new InMemoryAsyncEventStore();
    const rawSnaps = new InMemoryAsyncSnapshotStore();
    const keys = new InMemoryKeyStore();
    const a = build({ snapshotEvery: 1 } as never, {
      eventStore: new EncryptingEventStore(inner, keys, { sensitive: FULL }),
      snapshotStore: new EncryptingSnapshotStore(rawSnaps, keys, { sensitive: ["variables"] }),
      timers: new InMemoryTimerStore(),
    });
    const fa = secret();
    a.rt.registerFlow(fa.definition, fa.runner);
    await (await a.rt.start(fa, {}, { executionId: E })).waitForSuspend();
    const before = JSON.stringify(await inner.read(E));

    // node B: an EMPTY KeyStore over the same stores, NO `events`
    const wrong = new InMemoryKeyStore();
    const b = strict({
      eventStore: new EncryptingEventStore(inner, wrong, { sensitive: FULL }),
      snapshotStore: new EncryptingSnapshotStore(rawSnaps, wrong, { sensitive: ["variables"] }),
      timers: new InMemoryTimerStore(),
    });

    const calls: Array<[string, (n: typeof b) => Promise<unknown>]> = [
      ["loadState", (n) => n.h.rt.loadState(E, { principal: STRANGER })],
      ["cancel", (n) => n.h.rt.cancel(E, "no", { principal: STRANGER })],
      [
        "resume",
        (n) => n.h.rt.resume(E, { eventType: "Go", payload: null }, { principal: STRANGER }),
      ],
    ];
    for (const [name, call] of calls) {
      base.denied.length = 0;
      b.denied.length = 0;
      const want = await rejection(call(base));
      const got = await rejection(call(b));
      expect(want, `${name}: baseline refuses`).toBeInstanceOf(Error);
      expect((got as Error | undefined)?.name, name).not.toBe("PayloadShreddedError");
      expect(got, name).toBeInstanceOf(Error);
      expect(shape(got), name).toEqual(shape(want));
      expect(b.denied, name).toEqual(base.denied);
    }
    expect(JSON.stringify(await inner.read(E))).toBe(before); // nothing appended
    expect((await a.rt.loadState(E))?.status).toBe("suspended"); // A's execution is untouched
  });
});
