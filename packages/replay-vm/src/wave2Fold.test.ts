import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { EVENT_SCHEMA_VERSION, knownEventTypes } from "./eventHandlers";
import { foldEvents } from "./foldEvents";

// EVENT_SCHEMA 1.23.0 (Wave 2, W2-0) — every new fold handler, against the FROZEN shapes, with no
// kernel writer yet. The marker rule is the safety property: the new kinds fold only a
// kernel-stamped envelope, so an application event that already carries one of the names in an
// existing log folds exactly as an unknown kind always did.

const K = { kernel: true };

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

const start = (payload: unknown = { input: {} }, metadata?: Record<string, unknown>) =>
  ev(0, "EXECUTION_STARTED", payload, metadata);

describe("EVENT_SCHEMA 1.23.0 — version and kinds", () => {
  it("declares 1.25.0 (1.23.0 added the kinds; 1.24.0 is ADR 0128; 1.25.0 is the ADR 0130 residuals) and folds 34 kinds", () => {
    expect(EVENT_SCHEMA_VERSION).toBe("1.26.0");
    expect(knownEventTypes()).toHaveLength(34);
    expect(knownEventTypes()).toContain("EXECUTION_CONTINUED");
    expect(knownEventTypes()).toContain("MESSAGE_CONSUMED");
  });
});

describe("the kernel marker rule: unstamped instances fold as they always did", () => {
  const base = [start(), ev(1, "STEP_STARTED", { stepId: "a" })];

  it("an app-emitted MESSAGE_CONSUMED / EXECUTION_CONTINUED in an existing log is a no-op", () => {
    const plain = (t: string) =>
      foldEvents([
        ...base,
        ev(2, t, {
          waitId: "#0",
          topic: "t",
          messageId: "m",
          inboxSeq: 0,
          payload: 1,
          successorId: "x~1",
        }),
      ]);
    // Byte-identical to the same log with a kind the fold has never heard of.
    const unknown = plain("SOME_APP_EVENT");
    expect(JSON.stringify(plain("MESSAGE_CONSUMED"))).toBe(JSON.stringify(unknown));
    expect(JSON.stringify(plain("EXECUTION_CONTINUED"))).toBe(JSON.stringify(unknown));
    expect(plain("EXECUTION_CONTINUED").status).toBe("running");
  });

  it("an unstamped PARALLEL_COMPLETED keeps the pre-1.23.0 fold (updatedAt only)", () => {
    const state = foldEvents([
      ...base,
      ev(2, "PARALLEL_COMPLETED", {
        scopePath: "0/0.1",
        failedBranch: 1,
        error: "e",
        cancelled: [],
      }),
    ]);
    expect(state.variables._scopes).toBeUndefined();
    expect(state.updatedAt).toBe(1002);
  });

  it("a wait-addressed-looking RESUMED without the stamp is a plain answer (the payload object)", () => {
    const state = foldEvents([
      start(),
      ev(1, "EXECUTION_SUSPENDED", {
        condition: { on: "A", waits: [{ waitId: "#0", kind: "gate", on: "A" }] },
      }),
      ev(2, "EXECUTION_RESUMED", { waitId: "#0", payload: "yes" }),
    ]);
    expect(state.variables._waitAnswers).toBeUndefined();
    expect(state.variables._resumePayloads).toEqual([{ waitId: "#0", payload: "yes" }]);
  });
});

describe("EXECUTION_CONTINUED", () => {
  it("folds to the terminal status `continued` and names the successor", () => {
    const state = foldEvents([
      start(),
      ev(1, "EXECUTION_CONTINUED", { successorId: "x~1", chainId: "x", generation: 1 }, K),
    ]);
    expect(state.status).toBe("continued");
    expect(state.variables._continuedTo).toBe("x~1");
    expect(state.variables._output).toBeUndefined();
  });

  it("clears a pending failed-while-parked mark, like every terminal kind", () => {
    const state = foldEvents([
      start(),
      ev(1, "EXECUTION_SUSPENDED", { condition: { on: "A" } }),
      ev(2, "STEP_FAILED", { stepId: "s" }),
      ev(3, "EXECUTION_CONTINUED", { successorId: "x~1", chainId: "x", generation: 1 }, K),
    ]);
    expect(state.variables._failedWhileParked).toBeUndefined();
  });

  it("a stamped event with no successor is ignored, never thrown", () => {
    const state = foldEvents([start(), ev(1, "EXECUTION_CONTINUED", { chainId: "x" }, K)]);
    expect(state.status).toBe("running");
  });
});

