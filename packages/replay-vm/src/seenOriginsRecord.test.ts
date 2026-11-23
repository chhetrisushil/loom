import { tainted } from "@loomwork/classify";
import type { EventEnvelope, ExecutionState } from "@loomwork/core";
import { describe, expect, it } from "vitest";
import { foldEvents, normalizeSnapshotState } from "./foldEvents";
import { SEEN_ORIGINS_KEY } from "./seenOrigins";
import { scanSeenOriginsJson, scanSeenOriginsLive, seenOriginsRecord } from "./seenOriginsRecord";

// the journal's stamp (kernel-side wiring, S2a3) is `seenOriginsRecord` plus a strip of caller keys; tests here need only the record
const stampSeenOrigins = (
  before: ExecutionState | undefined,
  eventType: string,
  payload: unknown,
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined => {
  const rec = seenOriginsRecord(before, eventType, payload, metadata);
  return rec === undefined ? metadata : { ...metadata, ...rec };
};

// ADR 0152 D1 (R11): the walk runs at commit and RECORDS `metadata.origins`; the fold unions recorded lists.

const K = { kernel: true };
const STAMP = { maxOrigins: 64, maxScanNodes: 10_000 };
const T = (origin: string, value: unknown = 1) => tainted(value, origin);

type Raw = { eventType: string; payload: unknown; metadata?: Record<string, unknown> };
const env = (
  sequence: number,
  r: Raw,
  metadata: Record<string, unknown> | undefined
): EventEnvelope => ({
  id: `x-${sequence}`,
  workflowId: "wf",
  executionId: "x",
  eventType: r.eventType,
  sequence,
  timestamp: 1000 + sequence,
  payload: r.payload,
  ...(metadata !== undefined && { metadata }),
});

/** Simulates the journal commit path: stamp (scan once) against the state before, then fold the envelope. */
function commitAll(raws: Raw[], initial?: Partial<ExecutionState>, from = 0) {
  let state = initial as ExecutionState | undefined;
  const log: EventEnvelope[] = [];
  raws.forEach((r, i) => {
    const seq = from + i;
    const meta = stampSeenOrigins(
      i === 0 && from === 0 ? undefined : state,
      r.eventType,
      r.payload,
      r.metadata
    );
    const e = env(seq, r, meta);
    log.push(e);
    state = foldEvents([e], state);
  });
  return { state: state as ExecutionState, log };
}
const keyOf = (s: Partial<ExecutionState>) =>
  s.variables?.[SEEN_ORIGINS_KEY] as
    | { origins: string[]; overflow?: true; through?: number; limits: typeof STAMP }
    | undefined;
const start = (extra: Record<string, unknown> = {}, input: unknown = {}): Raw => ({
  eventType: "EXECUTION_STARTED",
  payload: { input, seenOriginsLimits: STAMP, ...extra },
});
const completed = (output: unknown, stepId = "s"): Raw => ({
  eventType: "STEP_COMPLETED",
  payload: { stepId, output },
});

describe("the walk", () => {
  it("recognises every shape tainted() produces, at any depth and in arrays", () => {
    const v = { a: [T("o1", { deep: T("o2") })], b: { c: T("o3", [T("o4")]) } };
    expect(scanSeenOriginsJson(v, 1000)).toEqual(["o1", "o2", "o3", "o4"]);
    expect(scanSeenOriginsJson(T("x", "str"), 10)).toEqual(["x"]);
    expect(scanSeenOriginsJson({ __loomTainted: { origin: "no-value" } }, 10)).toEqual([]);
    expect(scanSeenOriginsJson({ __loomTainted: "str", value: 1 }, 10)).toEqual([]);
  });
  it("sorts, dedupes and truncates BEFORE dedupe (over 256 chars becomes unknown:truncated:<fnv1a-64>)", () => {
    const long1 = "L".repeat(300);
    const long2 = `${"L".repeat(299)}M`;
    const out = scanSeenOriginsJson(
      [T("b"), T("a"), T("b"), T(long1), T(long1), T(long2)],
      100
    ) as string[];
    expect(out.filter((o) => o.startsWith("unknown:truncated:"))).toHaveLength(2);
    expect(out[0]).toBe("a");
    expect(out.every((o) => o.length <= 256)).toBe(true);
    expect(out).toEqual([...out].sort());
    expect(out.find((o) => o.startsWith("unknown:truncated:"))).toMatch(
      /^unknown:truncated:[0-9a-f]{16}$/
    );
  });
  it("exceeds on node cap, depth over 64 and a cycle: undefined, no partial origins", () => {
    expect(
      scanSeenOriginsJson([T("a"), ...Array.from({ length: 200 }, (_, i) => i)], 100)
    ).toBeUndefined();
    let deep: unknown = T("z");
    for (let i = 0; i < 70; i++) deep = [deep];
    expect(scanSeenOriginsJson(deep, 100_000)).toBeUndefined();
    let ok: unknown = T("z");
    for (let i = 0; i < 60; i++) ok = [ok];
    expect(scanSeenOriginsJson(ok, 100_000)).toEqual(["z"]);
    const cyc: Record<string, unknown> = { t: T("a") };
    cyc.self = cyc;
    expect(scanSeenOriginsJson(cyc, 100)).toBeUndefined();
  });
  it("shared references are NOT deduplicated (node count is identity-free) and are not cycles", () => {
    const shared = T("a");
    expect(scanSeenOriginsJson([shared, shared, shared], 100)).toEqual(["a"]);
    const sharedArr = [1, 2, 3, 4];
    // 1 root + 2*(1 array + 4 leaves) = 11 nodes: identity dedupe would make it 6
    expect(scanSeenOriginsJson([sharedArr, sharedArr], 10)).toBeUndefined();
    expect(scanSeenOriginsJson([sharedArr, sharedArr], 11)).toEqual([]);
  });
  it("sees the JSON view: toJSON applied, Map/Set empty, functions skipped", () => {
    expect(scanSeenOriginsJson({ toJSON: () => ({ v: T("viaToJSON") }) }, 100)).toEqual([
      "viaToJSON",
    ]);
    expect(
      scanSeenOriginsJson(
        { m: new Map([["k", T("m")]]), s: new Set([T("s")]), f: () => T("f") },
        100
      )
    ).toEqual([]);
    expect(scanSeenOriginsJson({ d: new Date(0), n: Number.NaN }, 100)).toEqual([]);
    expect(
      scanSeenOriginsJson(
        {
          get x(): unknown {
            throw new Error("boom");
          },
        },
        100
      )
    ).toBeUndefined();
  });
});

describe("every channel contributes (commit records, fold unions)", () => {
  const origins = (raws: Raw[]) => keyOf(commitAll(raws).state);
  it("STEP_COMPLETED.output, EXECUTION_STARTED.input, DECISION_RECORDED.choice, EXECUTION_MIGRATED.migratedInput", () => {
    const k = origins([
      start({}, T("in")),
      completed(T("out")),
      {
        eventType: "DECISION_RECORDED",
        payload: { decisionId: "d", choice: T("choice"), context: T("ignored-ctx") },
      },
      { eventType: "EXECUTION_MIGRATED", payload: { toFlowId: "f2", migratedInput: T("mig") } },
    ]);
    expect(k?.origins).toEqual(["in", "out", "choice", "mig"]);
  });
  it("STEP_FAILED.payload counts only with a channel; STEP_FAILED.error never", () => {
    const k = origins([
      start(),
      {
        eventType: "STEP_FAILED",
        payload: { stepId: "a", error: T("err"), channel: "c", payload: T("typed") },
      },
      { eventType: "STEP_FAILED", payload: { stepId: "b", error: "x", payload: T("nochannel") } },
    ]);
    expect(k?.origins).toEqual(["typed"]);
  });
  it("PARALLEL_COMPLETED.errorPayload only from a kernel-stamped envelope", () => {
    const p = { scopePath: "s", errorChannel: "c", errorPayload: T("par") };
    expect(
      origins([start(), { eventType: "PARALLEL_COMPLETED", payload: p, metadata: K }])?.origins
    ).toEqual(["par"]);
    expect(origins([start(), { eventType: "PARALLEL_COMPLETED", payload: p }])?.origins).toEqual(
      []
    );
  });
  it("MESSAGE_CONSUMED: kernel-stamped and not a duplicate; origin inbox:<topic> even when the payload is clean", () => {
    const mc = (id: string, payload: unknown, metadata?: Record<string, unknown>): Raw => ({
      eventType: "MESSAGE_CONSUMED",
      payload: { waitId: "w", topic: "orders", messageId: id, inboxSeq: 0, payload },
      ...(metadata && { metadata }),
    });
    expect(origins([start(), mc("m1", T("lineage:A"), K)])?.origins).toEqual([
      "inbox:orders",
      "lineage:A",
    ]);
    expect(origins([start(), mc("m1", "clean", K)])?.origins).toEqual(["inbox:orders"]);
    expect(origins([start(), mc("m1", T("lineage:A"))])?.origins).toEqual([]); // not kernel-written
    const dup = origins([start(), mc("m1", "clean", K), mc("m1", T("lineage:B"), K)]);
    expect(dup?.origins).toEqual(["inbox:orders"]); // duplicate delivered nothing
  });
  it("EXECUTION_RESUMED: positional payload, status-only null ignored, wait-addressed inner only when answered", () => {
    const park = (waits?: unknown): Raw => ({
      eventType: "EXECUTION_SUSPENDED",
      payload: { condition: { kind: "gate", on: "g", ...(waits !== undefined && { waits }) } },
      metadata: K,
    });
    expect(
      origins([start(), park(), { eventType: "EXECUTION_RESUMED", payload: T("human") }])?.origins
    ).toEqual(["human"]);
    expect(origins([start(), { eventType: "EXECUTION_RESUMED", payload: null }])?.origins).toEqual(
      []
    );
    const waits = [{ waitId: "w1", kind: "gate", on: "g" }];
    const addressed = (id: string) => ({
      eventType: "EXECUTION_RESUMED",
      payload: { waitId: id, payload: T(`ans-${id}`) },
      metadata: K,
    });
    const hit = origins([start(), park(waits), addressed("w1")]);
    expect(hit?.origins).toEqual(["ans-w1"]);
    expect(origins([start(), park(waits), addressed("nope")])?.origins).toEqual([]);
  });
  it("a non-channel event never records, even with a tainted payload", () => {
    expect(
      origins([start(), { eventType: "APP_EVENT", payload: { v: T("app") } }])?.origins
    ).toEqual([]);
  });
});

describe("bounds", () => {
  it("the maxOrigins+1th distinct origin sets sticky overflow and is dropped", () => {
    const small = { ...STAMP, maxOrigins: 2 };
    const { state } = commitAll([
      { eventType: "EXECUTION_STARTED", payload: { input: {}, seenOriginsLimits: small } },
      completed([T("a"), T("b")]),
      completed(T("c")),
      completed(T("a")),
    ]);
    const k = keyOf(state);
    expect(k?.origins).toEqual(["a", "b"]);
    expect(k?.overflow).toBe(true);
    expect(k?.through).toBe(3);
  });
  it("an exceeded scan records overflow ONLY and drops partial origins; no later scan once overflowed", () => {
    const tight = { maxOrigins: 64, maxScanNodes: 100 };
    const st0 = commitAll([
      { eventType: "EXECUTION_STARTED", payload: { input: {}, seenOriginsLimits: tight } },
    ]).state;
    const big = [T("partial"), ...Array.from({ length: 500 }, (_, i) => i)];
    expect(seenOriginsRecord(st0, "STEP_COMPLETED", { output: big }, undefined)).toEqual({
      originsOverflow: true,
    });
    const { state } = commitAll([completed(big), completed(T("after"))], st0, 1);
    expect(keyOf(state)).toMatchObject({ origins: [], overflow: true, through: 2 });
    expect(
      seenOriginsRecord(state, "STEP_COMPLETED", { output: T("x") }, undefined)
    ).toBeUndefined();
  });
  it("invalid recorded limits fall back to the defaults, per field", () => {
    const st = commitAll([
      {
        eventType: "EXECUTION_STARTED",
        payload: { input: {}, seenOriginsLimits: { maxOrigins: 0, maxScanNodes: 500 } },
      },
    ]).state;
    expect(keyOf(st)?.limits).toEqual({ maxOrigins: 64, maxScanNodes: 500 });
  });
  it("limits are read from the key (recorded at start), not from anything else, after a snapshot", () => {
    const small = { maxOrigins: 1, maxScanNodes: 100 };
    const a = commitAll([
      { eventType: "EXECUTION_STARTED", payload: { input: {}, seenOriginsLimits: small } },
      completed(T("a")),
    ]);
    const snap = JSON.parse(JSON.stringify(a.state)) as ExecutionState;
    const b = commitAll([completed(T("b"))], normalizeSnapshotState(snap), 2);
    expect(keyOf(b.state)).toMatchObject({ origins: ["a"], overflow: true, limits: small });
  });
});

describe("determinism: the recorded list is the source", () => {
  const raws: Raw[] = [
    start({}, { z: T("in:z"), a: T("in:a") }),
    completed({ y: T("o:y"), b: [T("o:b")], c: T("o:c") }),
    {
      eventType: "DECISION_RECORDED",
      payload: { decisionId: "d", choice: { q: T("c:q"), p: T("c:p") } },
    },
  ];
  const reverse = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(reverse);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v)
          .reverse()
          .map(([k, x]) => [k, reverse(x)])
      );
    }
    return v;
  };
  const live = commitAll(raws);
  it("live, replay from JSON, replay from a key-REVERSING store decorator and snapshot+tail fold to the same key", () => {
    const replayed = foldEvents(JSON.parse(JSON.stringify(live.log)));
    const reversed = foldEvents(live.log.map((e) => reverse(e) as EventEnvelope));
    const mid = foldEvents(live.log.slice(0, 2));
    const snap = normalizeSnapshotState(JSON.parse(JSON.stringify(mid)) as ExecutionState);
    const tail = foldEvents(live.log.slice(2), snap);
    const j = (s: ExecutionState) => JSON.stringify(keyOf(s));
    expect(j(replayed)).toBe(j(live.state));
    expect(j(reversed)).toBe(j(live.state));
    expect(j(tail)).toBe(j(live.state));
    expect(keyOf(live.state)?.origins).toEqual(["in:a", "in:z", "o:b", "o:c", "o:y", "c:p", "c:q"]);
  });
  it("a commit-time record equals the rescan record of the same event after JSON key reversal", () => {
    const before = foldEvents(live.log.slice(0, 1));
    for (const e of live.log.slice(1)) {
      const a = seenOriginsRecord(before, e.eventType, e.payload, undefined);
      const b = seenOriginsRecord(before, e.eventType, reverse(e.payload), undefined);
      expect(b).toEqual(a);
    }
  });
});

