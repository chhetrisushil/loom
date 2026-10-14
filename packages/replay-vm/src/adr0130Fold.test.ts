import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { ReplayVM } from "./ReplayVM";
import { QUARANTINE_FOLD_CAP } from "./eventHandlers";
import { foldEvents } from "./foldEvents";

// EVENT_SCHEMA 1.25.0 (ADR 0130 residuals, slice S1) — the RESERVED shapes: INBOX_QUARANTINED,
// INBOX_RELEASED, `_quarantined`, the MESSAGE_CONSUMED drop, the carried seed and the envelope key
// `metadata.seal`. There is no kernel writer yet; these tests pin what a fold of a FUTURE writer's log
// must produce, and, above all, that nothing existing moved.

const K = { kernel: true };
const OP = { actor: "op", tenant: "t" };

function ev(
  sequence: number,
  eventType: string,
  payload: unknown = {},
  metadata?: Record<string, unknown>
): EventEnvelope {
  return {
    id: `x-${sequence}`,
    workflowId: "wf",
    executionId: "x",
    eventType,
    sequence,
    timestamp: 1000 + sequence,
    payload,
    ...(metadata !== undefined && { metadata }),
  };
}

const start = (payload: unknown = { input: {} }) => ev(0, "EXECUTION_STARTED", payload);

const quarantine = (
  sequence: number,
  topic: string,
  inboxSeq: number,
  key: string,
  extra: Record<string, unknown> = {},
  metadata: Record<string, unknown> | null = K
) =>
  ev(
    sequence,
    "INBOX_QUARANTINED",
    { topic, inboxSeq, key, messageId: `raw-${key}`, heldAt: inboxSeq, operator: OP, ...extra },
    metadata ?? undefined
  );

const release = (
  sequence: number,
  topic: string,
  key: string,
  extra: Record<string, unknown> = { operator: OP },
  disposition: unknown = "deliver",
  metadata: Record<string, unknown> | null = K
) =>
  ev(
    sequence,
    "INBOX_RELEASED",
    { topic, key, messageId: `raw-${key}`, disposition, ...extra },
    metadata ?? undefined
  );

const consumed = (sequence: number, topic: string, key: string, inboxSeq: number, waitId = "#0") =>
  ev(
    sequence,
    "MESSAGE_CONSUMED",
    { waitId, topic, messageId: key, inboxSeq, sender: {}, payload: `p-${key}` },
    K
  );

const q = (log: EventEnvelope[]) => foldEvents(log).variables._quarantined;
const inbox = (log: EventEnvelope[]) =>
  foldEvents(log).variables._inbox as { cursors: Record<string, number>; dedupe: string[] };
const held = (key: string, inboxSeq: number, heldAt = inboxSeq) => ({
  key,
  inboxSeq,
  heldAt,
  state: "held",
});

describe("byte-identity: nothing that exists moved", () => {
  const legacy = [
    start(),
    ev(1, "EXECUTION_SUSPENDED", { condition: { on: "Approval" } }),
    ev(2, "MESSAGE_CONSUMED", { waitId: "#0", topic: "t", messageId: "m1", inboxSeq: 4 }, K),
    ev(3, "EXECUTION_RESUMED", { approved: true }),
    ev(4, "EXECUTION_COMPLETED", { output: 1 }),
  ];

  it("a log with none of the new shapes never gains `_quarantined`, and the inbox variable is unchanged", () => {
    const state = foldEvents(legacy);
    expect("_quarantined" in state.variables).toBe(false);
    expect(state.variables._inbox).toEqual({ cursors: { t: 4 }, dedupe: ["m1"] });
  });

  it("MESSAGE_CONSUMED without `_quarantined` folds exactly as before, duplicates included", () => {
    const log = [start(), consumed(1, "t", "m1", 1), consumed(2, "t", "m1", 2, "#1")];
    const state = foldEvents(log);
    expect(state.variables._inbox).toEqual({ cursors: { t: 2 }, dedupe: ["m1"] });
    expect("_quarantined" in state.variables).toBe(false);
  });

  it("a start whose carry has no `quarantined` seeds no `_quarantined`", () => {
    const state = foldEvents([
      start({
        input: {},
        chainId: "c",
        generation: 1,
        continuedFrom: { executionId: "p", carried: { inbox: { cursors: { t: 1 }, dedupe: [] } } },
      }),
    ]);
    expect("_quarantined" in state.variables).toBe(false);
  });
});