describe("EXECUTION_STARTED additive fields", () => {
  it("folds principal, parent, chain and codeHash to reserved keys", () => {
    const principal = { v: 1, identity: { tenant: "t", actor: "a" } };
    const state = foldEvents([
      start({
        input: 1,
        principal,
        parent: "p",
        chainId: "x",
        generation: 0,
        codeHash: "sha256:ab",
      }),
    ]);
    expect(state.variables).toEqual({
      _input: 1,
      _principal: principal,
      _parent: "p",
      _chain: { chainId: "x", generation: 0 },
      _codeHash: "sha256:ab",
    });
  });

  it("an anonymous start records { v: 1 }", () => {
    expect(foldEvents([start({ input: {}, principal: { v: 1 } })]).variables._principal).toEqual({
      v: 1,
    });
  });

  it("a legacy start (none of the fields) gains no key", () => {
    expect(foldEvents([start({ input: 5, flowHash: "h" })]).variables).toEqual({
      _input: 5,
      _flowHash: "h",
    });
  });

  it("forkedBy wins over the copied principal", () => {
    const state = foldEvents([
      start(
        { input: {}, principal: { v: 1, ref: "owner" } },
        { forkedBy: { v: 1, ref: "forker" } }
      ),
    ]);
    expect(state.variables._principal).toEqual({ v: 1, ref: "forker" });
  });

  it("malformed fields are ignored, never thrown", () => {
    const state = foldEvents([
      start({ input: {}, principal: "x", parent: 5, chainId: "", generation: -1, codeHash: 3 }),
    ]);
    expect(state.variables).toEqual({ _input: {} });
  });

  describe("a continuation carries its budget and inbox (the fold applies the carry)", () => {
    const carried = {
      resources: { tokens: 10, costUsd: 0.5, ms: 5, count: 2, custom: { gpu: 3 } },
      inbox: { cursors: { chat: 7 }, dedupe: ["m1", "m2"] },
      chainDeadline: 99,
    };
    const succ = (meta?: Record<string, unknown>) =>
      start(
        {
          input: { turn: 0 },
          chainId: "x",
          generation: 1,
          continuedFrom: { executionId: "x", carried },
        },
        meta
      );

    it("seeds _resources and _inbox; chainDeadline stays in _chain.continuedFrom", () => {
      const s = foldEvents([succ()]);
      expect(s.variables._chain).toEqual({
        chainId: "x",
        generation: 1,
        continuedFrom: { executionId: "x", carried },
      });
      expect(s.variables._resources).toEqual({
        tokens: 10,
        costUsd: 0.5,
        ms: 5,
        count: 2,
        custom: { gpu: 3 },
      });
      expect(s.variables._inbox).toEqual({ cursors: { chat: 7 }, dedupe: ["m1", "m2"] });
    });

    it("metering after the carry adds on top of it", () => {
      const s = foldEvents([succ(), ev(1, "RESOURCE_METERED", { tokens: 5, custom: { gpu: 1 } })]);
      expect(s.variables._resources).toMatchObject({ tokens: 15, count: 3, custom: { gpu: 4 } });
    });

    it("a fork of a successor starts a fresh chain: forkChain replaces _chain, no inbox is seeded, but the carried RESOURCES are kept", () => {
      const s = foldEvents([succ({ forkChain: { chainId: "fork-1", generation: 0 } })]);
      expect(s.variables._chain).toEqual({ chainId: "fork-1", generation: 0 });
      // a carried quota is the execution's own history, not chain membership (R1b fix round 1)
      expect(s.variables._resources).toMatchObject({ tokens: 10, count: 2, custom: { gpu: 3 } });
      expect(s.variables._inbox).toBeUndefined();
    });

    it("an invalid carry is ignored deterministically (never thrown)", () => {
      const s = foldEvents([
        start({
          input: {},
          chainId: "x",
          generation: 1,
          continuedFrom: {
            executionId: "x",
            carried: {
              resources: { tokens: -1, costUsd: "x", custom: { __proto__: 1, Bad: 1, ok: 2 } },
              inbox: { cursors: { t: -3, u: 1.5, v: 4, constructor: 1 }, dedupe: [1, "a"] },
            },
          },
        }),
      ]);
      expect(s.variables._resources).toEqual({
        tokens: 0,
        costUsd: 0,
        ms: 0,
        count: 0,
        custom: { ok: 2 },
      });
      expect(s.variables._inbox).toEqual({ cursors: { v: 4 }, dedupe: ["a"] });
    });

    it("a rotation cannot reset a quota: exceeded and reason ride the carry", () => {
      const spent = {
        resources: { tokens: 10, costUsd: 0, ms: 0, count: 1, exceeded: true, reason: "budget" },
      };
      const s = foldEvents([
        start({
          input: {},
          chainId: "x",
          generation: 2,
          continuedFrom: { executionId: "x", carried: spent },
        }),
      ]);
      expect(s.variables._resources).toEqual({
        tokens: 10,
        costUsd: 0,
        ms: 0,
        count: 1,
        exceeded: true,
        reason: "budget",
      });
      // a non-boolean / non-string claim is ignored
      const junk = foldEvents([
        start({
          input: {},
          chainId: "x",
          generation: 2,
          continuedFrom: {
            executionId: "x",
            carried: { resources: { tokens: 1, exceeded: "yes", reason: 5 } },
          },
        }),
      ]);
      expect(junk.variables._resources).toEqual({ tokens: 1, costUsd: 0, ms: 0, count: 0 });
    });

    it("a continuedFrom with no executionId is dropped", () => {
      const s = foldEvents([
        start({ input: {}, chainId: "x", generation: 1, continuedFrom: { carried } }),
      ]);
      expect(s.variables._chain).toEqual({ chainId: "x", generation: 1 });
      expect(s.variables._resources).toBeUndefined();
    });
  });
});