describe("trust: the record is the kernel's alone", () => {
  it("the fold honours a record only on channel events of a tracked run; a payload key named origins is data", () => {
    const st = commitAll([start()]).state;
    const forgedApp = foldEvents(
      [env(1, { eventType: "APP_EVENT", payload: {} }, { origins: ["f"] })],
      st
    );
    expect(keyOf(forgedApp)?.origins).toEqual([]);
    const payloadKey = foldEvents([env(1, completed({ origins: ["f"] }), undefined)], st);
    expect(keyOf(payloadKey)?.origins).toEqual([]);
    const junk = foldEvents([env(1, completed(1), { origins: [1, null, "ok"] })], st);
    expect(keyOf(junk)?.overflow).toBe(true); // M-B: a junk entry is overflow, not dropped
  });
});

describe("R13 I-1: the commit walk is over the LIVE structure (the flow is handed the live object)", () => {
  const st = () => commitAll([start()]).state;
  const rec = (output: unknown) =>
    seenOriginsRecord(st(), "STEP_COMPLETED", { stepId: "s", output }, undefined);
  /** each shape reaches the flow; the JSON-view walk (the pre-R13 commit walk) sees NOTHING in it */
  const hidden: Array<[string, () => unknown]> = [
    ["a Map holding a wrapper", () => new Map([["r", T("x")]])],
    ["a Map KEY that is a wrapper", () => new Map([[T("x"), 1]])],
    ["a Set holding a wrapper", () => new Set([T("x")])],
    ["a field a toJSON hides", () => ({ secret: T("x"), toJSON: () => ({}) })],
    ["a wrapper that has a toJSON", () => ({ ...T("x"), toJSON: () => "scrubbed" })],
    [
      "a non-enumerable tainted property",
      () => Object.defineProperty({}, "secret", { value: T("x"), enumerable: false }),
    ],
    [
      "a wrapper whose value is inherited",
      () => Object.assign(Object.create({ value: 1 }), { __loomTainted: { origin: "x" } }),
    ],
    [
      "a getter returning a wrapper",
      () => ({
        get secret() {
          return T("x");
        },
      }),
    ],
    ["a symbol-keyed wrapper", () => ({ [Symbol("k")]: T("x") })],
    [
      "a class instance holding a wrapper",
      () =>
        new (class C {
          f = T("x");
        })(),
    ],
  ];
  it.each(hidden)("%s: the live walk records x or fails closed", (n, mk) => {
    // the pre-R13 commit walk (the JSON view) misses all but the accessor and the class instance, which JSON sees
    // but the live walk refuses to walk unfaithfully
    const old = scanSeenOriginsJson(mk(), 1000);
    if (!/getter|class instance/.test(n))
      expect(old === undefined || !old.includes("x")).toBe(true);
    const r = rec(mk());
    expect(r?.origins?.includes("x") === true || r?.originsOverflow === true).toBe(true);
  });
  it("walks faithfully what it can: Map/Set entries record their origins exactly (no overflow)", () => {
    expect(rec(new Map([["r", T("x")]]))).toEqual({ origins: ["x"] });
    expect(rec({ a: new Set([T("y")]), b: new Map([[T("z"), T("w")]]) })).toEqual({
      origins: ["w", "y", "z"],
    });
  });
  it("uses classify's isTainted predicate: value may be undefined, the mark may carry extras, a non-string origin is not a wrapper", () => {
    expect(rec({ __loomTainted: { origin: "a", extra: 1 }, value: undefined })).toEqual({
      origins: ["a"],
    });
    expect(rec({ __loomTainted: { origin: 5 }, value: 1 })).toEqual({ origins: [] });
    expect(rec({ __loomTainted: { origin: "a" } })).toEqual({ origins: [] }); // no value key
  });
  it("M-A: a Date with ANY own key records overflow; a plain Date is still a leaf", () => {
    expect(rec(Object.assign(new Date(0), { x: T("dateprop") }))).toEqual({
      originsOverflow: true,
    });
    expect(
      rec(Object.defineProperty(new Date(0), "h", { value: T("hidden"), enumerable: false }))
    ).toEqual({ originsOverflow: true });
    expect(rec({ d: new Date(0) })).toEqual({ origins: [] });
  });
  it("Date is a leaf; ArrayBuffer and typed-array views are skipped (as scanTaint does), not overflow", () => {
    expect(
      rec({ d: new Date(0), b: new Uint8Array(4), ab: new ArrayBuffer(8), buf: Buffer.from("x") })
    ).toEqual({ origins: [] });
  });
  it("a toJSON other than Date's, a cycle, and plain data with a null prototype behave as specified", () => {
    expect(rec({ toJSON: () => 1 })).toEqual({ originsOverflow: true });
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(rec(cyc)).toEqual({ originsOverflow: true });
    expect(rec(Object.assign(Object.create(null), { v: T("n") }))).toEqual({ origins: ["n"] });
  });
  it("the commit walk and the JSON rescan agree on plain JSON data", () => {
    const plain = JSON.parse(JSON.stringify({ a: [T("p"), { b: T("q") }], c: T("r") }));
    const before = st();
    const live = seenOriginsRecord(before, "STEP_COMPLETED", { output: plain }, undefined, "live");
    const json = seenOriginsRecord(before, "STEP_COMPLETED", { output: plain }, undefined, "json");
    expect(live).toEqual(json);
    expect(live).toEqual({ origins: ["p", "q", "r"] });
  });
  it("depth: exactly 64 is walked, 65 is not (both walks)", () => {
    const nest = (n: number) => {
      let v: unknown = T("z");
      for (let i = 0; i < n; i++) v = { c: v };
      return v;
    };
    // the wrapper is itself a node: root depth 0, wrapper at depth n, its mark at n + 1 (the deepest node)
    for (const w of [scanSeenOriginsLive, scanSeenOriginsJson]) {
      expect(w(nest(63), 100_000)).toEqual(["z"]); // deepest node (the mark) at depth 64
      expect(w(nest(64), 100_000)).toBeUndefined(); // depth 65
    }
  });
});