describe("`metadata.seal` is ignored by the fold (D7)", () => {
  const seal = { v: 1, cipher: "loom/aes-256-gcm", covers: ["STEP_COMPLETED.output"] };
  const plain = [
    start({ input: { n: 1 } }),
    ev(1, "STEP_STARTED", { stepId: "a", input: { n: 1 } }),
    ev(2, "STEP_COMPLETED", { stepId: "a", output: { n: 2 } }),
    ev(3, "EXECUTION_SUSPENDED", { condition: { on: "Approval" } }),
    ev(4, "MESSAGE_CONSUMED", { waitId: "#0", topic: "t", messageId: "m1", inboxSeq: 0 }, K),
  ];

  it("the state of a log whose envelopes carry the key equals the same log without it", () => {
    const sealed = plain.map((e) => ({ ...e, metadata: { ...e.metadata, seal } }));
    expect(JSON.stringify(foldEvents(sealed))).toBe(JSON.stringify(foldEvents(plain)));
  });

  it("holds through the live VM too, and for a malformed marker", () => {
    const vm = new ReplayVM([plain[0] as EventEnvelope]);
    for (const e of plain.slice(1)) vm.applyEvent({ ...e, metadata: { ...e.metadata, seal: 7 } });
    expect(JSON.stringify(vm.getState())).toBe(JSON.stringify(foldEvents(plain)));
  });
});

describe("the stamp gate: INBOX_QUARANTINED / INBOX_RELEASED fold only a kernel-stamped envelope", () => {
  it("an UNSTAMPED INBOX_QUARANTINED is the no-op an unknown kind is", () => {
    const withUnstamped = [start(), quarantine(1, "chat", 3, "k3", {}, null)];
    const withUnknown = [start(), ev(1, "SOME_APP_EVENT", {})];
    expect(JSON.stringify(foldEvents(withUnstamped))).toBe(JSON.stringify(foldEvents(withUnknown)));
    expect(q(withUnstamped)).toBeUndefined();
    expect(foldEvents(withUnstamped).variables._inbox).toBeUndefined();
  });

  it("a stamp that is not literally `true` does not count", () => {
    expect(q([start(), quarantine(1, "chat", 3, "k3", {}, { kernel: "true" })])).toBeUndefined();
    expect(q([start(), quarantine(1, "chat", 3, "k3", {}, { kernel: 1 })])).toBeUndefined();
  });

  it("an UNSTAMPED INBOX_RELEASED changes nothing, even against a held entry", () => {
    const base = [start(), quarantine(1, "chat", 3, "k3")];
    const after = foldEvents([
      ...base,
      release(2, "chat", "k3", { operator: OP }, "deliver", null),
    ]);
    expect(after.variables._quarantined).toEqual({ chat: [held("k3", 3)] });
    expect(after.variables._inbox).toEqual({ cursors: { chat: 3 }, dedupe: [] });
  });
});