describe("MESSAGE_CONSUMED", () => {
  const consumed = (seq: number, p: Record<string, unknown>) =>
    ev(
      seq,
      "MESSAGE_CONSUMED",
      {
        waitId: "#0",
        topic: "chat",
        messageId: "m1",
        inboxSeq: 0,
        sender: { actor: "s" },
        payload: "hi",
        ...p,
      },
      K
    );

  it("advances the cursor, remembers the id, and answers the wait", () => {
    const s = foldEvents([start(), consumed(1, {})]);
    expect(s.variables._inbox).toEqual({ cursors: { chat: 0 }, dedupe: ["m1"] });
    expect(s.variables._waitAnswers).toEqual({
      "#0": { kind: "inbox", name: "chat", payload: "hi" },
    });
  });

  it("a duplicate messageId advances the cursor with NO answer", () => {
    const s = foldEvents([start(), consumed(1, {}), consumed(2, { waitId: "#1", inboxSeq: 1 })]);
    expect(s.variables._inbox).toEqual({ cursors: { chat: 1 }, dedupe: ["m1"] });
    expect(Object.keys(s.variables._waitAnswers as object)).toEqual(["#0"]);
  });

  it("the first answer to a wait wins; the cursor never moves backwards", () => {
    const s = foldEvents([
      start(),
      consumed(1, { inboxSeq: 5 }),
      consumed(2, { messageId: "m2", inboxSeq: 3, payload: "later" }),
    ]);
    expect((s.variables._waitAnswers as Record<string, { payload: unknown }>)["#0"]?.payload).toBe(
      "hi"
    );
    expect((s.variables._inbox as { cursors: Record<string, number> }).cursors.chat).toBe(5);
  });

  it("the dedupe window is capped at 1024, dropping the oldest", () => {
    const events = [start()];
    for (let i = 0; i < 1030; i++) {
      events.push(consumed(i + 1, { waitId: `#${i}`, messageId: `m${i}`, inboxSeq: i }));
    }
    const dedupe = (foldEvents(events).variables._inbox as { dedupe: string[] }).dedupe;
    expect(dedupe).toHaveLength(1024);
    expect(dedupe[0]).toBe("m6");
    expect(dedupe.at(-1)).toBe("m1029");
  });

  it("malformed payloads and reserved names are ignored", () => {
    for (const bad of [
      { waitId: "__proto__" },
      { topic: "constructor" },
      { messageId: 3 },
      { inboxSeq: -1 },
      { inboxSeq: 1.5 },
    ]) {
      const s = foldEvents([start(), consumed(1, bad)]);
      expect(s.variables._inbox).toBeUndefined();
    }
  });

  it("a topic named like an Object.prototype member keeps a numeric cursor (own-property reads), snapshot-equal", () => {
    for (const topic of ["toString", "valueOf", "hasOwnProperty", "isPrototypeOf"]) {
      const events = [
        start(),
        consumed(1, { topic, messageId: "a", inboxSeq: 3 }),
        consumed(2, { topic, waitId: "#1", messageId: "b", inboxSeq: 5 }),
      ];
      const full = foldEvents(events);
      expect((full.variables._inbox as { cursors: Record<string, number> }).cursors[topic]).toBe(5);
      const head = foldEvents(events.slice(0, 2));
      expect((head.variables._inbox as { cursors: Record<string, number> }).cursors[topic]).toBe(3);
      const resumed = foldEvents(events.slice(2), JSON.parse(JSON.stringify(head)));
      expect(resumed).toEqual(full);
      expect(JSON.stringify(resumed)).toBe(JSON.stringify(full));
    }
  });

  it("is a pure fold: snapshot + tail equals the full log", () => {
    const events = [
      start(),
      consumed(1, {}),
      consumed(2, { waitId: "#1", messageId: "m2", inboxSeq: 1 }),
    ];
    const full = foldEvents(events);
    const head = foldEvents(events.slice(0, 2));
    const resumed = foldEvents(events.slice(2), JSON.parse(JSON.stringify(head)));
    expect(resumed).toEqual(full);
  });
});