describe("record bounds and encoding (m-1, m-3, m-8)", () => {
  const tracked = (limits = STAMP) =>
    commitAll([
      { eventType: "EXECUTION_STARTED", payload: { input: {}, seenOriginsLimits: limits } },
    ]).state;
  it("m-1: more than maxOrigins distinct origins on ONE event records overflow, not an oversized list", () => {
    const st = tracked({ maxOrigins: 3, maxScanNodes: 10_000 });
    expect(
      seenOriginsRecord(st, "STEP_COMPLETED", { output: [T("a"), T("b"), T("c")] }, undefined)
    ).toEqual({ origins: ["a", "b", "c"] });
    expect(
      seenOriginsRecord(
        st,
        "STEP_COMPLETED",
        { output: [T("a"), T("b"), T("c"), T("d")] },
        undefined
      )
    ).toEqual({ originsOverflow: true });
  });
  it("m-3: the inbox:<topic> origin is capped like every other origin", () => {
    const st = tracked();
    const topic = "t".repeat(300);
    const r = seenOriginsRecord(
      st,
      "MESSAGE_CONSUMED",
      { waitId: "w", topic, messageId: "m", inboxSeq: 0, payload: 1 },
      K
    );
    expect(r?.origins).toHaveLength(1);
    expect(r?.origins?.[0]).toMatch(/^unknown:truncated:[0-9a-f]{16}$/);
  });
  it("m-8: truncation boundary 256 vs 257 characters, and the fnv1a-64-over-UTF-8 vector", () => {
    expect(scanSeenOriginsJson(T("a".repeat(256)), 100)).toEqual(["a".repeat(256)]);
    expect(scanSeenOriginsJson(T("a".repeat(257)), 100)?.[0]).toMatch(
      /^unknown:truncated:[0-9a-f]{16}$/
    );
    // a fixed vector pins the digest AND its encoding (UTF-8 bytes, not UTF-16 code units)
    expect(scanSeenOriginsJson(T(`${"é".repeat(200)}${"日本".repeat(30)}`), 100)).toEqual([
      "unknown:truncated:37530dfe9c4f33ad",
    ]);
  });
});