describe("INBOX_QUARANTINED", () => {
  it("advances the cursor by max, queues a held entry, and does NOT touch the dedupe window", () => {
    const log = [start(), consumed(1, "chat", "k1", 1), quarantine(2, "chat", 3, "k3")];
    expect(q(log)).toEqual({ chat: [held("k3", 3)] });
    expect(inbox(log)).toEqual({ cursors: { chat: 3 }, dedupe: ["k1"] });
  });

  it("never moves a cursor backwards", () => {
    const log = [start(), consumed(1, "chat", "k1", 9), quarantine(2, "chat", 3, "k3")];
    expect(inbox(log).cursors.chat).toBe(9);
  });

  it("with no prior `_inbox` creates one with an empty window", () => {
    expect(inbox([start(), quarantine(1, "chat", 0, "k0")])).toEqual({
      cursors: { chat: 0 },
      dedupe: [],
    });
  });

  it("queues FIFO per topic, independent across topics", () => {
    const log = [
      start(),
      quarantine(1, "a", 1, "k1"),
      quarantine(2, "b", 2, "k2"),
      quarantine(3, "a", 5, "k5"),
    ];
    expect(q(log)).toEqual({ a: [held("k1", 1), held("k5", 5)], b: [held("k2", 2)] });
  });

  it("ignores a malformed payload, a reserved topic and a missing/ non-object operator", () => {
    const bad: Array<Record<string, unknown>> = [
      { topic: "__proto__" },
      { topic: "" },
      { inboxSeq: -1 },
      { inboxSeq: 1.5 },
      { key: "" },
      { key: 7 },
      { messageId: 7 },
      { heldAt: -1 },
      { operator: undefined },
      { operator: "op" },
      { operator: [] },
    ];
    for (const extra of bad) {
      const state = foldEvents([start(), quarantine(1, "chat", 3, "k3", extra)]);
      expect(state.variables._quarantined, JSON.stringify(extra)).toBeUndefined();
      expect(state.variables._inbox, JSON.stringify(extra)).toBeUndefined();
    }
    expect(foldEvents([start(), ev(1, "INBOX_QUARANTINED", null, K)]).variables).not.toHaveProperty(
      "_quarantined"
    );
  });

  it("a topic named like a prototype member is a plain topic", () => {
    expect(q([start(), quarantine(1, "toString", 1, "k1")])).toEqual({
      toString: [held("k1", 1)],
    });
  });

  it("is ignored once the total would pass QUARANTINE_FOLD_CAP (1024), whole fact, cursor included", () => {
    expect(QUARANTINE_FOLD_CAP).toBe(1024);
    const log: EventEnvelope[] = [start()];
    for (let i = 0; i < QUARANTINE_FOLD_CAP; i++)
      log.push(quarantine(i + 1, `t${i % 7}`, i, `k${i}`));
    const full = foldEvents(log);
    const total = (s: typeof full) =>
      Object.values(s.variables._quarantined as Record<string, unknown[]>).reduce(
        (n, queue) => n + queue.length,
        0
      );
    expect(total(full)).toBe(1024);
    const over = foldEvents([...log, quarantine(1100, "t0", 99_999, "k-over")]);
    expect(total(over)).toBe(1024);
    expect((over.variables._inbox as { cursors: Record<string, number> }).cursors.t0).not.toBe(
      99_999
    );
    expect(JSON.stringify(over.variables)).toBe(JSON.stringify(full.variables));
  });
});

describe("INBOX_RELEASED", () => {
  const base = [start(), quarantine(1, "chat", 3, "k3"), quarantine(2, "chat", 5, "k5")];

  it("deliver marks the OLDEST held entry released; the queue stays released? held*", () => {
    expect(q([...base, release(3, "chat", "k3")])).toEqual({
      chat: [{ ...held("k3", 3), state: "released" }, held("k5", 5)],
    });
  });

  it("a manual release carries `operator`; an automatic one carries `auto: true` (deliver only)", () => {
    const manual = q([...base, release(3, "chat", "k3", { operator: OP })]);
    const auto = q([...base, release(3, "chat", "k3", { auto: true })]);
    expect(auto).toEqual(manual);
  });

  it("exactly one of operator / auto: both, or neither, is ignored", () => {
    for (const extra of [{ operator: OP, auto: true }, {}] as const) {
      expect(q([...base, release(3, "chat", "k3", extra)])).toEqual({
        chat: [held("k3", 3), held("k5", 5)],
      });
    }
  });

  it("`auto` is only valid with deliver, and only as the literal true", () => {
    expect(q([...base, release(3, "chat", "k3", { auto: true }, "discard")])).toEqual({
      chat: [held("k3", 3), held("k5", 5)],
    });
    for (const auto of [false, 1, "true", null]) {
      expect(q([...base, release(3, "chat", "k3", { auto })])).toEqual({
        chat: [held("k3", 3), held("k5", 5)],
      });
    }
  });

  it("an operator that is not an object, or a disposition that is neither, is ignored", () => {
    expect(q([...base, release(3, "chat", "k3", { operator: "op" })])).toEqual({
      chat: [held("k3", 3), held("k5", 5)],
    });
    expect(q([...base, release(3, "chat", "k3", { operator: OP }, "skip")])).toEqual({
      chat: [held("k3", 3), held("k5", 5)],
    });
    expect(q([...base, release(3, "chat", "k3", { operator: OP }, null)])).toEqual({
      chat: [held("k3", 3), held("k5", 5)],
    });
  });

  it("releasing a non-oldest entry, an unknown key, an unknown topic or an already released entry is ignored", () => {
    const untouched = { chat: [held("k3", 3), held("k5", 5)] };
    expect(q([...base, release(3, "chat", "k5")])).toEqual(untouched);
    expect(q([...base, release(3, "chat", "nope")])).toEqual(untouched);
    expect(q([...base, release(3, "other", "k3")])).toEqual(untouched);
    const once = [...base, release(3, "chat", "k3")];
    expect(q([...once, release(4, "chat", "k3")])).toEqual(q(once));
  });

  it("discard removes the oldest entry, adds its key to the dedupe window, and leaves the cursor", () => {
    const log = [...base, release(3, "chat", "k3", { operator: OP }, "discard")];
    expect(q(log)).toEqual({ chat: [held("k5", 5)] });
    expect(inbox(log)).toEqual({ cursors: { chat: 5 }, dedupe: ["k3"] });
  });

  it("discarding the last entry drops the topic key; a repeated discard is ignored", () => {
    const log = [
      start(),
      quarantine(1, "chat", 3, "k3"),
      release(2, "chat", "k3", { operator: OP }, "discard"),
      release(3, "chat", "k3", { operator: OP }, "discard"),
    ];
    expect(q(log)).toBeUndefined();
    expect(inbox(log)).toEqual({ cursors: { chat: 3 }, dedupe: ["k3"] });
  });

  it("discard does not double-record a key already in the window", () => {
    const log = [
      start(),
      consumed(1, "chat", "k3", 1),
      quarantine(2, "chat", 3, "k3"),
      release(3, "chat", "k3", { operator: OP }, "discard"),
    ];
    expect(inbox(log).dedupe).toEqual(["k3"]);
  });

  it("a released entry cannot be discarded (only a held one is acted on)", () => {
    const log = [
      ...base,
      release(3, "chat", "k3"),
      release(4, "chat", "k3", { operator: OP }, "discard"),
    ];
    expect(q(log)).toEqual({ chat: [{ ...held("k3", 3), state: "released" }, held("k5", 5)] });
  });
});

