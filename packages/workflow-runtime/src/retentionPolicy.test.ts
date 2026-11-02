import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, expectTypeOf, it } from "vitest";
import { LogLifecycle, type RetentionVerdict } from "./LogLifecycle";
import { RetentionPolicyError, assertRetentionPolicy, retentionPolicy } from "./retentionPolicy";

// ADR 0145 - the app-owned retention policy value and its re-validation at every consumer.

const DAY = 86_400_000;

describe("retentionPolicy / assertRetentionPolicy", () => {
  it("accepts the minimal and the full shapes, including terminalTtlMs 0", () => {
    expect(retentionPolicy({ terminalTtlMs: 0 })).toEqual({ terminalTtlMs: 0 });
    expect(
      retentionPolicy({
        terminalTtlMs: 30 * DAY,
        snapshots: { keepLatest: 1 },
        content: { unpinnedAfterMs: 30 * DAY }, // equal is allowed
      })
    ).toEqual({
      terminalTtlMs: 30 * DAY,
      snapshots: { keepLatest: 1 },
      content: { unpinnedAfterMs: 30 * DAY },
    });
  });

  it("returns a deeply frozen value and does not mutate or alias the input", () => {
    const spec = {
      terminalTtlMs: 1,
      snapshots: { keepLatest: 2 },
      content: { unpinnedAfterMs: 5 },
    };
    const p = retentionPolicy(spec);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.snapshots)).toBe(true);
    expect(Object.isFrozen(p.content)).toBe(true);
    expect(Object.isFrozen(spec)).toBe(false);
    expect(p.snapshots).not.toBe(spec.snapshots);
  });

  it("reads each field exactly once: a getter that changes its answer cannot pass a rule-breaking value", () => {
    let ttlReads = 0;
    let contentReads = 0;
    const spec = {
      get terminalTtlMs() {
        ttlReads++;
        return ttlReads === 1 ? 5 : 500;
      },
      get content() {
        contentReads++;
        return { unpinnedAfterMs: contentReads === 1 ? 9 : 1 };
      },
    };
    const p = retentionPolicy(spec);
    expect(p).toEqual({ terminalTtlMs: 5, content: { unpinnedAfterMs: 9 } });
    expect(ttlReads).toBe(1);
    expect(contentReads).toBe(1);
    expect(Object.getOwnPropertyDescriptor(p, "terminalTtlMs")?.get).toBeUndefined();
    expect(Object.isFrozen(p)).toBe(true);
  });

  it("states the advisory rule in its refusal", () => {
    expect(() => retentionPolicy({ terminalTtlMs: 10, content: { unpinnedAfterMs: 9 } })).toThrow(
      /advisory consistency rule/
    );
  });

  const bad: [string, unknown, RegExp][] = [
    ["negative ttl", { terminalTtlMs: -1 }, /terminalTtlMs must be a finite integer >= 0.*got -1/],
    ["fractional ttl", { terminalTtlMs: 1.5 }, /terminalTtlMs must be a finite integer/],
    ["NaN ttl", { terminalTtlMs: Number.NaN }, /got NaN/],
    ["Infinity ttl", { terminalTtlMs: Number.POSITIVE_INFINITY }, /got Infinity/],
    ["string ttl", { terminalTtlMs: "30d" }, /got 30d/],
    ["missing ttl", {}, /got undefined/],
    [
      "keepLatest 0",
      { terminalTtlMs: 0, snapshots: { keepLatest: 0 } },
      /keepLatest must be an integer >= 1.*got 0/,
    ],
    ["keepLatest fractional", { terminalTtlMs: 0, snapshots: { keepLatest: 1.5 } }, /keepLatest/],
    ["snapshots without keepLatest", { terminalTtlMs: 0, snapshots: {} }, /got undefined/],
    [
      "unpinnedAfterMs 0",
      { terminalTtlMs: 0, content: { unpinnedAfterMs: 0 } },
      /unpinnedAfterMs must be a finite integer > 0.*got 0/,
    ],
    [
      "unpinnedAfterMs Infinity",
      { terminalTtlMs: 0, content: { unpinnedAfterMs: Number.POSITIVE_INFINITY } },
      /unpinnedAfterMs must be a finite integer/,
    ],
    [
      "content shorter than logs",
      { terminalTtlMs: 10, content: { unpinnedAfterMs: 9 } },
      /unpinnedAfterMs \(9\) must be >= terminalTtlMs \(10\)/,
    ],
    [
      "unknown top-level key",
      { terminalTtlMs: 0, snapshot: { keepLatest: 1 } },
      /unknown key "snapshot"/,
    ],
    [
      "unknown snapshots key",
      { terminalTtlMs: 0, snapshots: { keepLatest: 1, keepAll: 1 } },
      /unknown key "snapshots.keepAll"/,
    ],
    [
      "unknown content key",
      { terminalTtlMs: 0, content: { unpinnedAfterMs: 1, ttl: 1 } },
      /unknown key "content.ttl"/,
    ],
    ["non-object", 5, /must be an object/],
    ["null", null, /must be an object/],
    ["array", [], /must be an object/],
    ["non-object section", { terminalTtlMs: 0, snapshots: 3 }, /snapshots must be an object/],
  ];
  for (const [name, value, message] of bad) {
    it(`rejects ${name} with a typed, actionable error`, () => {
      expect(() => assertRetentionPolicy(value)).toThrow(RetentionPolicyError);
      expect(() => assertRetentionPolicy(value)).toThrow(message);
      expect(() => assertRetentionPolicy(value)).toThrow(/^retention policy: /);
      expect(() => retentionPolicy(value as never)).toThrow(RetentionPolicyError);
    });
  }
});