describe("multi-wait parks and wait-addressed resumes", () => {
  // A multi-wait park is folded ONLY from a kernel-stamped EXECUTION_SUSPENDED (the R2 writer
  // stamps it whenever it adds `waits`); the same payload unstamped is userspace and is dropped.
  const parkPayload = {
    condition: {
      on: "A",
      waits: [
        { waitId: "0#0", kind: "gate", on: "A", viewDigest: "d" },
        { waitId: "0#1", kind: "inbox", topic: "chat" },
        { waitId: "0#2", kind: "timer", wakeAt: 5000 },
      ],
    },
  };
  const park = ev(1, "EXECUTION_SUSPENDED", parkPayload, K);

  it("records each timer arm's wakeAt once, at first registration", () => {
    const s = foldEvents([
      start(),
      park,
      ev(2, "EXECUTION_RESUMED", { waitId: "0#1", payload: "x" }, K),
      ev(
        3,
        "EXECUTION_SUSPENDED",
        { condition: { on: "A", waits: [{ waitId: "0#2", kind: "timer", wakeAt: 9999 }] } },
        K
      ),
    ]);
    expect(s.variables._waits).toEqual({ "0#2": { kind: "timer", wakeAt: 5000 } });
  });

  it("a stamped { waitId, payload } resume answers that wait, unwrapped, outside _resumePayloads", () => {
    const s = foldEvents([
      start(),
      park,
      ev(2, "EXECUTION_RESUMED", { waitId: "0#0", payload: { approved: true } }, K),
    ]);
    expect(s.status).toBe("running");
    expect(s.suspendedOn).toBeUndefined();
    expect(s.variables._waitAnswers).toEqual({
      "0#0": { kind: "gate", name: "A", payload: { approved: true } },
    });
    expect(s.variables._resumePayloads).toBeUndefined();
    expect(s.variables._resumePayload).toBeUndefined();
  });

  it("answering a timer arm drops its pinned wakeAt; a null inner payload is still an answer", () => {
    const s = foldEvents([
      start(),
      park,
      ev(2, "EXECUTION_RESUMED", { waitId: "0#2", payload: null }, K),
    ]);
    expect(s.variables._waits).toEqual({});
    expect(s.variables._waitAnswers).toEqual({
      "0#2": { kind: "timer", name: "timer", payload: null },
    });
  });

  it("naming no wait of the current park re-opens status-only", () => {
    const s = foldEvents([
      start(),
      park,
      ev(2, "EXECUTION_RESUMED", { waitId: "9#9", payload: 1 }, K),
    ]);
    expect(s.status).toBe("running");
    expect(s.variables._waitAnswers).toBeUndefined();
    expect(s.variables._resumePayloads).toBeUndefined();
  });

  it("an UNSTAMPED park carrying waits is userspace: nothing pins, nothing is recorded, a stamped wait-addressed resume answers nothing", () => {
    const forged = ev(
      1,
      "EXECUTION_SUSPENDED",
      {
        condition: {
          on: "A",
          waits: [
            { waitId: "root#0", kind: "timer", wakeAt: 9e15 },
            { waitId: "0#0", kind: "gate", on: "A" },
          ],
        },
      },
      undefined
    );
    const parked = foldEvents([start(), forged]);
    expect(parked.status).toBe("suspended");
    expect(parked.variables._waits).toBeUndefined();
    expect(parked.suspendedOn).toEqual({ on: "A" });
    const s = foldEvents([
      start(),
      forged,
      ev(2, "EXECUTION_RESUMED", { waitId: "0#0", payload: "x" }, K),
    ]);
    expect(s.status).toBe("running");
    expect(s.variables._waitAnswers).toBeUndefined();
    expect(s.variables._waits).toBeUndefined();
  });

  it("the stamped park keeps only well-formed waits in the fold-owned table", () => {
    const s = foldEvents([
      start(),
      ev(
        1,
        "EXECUTION_SUSPENDED",
        {
          condition: {
            on: "A",
            waits: [
              null,
              1,
              "str",
              { a: 1 },
              { waitId: "__proto__", kind: "gate" },
              { waitId: "ok#0", kind: "gate", on: "A" },
            ],
          },
        },
        K
      ),
    ]);
    expect(s.suspendedOn?.waits).toEqual([{ waitId: "ok#0", kind: "gate", on: "A" }]);
  });

  it("malformed waits never throw the fold, stamped or not, with or without a wait-addressed resume", () => {
    for (const waits of [[null], [{ a: 1 }], "str", 7, { waitId: "#0" }, [[]], [undefined]]) {
      for (const stamp of [undefined, K]) {
        const log = [
          start(),
          ev(1, "EXECUTION_SUSPENDED", { condition: { on: "A", waits } }, stamp),
          ev(2, "EXECUTION_RESUMED", { waitId: "#0", payload: 1 }, K),
        ];
        expect(() => foldEvents(log), JSON.stringify([waits, stamp])).not.toThrow();
        expect(foldEvents(log).status).toBe("running");
      }
    }
  });

  it("a legacy single-gate park and bare resume fold exactly as before", () => {
    const s = foldEvents([
      start(),
      ev(1, "EXECUTION_SUSPENDED", { condition: { on: "A" } }),
      ev(2, "EXECUTION_RESUMED", { ok: 1 }),
    ]);
    expect(s.variables._resumePayloads).toEqual([{ ok: 1 }]);
    expect(s.variables._waits).toBeUndefined();
  });
});