describe("MESSAGE_CONSUMED of a released key (the one handler that changed)", () => {
  const released = [
    start(),
    quarantine(1, "chat", 3, "k3"),
    quarantine(2, "chat", 5, "k5"),
    release(3, "chat", "k3", { auto: true }),
  ];

  it("drops the topic's first released entry, leaves the cursor, and records the key in the window", () => {
    const log = [...released, consumed(4, "chat", "k3", 3)];
    expect(q(log)).toEqual({ chat: [held("k5", 5)] });
    expect(inbox(log)).toEqual({ cursors: { chat: 5 }, dedupe: ["k3"] });
    expect(foldEvents(log).variables._waitAnswers).toEqual({
      "#0": { kind: "inbox", name: "chat", payload: "p-k3" },
    });
  });

  it("the delivery of the last entry removes the topic key", () => {
    const log = [
      start(),
      quarantine(1, "chat", 3, "k3"),
      release(2, "chat", "k3"),
      consumed(3, "chat", "k3", 3),
    ];
    expect(q(log)).toBeUndefined();
    expect(foldEvents(log).variables).not.toHaveProperty("_quarantined");
  });

  it("a full hold -> release -> consume (and hold -> discard) cycle returns to the never-quarantined shape", () => {
    const plainInbox = (state: ReturnType<typeof foldEvents>) => ({
      ...state.variables,
      _inbox: { ...(state.variables._inbox as object), cursors: undefined },
    });
    const without = foldEvents([start(), consumed(1, "chat", "k3", 3)]);
    const cycle = foldEvents([
      start(),
      quarantine(1, "chat", 3, "k3"),
      release(2, "chat", "k3"),
      consumed(3, "chat", "k3", 3),
    ]);
    expect(plainInbox(cycle)).toEqual(plainInbox(without));
    expect(cycle.variables).not.toHaveProperty("_quarantined");
    const discarded = foldEvents([
      start(),
      quarantine(1, "chat", 3, "k3"),
      release(2, "chat", "k3", { operator: OP }, "discard"),
    ]);
    expect(discarded.variables).not.toHaveProperty("_quarantined");
  });

  it("does not drop a HELD entry, an entry of another key, or another topic's entry", () => {
    const heldOnly = [start(), quarantine(1, "chat", 3, "k3"), consumed(2, "chat", "k3", 3)];
    expect(q(heldOnly)).toEqual({ chat: [held("k3", 3)] });
    expect(q([...released, consumed(4, "chat", "other", 9)])).toEqual({
      chat: [{ ...held("k3", 3), state: "released" }, held("k5", 5)],
    });
    expect(q([...released, consumed(4, "elsewhere", "k3", 9)])).toEqual({
      chat: [{ ...held("k3", 3), state: "released" }, held("k5", 5)],
    });
  });

  it("holds through the live VM (copy-on-write): a state read before the delivery is not mutated", () => {
    const vm = new ReplayVM(released);
    const before = structuredClone(vm.getState().variables._quarantined);
    const prior = vm.getState().variables._quarantined;
    vm.applyEvent(consumed(4, "chat", "k3", 3));
    expect(prior).toEqual(before);
    expect(vm.getState().variables._quarantined).toEqual({ chat: [held("k5", 5)] });
    expect(JSON.stringify(vm.getState())).toBe(
      JSON.stringify(foldEvents([...released, consumed(4, "chat", "k3", 3)]))
    );
  });
});