describe("re-validation at the consumers (a plain literal cannot bypass the rules)", () => {
  async function seeded() {
    const eventStore = new InMemoryAsyncEventStore();
    const snapshotStore = new InMemoryAsyncSnapshotStore();
    const ev = (sequence: number, eventType: string, payload: unknown) => ({
      id: `r-${sequence}`,
      workflowId: "wf",
      executionId: "r",
      eventType,
      sequence,
      timestamp: 1_000 + sequence,
      payload,
    });
    await eventStore.append(ev(0, "EXECUTION_STARTED", { input: {} }));
    await eventStore.append(ev(1, "EXECUTION_COMPLETED", { output: {} }));
    const life = new LogLifecycle(eventStore, snapshotStore);
    return { life, eventStore };
  }

  it("evaluate and applyRetention reject an invalid plain object before touching anything", async () => {
    const { life, eventStore } = await seeded();
    await expect(life.evaluate("r", { terminalTtlMs: -1 }, 5_000)).rejects.toThrow(
      RetentionPolicyError
    );
    await expect(
      life.applyRetention("r", { terminalTtlMs: 0, snapshot: {} } as never, 5_000)
    ).rejects.toThrow(/unknown key "snapshot"/);
    expect((await eventStore.read("r")).length).toBe(2);
  });

  it("the old shape behaves exactly as before: ttl 0 reclaims, a long ttl keeps", async () => {
    const { life, eventStore } = await seeded();
    expect(await life.evaluate("r", { terminalTtlMs: 10_000 }, 2_000)).toBe("kept");
    expect(await life.evaluate("r", { terminalTtlMs: 0 }, 2_000)).toBe("reclaimable");
    expect(await life.applyRetention("r", { terminalTtlMs: 10_000 }, 2_000)).toBe("kept");
    expect(await life.applyRetention("r", retentionPolicy({ terminalTtlMs: 0 }), 2_000)).toBe(
      "reclaimed"
    );
    expect(await eventStore.read("r")).toEqual([]);
  });

  it("a policy with extra sections is accepted by applyRetention and only terminalTtlMs is read", async () => {
    const { life } = await seeded();
    const p = retentionPolicy({
      terminalTtlMs: 10_000,
      snapshots: { keepLatest: 2 },
      content: { unpinnedAfterMs: 10_000 },
    });
    expect(await life.applyRetention("r", p, 2_000)).toBe("kept");
  });

  it("pruneSnapshots re-validates a policy it is handed", async () => {
    const { life } = await seeded();
    await expect(life.pruneSnapshots("r", { policy: { terminalTtlMs: -1 } })).rejects.toThrow(
      RetentionPolicyError
    );
  });
});

describe("LogLifecycle.pinnedEventTypes / RetentionVerdict", () => {
  it("the getter returns the configured kinds, frozen; [] when unconfigured", () => {
    const es = new InMemoryAsyncEventStore();
    const ss = new InMemoryAsyncSnapshotStore();
    const configured = new LogLifecycle(es, ss, {
      pinnedEventTypes: ["FINDING", "NOTE", "FINDING"],
    });
    expect(configured.pinnedEventTypes).toEqual(["FINDING", "NOTE"]);
    expect(Object.isFrozen(configured.pinnedEventTypes)).toBe(true);
    expect(new LogLifecycle(es, ss).pinnedEventTypes).toEqual([]);
  });

  it("evaluate's declared return type is RetentionVerdict", () => {
    expectTypeOf<Awaited<ReturnType<LogLifecycle["evaluate"]>>>().toEqualTypeOf<RetentionVerdict>();
    expectTypeOf<"reclaimed">().not.toMatchTypeOf<RetentionVerdict>();
    expectTypeOf<"reclaimable">().toMatchTypeOf<RetentionVerdict>();
  });
});