describe("PARALLEL_COMPLETED (stamped)", () => {
  it("folds the scope outcome under _scopes[scopePath]", () => {
    const s = foldEvents([
      start(),
      ev(
        1,
        "PARALLEL_COMPLETED",
        { scopePath: "/0.1", failedBranch: 1, error: { m: "boom" }, cancelled: ["b#0", 3] },
        K
      ),
    ]);
    expect(s.variables._scopes).toEqual({
      "/0.1": { failedBranch: 1, error: { m: "boom" }, cancelled: ["b#0"] },
    });
  });

  it("a reserved scope path is ignored", () => {
    const s = foldEvents([start(), ev(1, "PARALLEL_COMPLETED", { scopePath: "__proto__" }, K)]);
    expect(s.variables._scopes).toBeUndefined();
  });
});

describe("RESOURCE_METERED.custom", () => {
  const meter = (seq: number, custom: unknown, extra: Record<string, unknown> = {}) =>
    ev(seq, "RESOURCE_METERED", { tokens: 1, ...extra, custom });

  it("sums open dimensions into _resources.custom", () => {
    const s = foldEvents([
      start(),
      meter(1, { gpu_seconds: 2 }),
      meter(2, { gpu_seconds: 3, credits: 1 }),
    ]);
    expect(s.variables._resources).toMatchObject({
      count: 2,
      custom: { gpu_seconds: 5, credits: 1 },
    });
  });

  it("a log that never uses custom has no custom key (byte-identical)", () => {
    const s = foldEvents([start(), ev(1, "RESOURCE_METERED", { tokens: 1 })]);
    expect(Object.hasOwn(s.variables._resources as object, "custom")).toBe(false);
  });

  it("skips bad keys deterministically and folds the rest", () => {
    const custom = JSON.parse(
      '{"__proto__": 1, "constructor": 1, "prototype": 1, "Bad Name": 1, "neg": -1, "inf": 1e999, "big": 1e16, "str": "1", "ok": 4}'
    );
    const s = foldEvents([start(), meter(1, custom)]);
    expect((s.variables._resources as { custom: object }).custom).toEqual({ ok: 4 });
  });

  it("caps distinct names at 32; existing names keep accumulating", () => {
    const first: Record<string, number> = {};
    for (let i = 0; i < 40; i++) first[`d${i}`] = 1;
    const s = foldEvents([start(), meter(1, first), meter(2, { d0: 1, extra: 1 })]);
    const custom = (s.variables._resources as { custom: Record<string, number> }).custom;
    expect(Object.keys(custom)).toHaveLength(32);
    expect(custom.d0).toBe(2);
    expect(custom.extra).toBeUndefined();
  });

  it("QUOTA_EXCEEDED keeps the custom totals", () => {
    const s = foldEvents([start(), meter(1, { g: 1 }), ev(2, "QUOTA_EXCEEDED", { reason: "x" })]);
    expect(s.variables._resources).toMatchObject({ exceeded: true, custom: { g: 1 } });
  });
});

describe("OUTCOME_RECORDED.recordedBy / late", () => {
  const late = {
    key: "k",
    score: 1,
    decisionId: "d",
    recordedBy: "ops",
    late: true,
  };

  it("an UNSTAMPED outcome claiming recordedBy / late folds without them (only the kernel's recordOutcome is trusted)", () => {
    const s = foldEvents([start(), ev(1, "OUTCOME_RECORDED", late)]);
    expect(s.variables._outcomes).toEqual([{ key: "k", score: 1, decisionId: "d" }]);
  });

  it("rides on the _outcomes entry when kernel-stamped; absent otherwise", () => {
    const s = foldEvents([
      start(),
      ev(1, "OUTCOME_RECORDED", { key: "k", success: true }),
      ev(2, "OUTCOME_RECORDED", late, K),
    ]);
    expect(s.variables._outcomes).toEqual([
      { key: "k", success: true },
      { key: "k", score: 1, decisionId: "d", recordedBy: "ops", late: true },
    ]);
  });
});