describe("EXECUTION_STARTED.continuedFrom.carried.quarantined (the validated seed)", () => {
  const carriedStart = (
    quarantined: unknown,
    inboxSeed: unknown = { cursors: { chat: 5 }, dedupe: ["x"] }
  ) =>
    start({
      input: {},
      chainId: "c",
      generation: 1,
      continuedFrom: { executionId: "p", carried: { inbox: inboxSeed, quarantined } },
    });

  it("round-trips a valid carry, and the seeded queue is then acted on like a folded one", () => {
    const seed = { chat: [{ ...held("k3", 3), state: "released" }, held("k5", 5)] };
    const state = foldEvents([carriedStart(seed)]);
    expect(state.variables._quarantined).toEqual(seed);
    // …and a continuation that carries what it folded carries the same thing again.
    const next = foldEvents([carriedStart(state.variables._quarantined)]);
    expect(next.variables._quarantined).toEqual(seed);
    expect(q([carriedStart(seed), consumed(1, "chat", "k3", 3)])).toEqual({
      chat: [held("k5", 5)],
    });
  });

  it("ignores invalid parts: a bad entry drops its topic, bad shapes drop everything, reserved names are skipped", () => {
    expect(foldEvents([carriedStart("nope")]).variables).not.toHaveProperty("_quarantined");
    expect(foldEvents([carriedStart([])]).variables).not.toHaveProperty("_quarantined");
    expect(foldEvents([carriedStart({})]).variables).not.toHaveProperty("_quarantined");
    const good = [held("k5", 5)];
    const seed = {
      ok: good,
      notArray: 7,
      empty: [],
      badKey: [{ ...held("", 1) }],
      badSeq: [{ ...held("k", -1) }],
      badHeld: [{ ...held("k", 1), heldAt: 1.5 }],
      badState: [{ ...held("k", 1), state: "gone" }],
      heldThenReleased: [held("a", 1), { ...held("b", 2), state: "released" }],
      twoReleased: [
        { ...held("c", 1), state: "released" },
        { ...held("d", 2), state: "released" },
      ],
      notObject: [null],
      ["__proto__"]: good,
    };
    expect(foldEvents([carriedStart(seed)]).variables._quarantined).toEqual({ ok: good });
  });

  it("caps the seed at QUARANTINE_FOLD_CAP in total", () => {
    const one = (n: number) => Array.from({ length: n }, (_, i) => held(`k${i}`, i));
    const state = foldEvents([carriedStart({ a: one(1000), b: one(100), c: one(24) })]);
    const topics = state.variables._quarantined as Record<string, unknown[]>;
    expect(Object.keys(topics)).toEqual(["a", "c"]);
    expect(Object.values(topics).reduce((n, queue) => n + queue.length, 0)).toBe(1024);
  });

  it("is not applied to a fork, which starts a fresh chain with no carried queue", () => {
    const fork = ev(
      0,
      "EXECUTION_STARTED",
      {
        input: {},
        chainId: "c",
        generation: 1,
        continuedFrom: { executionId: "p", carried: { quarantined: { chat: [held("k", 1)] } } },
      },
      { forkChain: { chainId: "fresh", generation: 0 } }
    );
    expect(foldEvents([fork]).variables).not.toHaveProperty("_quarantined");
  });
});

describe("the classification: both new kinds leave a park unanswered", () => {
  it("is asserted in @loom/event-runtime (eventKindClass.test.ts); here the fold proves they never change `status`", () => {
    const parked = [start(), ev(1, "EXECUTION_SUSPENDED", { condition: { on: "Approval" } })];
    const after = foldEvents([...parked, quarantine(2, "chat", 3, "k3"), release(3, "chat", "k3")]);
    expect(after.status).toBe("suspended");
    expect(after.suspendedOn).toEqual(foldEvents(parked).suspendedOn);
  });
});
