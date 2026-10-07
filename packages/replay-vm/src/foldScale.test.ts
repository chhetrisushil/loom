import type { EventEnvelope, ExecutionState } from "@loom/core";
import { describe, expect, it } from "vitest";
import { ReplayVM } from "./ReplayVM";
import { foldEvents } from "./foldEvents";

// R1a — the fold must stay O(n) in the number of events, whether the events arrive in one batch
// (replay) or one at a time (live commits), and the in-place fast paths must never reach a
// state object a caller holds.

const ID = { executionId: "x", workflowId: "wf", workflowVersion: "1.0.0" };

function ev(
  sequence: number,
  eventType: string,
  payload: unknown,
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

// biome-ignore lint/suspicious/noExplicitAny: the reference fold reads untyped event JSON
type J = any;

// ── a seeded PRNG, so a failure reproduces ───────────────────────────────────
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randomStream(seed: number, n: number): EventEnvelope[] {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const out: EventEnvelope[] = [ev(0, "EXECUTION_STARTED", { input: { seed }, flowHash: "h" })];
  let parked = false;
  for (let i = 1; i < n; i++) {
    const kind = pick([
      "decision",
      "decision",
      "decision", // overwrite ids too: ids are drawn from a small pool
      "stepStart",
      "stepDone",
      "stepFail",
      "suspend",
      "resume",
      "metered",
      "outcome",
      "timer",
      "emit",
      "parallel",
      "audit",
    ]);
    switch (kind) {
      case "decision":
        out.push(
          ev(i, "DECISION_RECORDED", {
            decisionId: `d${Math.floor(r() * 25)}`,
            choice: i,
            ...(r() < 0.4 && { rationale: `r${i}` }),
            ...(r() < 0.3 && { policy: { id: "p", version: "1", propensity: 0.5 } }),
          })
        );
        break;
      case "stepStart":
        out.push(ev(i, "STEP_STARTED", { stepId: `s${Math.floor(r() * 12)}`, input: { i } }));
        break;
      case "stepDone":
        out.push(ev(i, "STEP_COMPLETED", { stepId: `s${Math.floor(r() * 12)}`, output: i }));
        break;
      case "stepFail":
        out.push(ev(i, "STEP_FAILED", { stepId: `s${Math.floor(r() * 12)}`, error: "boom" }));
        break;
      case "suspend":
        out.push(ev(i, "EXECUTION_SUSPENDED", { condition: { on: "gate" } }));
        parked = true;
        break;
      case "resume":
        out.push(ev(i, "EXECUTION_RESUMED", parked ? { answer: i } : null));
        parked = false;
        break;
      case "metered":
        out.push(
          ev(i, "RESOURCE_METERED", {
            tokens: Math.floor(r() * 100),
            costUsd: r(),
            ...(r() < 0.3 && { memBytes: 7 }),
          })
        );
        break;
      case "outcome":
        out.push(ev(i, "OUTCOME_RECORDED", { key: `k${i % 5}`, success: r() < 0.5 }));
        break;
      case "timer":
        out.push(ev(i, "TIMER_FIRED", { wakeAt: i }));
        break;
      case "emit": {
        const digest = Array.from(
          { length: 16 },
          () => "0123456789abcdef"[Math.floor(r() * 4)]
        ).join("");
        out.push(ev(i, "domain.thing", { i }, { flowEmit: digest }));
        break;
      }
      case "parallel":
        out.push(ev(i, "PARALLEL_STARTED", { stepIds: ["pa", "pb", `s${Math.floor(r() * 12)}`] }));
        break;
      default:
        out.push(ev(i, "QUOTA_EXCEEDED", { reason: "q" }));
    }
  }
  return out;
}

/**
 * The reference fold: the plain immutable reading of the same rules — every event copies every
 * container it touches, nothing is ever written in place and nothing is shared between events.
 * It is deliberately independent of eventHandlers.ts (that file is what is being optimised), and
 * covers every event type `randomStream` can emit.
 */
function referenceFold(events: EventEnvelope[]): ExecutionState {
  let st: ExecutionState = {
    ...ID,
    status: "pending",
    frames: {},
    variables: {},
    sequence: -1,
    startedAt: 0,
    updatedAt: 0,
  };
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  for (const e of events) {
    const p = e.payload as J;
    const vars: J = clone(st.variables);
    const frames: J = clone(st.frames);
    let status = st.status;
    let suspendedOn: J = (st as J).suspendedOn;
    let startedAt = st.startedAt;
    switch (e.eventType) {
      case "EXECUTION_STARTED":
        status = "running";
        startedAt = e.timestamp;
        vars._input = p.input;
        vars._flowHash = p.flowHash;
        break;
      case "STEP_STARTED": {
        const old = frames[p.stepId];
        frames[p.stepId] = {
          stepId: p.stepId,
          ...((old === undefined ? e.sequence : old.firstSeq) !== undefined && {
            firstSeq: old === undefined ? e.sequence : old.firstSeq, // ADR 0113 D3: the log's first-start order
          }),
          status: "running",
          attempts: (old?.attempts ?? 0) + 1,
          startedAt: e.timestamp,
          firstStartedAt: old?.firstStartedAt ?? old?.startedAt ?? e.timestamp,
          ...(p.input !== undefined && { input: p.input }),
        };
        break;
      }
      case "STEP_COMPLETED": {
        const old = frames[p.stepId];
        frames[p.stepId] = {
          stepId: p.stepId,
          status: "completed",
          attempts: old?.attempts ?? 1,
          completedAt: e.timestamp,
          ...(old?.startedAt !== undefined && { startedAt: old.startedAt }),
          ...(old?.firstStartedAt !== undefined && { firstStartedAt: old.firstStartedAt }),
          ...(old?.firstSeq !== undefined && { firstSeq: old.firstSeq }),
          ...(old?.input !== undefined && { input: old.input }),
          ...(p.output !== undefined && { output: p.output }),
        };
        break;
      }
      case "STEP_FAILED": {
        const old = frames[p.stepId];
        frames[p.stepId] = {
          stepId: p.stepId,
          status: "failed",
          attempts: old?.attempts ?? 1,
          ...(old?.startedAt !== undefined && { startedAt: old.startedAt }),
          ...(old?.firstStartedAt !== undefined && { firstStartedAt: old.firstStartedAt }),
          ...(old?.firstSeq !== undefined && { firstSeq: old.firstSeq }),
          ...(old?.input !== undefined && { input: old.input }),
          ...(p.error !== undefined && { error: p.error }),
        };
        if (st.status === "suspended" && vars._failedWhileParked !== true) {
          vars._failedWhileParked = true;
        }
        break;
      }
      case "PARALLEL_STARTED":
        for (const id of p.stepIds) {
          frames[id] = { stepId: id, status: "pending", attempts: 0, startedAt: e.timestamp };
        }
        break;
      case "EXECUTION_SUSPENDED":
        status = "suspended";
        suspendedOn = p.condition;
        vars._failedWhileParked = undefined;
        break;
      case "EXECUTION_RESUMED": {
        const statusOnly =
          e.payload === null &&
          (st.status !== "suspended" ||
            suspendedOn?.on === "EffectInDoubtResolved" ||
            vars._failedWhileParked === true);
        vars._failedWhileParked = undefined;
        suspendedOn = undefined;
        status = "running";
        if (e.payload !== undefined && !statusOnly) {
          vars._resumePayload = e.payload;
          vars._resumePayloads = [...(vars._resumePayloads ?? []), e.payload];
        }
        break;
      }
      case "DECISION_RECORDED":
        vars._decisions = {
          ...(vars._decisions ?? {}),
          [p.decisionId]: {
            choice: p.choice,
            ...(p.rationale !== undefined && { rationale: p.rationale }),
            ...(p.policy !== undefined && { policy: p.policy }),
          },
        };
        break;
      case "RESOURCE_METERED": {
        const r = vars._resources ?? { tokens: 0, costUsd: 0, ms: 0, count: 0 };
        const memBytes = (r.memBytes ?? 0) + (p.memBytes ?? 0);
        vars._resources = {
          tokens: r.tokens + (p.tokens ?? 0),
          costUsd: r.costUsd + (p.costUsd ?? 0),
          ms: r.ms + (p.ms ?? 0),
          count: r.count + 1,
          ...(memBytes > 0 && { memBytes }),
          ...(r.exceeded === true && { exceeded: true }),
        };
        break;
      }
      case "QUOTA_EXCEEDED": {
        const r = vars._resources ?? { tokens: 0, costUsd: 0, ms: 0, count: 0 };
        vars._resources = { ...r, exceeded: true, reason: p.reason };
        break;
      }
      case "OUTCOME_RECORDED":
        vars._outcomes = [
          ...(vars._outcomes ?? []),
          { key: p.key, ...(p.success !== undefined && { success: p.success }) },
        ];
        break;
      case "TIMER_FIRED":
        vars._timers = [...(vars._timers ?? []), { firedAt: e.timestamp, wakeAt: p.wakeAt }];
        break;
      default:
        break;
    }
    const stamp = e.metadata?.flowEmit as string | undefined;
    if (typeof stamp === "string" && /^[0-9a-f]{16}$/.test(stamp)) {
      // The trie is a representation; the reference counts per digest in a flat map and the
      // comparison below flattens the fold's trie the same way.
      const flat: Record<string, number> = vars.__flatEmits ?? {};
      flat[stamp] = (flat[stamp] ?? 0) + 1;
      vars.__flatEmits = flat;
    }
    const next: J = { ...st, status, frames, variables: vars, startedAt, sequence: e.sequence };
    next.suspendedOn = suspendedOn;
    // every handled type stamps updatedAt; the unhandled domain emit leaves it alone
    if (e.eventType !== "domain.thing") next.updatedAt = e.timestamp;
    st = next;
  }
  return st;
}

/** Flatten the `_flowEmits` trie into `{digest: count}` so it can be compared to the reference. */
function normalise(state: ExecutionState): unknown {
  const s = JSON.parse(JSON.stringify(state)) as ExecutionState;
  const flat: Record<string, number> = {};
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) for (const c of n) walk(c);
    else if (n !== null && typeof n === "object") Object.assign(flat, n);
  };
  const trie = (s.variables as Record<string, unknown>)._flowEmits;
  if (trie !== undefined) {
    walk(trie);
    (s.variables as Record<string, unknown>).__flatEmits = flat;
    (s.variables as Record<string, unknown>)._flowEmits = undefined;
  }
  return JSON.parse(JSON.stringify(s));
}

/** Byte-identity between two real folds (same representation, so no flattening). */
const bytes = (s: ExecutionState): string => JSON.stringify(s);

describe("fold equality: bulk, event-at-a-time and live all agree (R1a)", () => {
  const SEEDS = [1, 2, 3, 7, 11, 42, 99, 12345];

  for (const seed of SEEDS) {
    it(`seed ${seed}: bulk fold, per-event fold and ReplayVM.applyEvent are byte-identical`, () => {
      const events = randomStream(seed, 400);
      const bulk = foldEvents(events, ID);

      // one foldEvents call per event: no ownership survives between calls, i.e. exactly
      // the copy-everything path the live commit used before
      let stepwise = foldEvents([], ID);
      for (const e of events) stepwise = foldEvents([e], stepwise);

      const vm = new ReplayVM([], ID);
      for (const e of events) vm.applyEvent(e);

      expect(bytes(stepwise)).toBe(bytes(bulk));
      expect(bytes(vm.getState())).toBe(bytes(bulk));
      // and against the independent reference
      expect(normalise(bulk)).toEqual(normalise(referenceFold(events)));
    });

    it(`seed ${seed}: snapshot at a random point + tail folds to the same state`, () => {
      const events = randomStream(seed, 400);
      const full = foldEvents(events, ID);
      const cut = 50 + (seed % 300);
      const snap = JSON.parse(JSON.stringify(foldEvents(events.slice(0, cut), ID)));
      const resumed = new ReplayVM(events.slice(cut), snap);
      expect(bytes(resumed.getState())).toBe(bytes(full));
    });

    it(`seed ${seed}: escaping the state at random points never changes the answer`, () => {
      const events = randomStream(seed, 400);
      const full = foldEvents(events, ID);
      const r = rng(seed + 1000);
      const vm = new ReplayVM([], ID);
      for (const e of events) {
        vm.applyEvent(e);
        if (r() < 0.2) vm.getState();
      }
      expect(bytes(vm.getState())).toBe(bytes(full));
    });
  }
});

// ── every handled event type, in random order ────────────────────────────────
// `randomStream` is the one the independent reference fold understands. This generator covers
// EVERY type the fold handles (denials, in-doubt, migration, approval, rehoming, shredding,
// typed failures, retries, cancellations, terminals, unknown types) in an order that makes no
// sense on purpose: the fold must be a pure function of the event sequence, so the in-place
// fast paths must agree byte-for-byte with the copying path whatever arrives.
function allTypesStream(seed: number, n: number): EventEnvelope[] {
  const r = rng(seed);
  const step = (): string => `s${Math.floor(r() * 8)}`;
  const payloads: Record<string, () => unknown> = {
    STEP_STARTED: () => ({ stepId: step(), input: { a: 1 } }),
    STEP_COMPLETED: () => ({ stepId: step(), output: 1 }),
    STEP_FAILED: () => ({
      stepId: step(),
      error: "e",
      ...(r() < 0.5 && { channel: "c", payload: { x: 1 } }),
    }),
    STEP_CANCELLED: () => ({ stepId: step() }),
    STEP_RETRYING: () => ({ stepId: step(), attempt: 2 }),
    PARALLEL_STARTED: () => ({ stepIds: ["pa", step()] }),
    PARALLEL_COMPLETED: () => ({}),
    EXECUTION_SUSPENDED: () => ({
      condition: { on: r() < 0.3 ? "EffectInDoubtResolved" : "g" },
    }),
    EXECUTION_RESUMED: () => (r() < 0.3 ? null : { a: r() }),
    DECISION_RECORDED: () => ({ decisionId: `d${Math.floor(r() * 10)}`, choice: r() }),
    EFFECT_DENIED: () => ({ stepId: "s1", toolId: "t", reason: "x" }),
    EXECUTION_DENIED: () => ({ op: "resume", reason: "x" }),
    EXECUTION_ARCHIVED: () => ({ executionId: "x" }),
    EXECUTION_DELETED: () => ({ executionId: "x" }),
    EVENTS_REHOMED: () => ({ executionId: "x", fromSequence: 1, throughSequence: 2, proof: "p" }),
    ERASURE_PENDING: () => ({ subjectId: "u" }),
    OUTCOME_RECORDED: () => ({ key: "k", success: true }),
    SAFETY_BLOCKED: () => ({ validatorId: "v" }),
    EFFECT_INDOUBT: () => ({ stepId: "s1", attempts: 1 }),
    EXECUTION_MIGRATED: () => ({ toFlowId: "f2", toHash: "h" }),
    APPROVAL_GRANTED: () => ({ actor: "a" }),
    PAYLOAD_SHREDDED: () => ({ subjectId: "u" }),
    EGRESS_DENIED: () => ({ target: "t" }),
    TIMER_FIRED: () => ({ wakeAt: 1 }),
    RESOURCE_METERED: () => ({ tokens: 3, costUsd: 0.1 }),
    QUOTA_EXCEEDED: () => ({ reason: "q" }),
    EXECUTION_COMPLETED: () => ({ output: 1 }),
    EXECUTION_FAILED: () => ({ error: "e" }),
    EXECUTION_CANCELLED: () => ({ reason: "c" }),
    "domain.x": () => ({ i: 1 }),
  };
  const types = Object.keys(payloads);
  const out: EventEnvelope[] = [ev(0, "EXECUTION_STARTED", { input: {}, flowHash: "h" })];
  for (let i = 1; i < n; i++) {
    const t = types[Math.floor(r() * types.length)] as string;
    const stamp =
      r() < 0.2
        ? {
            flowEmit: Array.from(
              { length: 16 },
              () => "0123456789abcdef"[Math.floor(r() * 3)]
            ).join(""),
          }
        : undefined;
    out.push(ev(i, t, (payloads[t] as () => unknown)(), stamp));
  }
  return out;
}

describe("fold equality over EVERY handled event type (R1a)", () => {
  for (const seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]) {
    it(`seed ${seed}: bulk, per-event, live, snapshot+tail and escaped states are byte-identical`, () => {
      const events = allTypesStream(seed, 500);
      const bulk = bytes(foldEvents(events, ID));

      let stepwise = foldEvents([], ID);
      for (const e of events) stepwise = foldEvents([e], stepwise);
      expect(bytes(stepwise)).toBe(bulk);

      const r = rng(seed + 7);
      const cut = Math.floor(r() * events.length);
      const vm = new ReplayVM([], ID);
      const held: Array<[ExecutionState, string]> = [];
      let tailVm: ReplayVM | undefined;
      events.forEach((e, i) => {
        vm.applyEvent(e);
        if (r() < 0.1) {
          const st = vm.getState();
          held.push([st, bytes(st)]);
        }
        if (i === cut) {
          tailVm = new ReplayVM(events.slice(cut + 1), JSON.parse(bytes(vm.getState())));
        }
      });
      expect(bytes(vm.getState())).toBe(bulk);
      expect(bytes((tailVm as ReplayVM).getState())).toBe(bulk);
      // a state handed out earlier was never mutated by a later event
      for (const [st, snapshotBytes] of held) expect(bytes(st)).toBe(snapshotBytes);
    });
  }
});

describe("no caller-visible mutation (R1a)", () => {
  it("a state handed out by getState() is frozen in time while the VM keeps folding", () => {
    const events = randomStream(5, 600);
    const vm = new ReplayVM([], ID);
    const held: Array<{ state: ExecutionState; json: string }> = [];
    events.forEach((e, i) => {
      vm.applyEvent(e);
      if (i % 37 === 0) {
        const state = vm.getState();
        held.push({ state, json: JSON.stringify(state) });
      }
    });
    expect(held.length).toBeGreaterThan(10);
    for (const h of held) expect(JSON.stringify(h.state)).toBe(h.json);
  });

  it("holds for the individual containers too (frames, _decisions, audit lists, _flowEmits)", () => {
    const vm = new ReplayVM([], ID);
    // build up some state, with every container kind present, then escape it
    const seed = randomStream(9, 300);
    for (const e of seed) vm.applyEvent(e);
    const held = vm.getState();
    const frames = held.frames;
    const decisions = held.variables._decisions as Record<string, unknown>;
    const outcomes = held.variables._outcomes as unknown[];
    const resumes = held.variables._resumePayloads as unknown[] | undefined;
    const trie = held.variables._flowEmits;
    const before = JSON.stringify({ frames, decisions, outcomes, resumes, trie });
    const framesN = Object.keys(frames).length;
    const decisionsN = Object.keys(decisions).length;
    const outcomesN = outcomes.length;

    // more of everything, including brand-new keys
    let seq = 1000;
    for (let i = 0; i < 200; i++) {
      vm.applyEvent(ev(seq++, "DECISION_RECORDED", { decisionId: `new${i}`, choice: i }));
      vm.applyEvent(ev(seq++, "STEP_COMPLETED", { stepId: `new-step${i}`, output: i }));
      vm.applyEvent(ev(seq++, "OUTCOME_RECORDED", { key: `n${i}` }));
      vm.applyEvent(ev(seq++, "EXECUTION_SUSPENDED", { condition: { on: "g" } }));
      vm.applyEvent(ev(seq++, "EXECUTION_RESUMED", { i }));
      vm.applyEvent(ev(seq++, "domain.thing", {}, { flowEmit: "00000000000000a1" }));
    }
    expect(JSON.stringify({ frames, decisions, outcomes, resumes, trie })).toBe(before);
    expect(Object.keys(frames).length).toBe(framesN);
    expect(Object.keys(decisions).length).toBe(decisionsN);
    expect(outcomes.length).toBe(outcomesN);
    // the live state did move
    expect(Object.keys(vm.getState().variables._decisions as object).length).toBe(decisionsN + 200);
  });

  it("a seed (snapshot) state passed in is never mutated by live folding", () => {
    const seedState = foldEvents(randomStream(3, 200), ID);
    const before = JSON.stringify(seedState);
    const vm = new ReplayVM([], seedState);
    for (let i = 0; i < 100; i++) {
      vm.applyEvent(ev(500 + i, "DECISION_RECORDED", { decisionId: `z${i}`, choice: i }));
      vm.applyEvent(ev(700 + i, "STEP_COMPLETED", { stepId: `zs${i}`, output: i }));
    }
    expect(JSON.stringify(seedState)).toBe(before);
  });

  it("a state returned by foldEvents is not mutated when it seeds a later fold", () => {
    const s1 = foldEvents(randomStream(4, 200), ID);
    const before = JSON.stringify(s1);
    foldEvents(
      [
        ev(900, "DECISION_RECORDED", { decisionId: "q", choice: 1 }),
        ev(901, "DECISION_RECORDED", { decisionId: "q2", choice: 2 }),
      ],
      s1
    );
    expect(JSON.stringify(s1)).toBe(before);
  });

  it("two VMs seeded from the same state do not see each other's writes", () => {
    const base = foldEvents(randomStream(6, 100), ID);
    const a = new ReplayVM([], base);
    const b = new ReplayVM([], base);
    for (let i = 0; i < 20; i++) {
      a.applyEvent(ev(500 + i, "DECISION_RECORDED", { decisionId: `a${i}`, choice: i }));
      b.applyEvent(ev(500 + i, "DECISION_RECORDED", { decisionId: `b${i}`, choice: i }));
    }
    expect(a.hasDecision("b0")).toBe(false);
    expect(b.hasDecision("a0")).toBe(false);
    expect(a.hasDecision("a19")).toBe(true);
    expect(b.hasDecision("b19")).toBe(true);
  });
});

// ── scale ────────────────────────────────────────────────────────────────────

const best = (runs: number, fn: () => void): number => {
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    min = Math.min(min, performance.now() - t);
  }
  return min;
};

function decisionEvents(n: number): EventEnvelope[] {
  const evs = [ev(0, "EXECUTION_STARTED", { input: {} })];
  for (let i = 1; i <= n; i++)
    evs.push(ev(i, "DECISION_RECORDED", { decisionId: `d${i}`, choice: i }));
  return evs;
}
function stepEvents(n: number): EventEnvelope[] {
  const evs = [ev(0, "EXECUTION_STARTED", { input: {} })];
  for (let i = 1; i <= n; i++) evs.push(ev(i, "STEP_COMPLETED", { stepId: `s${i}`, output: i }));
  return evs;
}

describe(
  "fold scales linearly (R1a perf regression; generous bounds)",
  { timeout: 180_000 },
  () => {
    // Before the fix: 5k/10k/20k decisions folded in 2.3s/10s/42s. After: single-digit ms.
    it("folds 20k decisions in a bounded time and within a small factor of 20k steps", () => {
      const d = decisionEvents(20_000);
      const s = stepEvents(20_000);
      const tDecisions = best(2, () => foldEvents(d, ID));
      const tSteps = best(2, () => foldEvents(s, ID));
      expect(tDecisions).toBeLessThan(3000); // was ~42 000 ms
      // the plan's acceptance bound is 5x; a floor keeps a 5 ms baseline from flaking
      expect(tDecisions).toBeLessThan(Math.max(tSteps * 5, 150));
    });

    it("decision fold is O(n): 4x the events costs far less than 16x", () => {
      const small = decisionEvents(5_000);
      const large = decisionEvents(20_000);
      const t5 = Math.max(
        best(3, () => foldEvents(small, ID)),
        5
      );
      const t20 = best(3, () => foldEvents(large, ID));
      expect(t20 / t5).toBeLessThan(10); // O(n^2) gives 16x; O(n) gives ~4x
    });

    it("live commits are linear: 20k applyEvent costs well under 16x of 5k", () => {
      const run = (n: number): number =>
        best(2, () => {
          const vm = new ReplayVM([], ID);
          for (const e of stepEvents(n)) vm.applyEvent(e);
        });
      const t5 = Math.max(run(5_000), 5);
      const t20 = run(20_000);
      expect(t20).toBeLessThan(5_000); // was ~42 000 ms for 20k
      expect(t20 / t5).toBeLessThan(10);
    });

    it("live decisions are linear too", () => {
      const run = (n: number): number =>
        best(2, () => {
          const vm = new ReplayVM([], ID);
          for (const e of decisionEvents(n)) vm.applyEvent(e);
        });
      const t5 = Math.max(run(5_000), 5);
      const t20 = run(20_000);
      expect(t20).toBeLessThan(5_000);
      expect(t20 / t5).toBeLessThan(10);
    });

    it("an escape every k events costs one copy per escape, not per event", () => {
      const evs = stepEvents(20_000);
      const t = best(1, () => {
        const vm = new ReplayVM([], ID);
        evs.forEach((e, i) => {
          vm.applyEvent(e);
          if (i % 1000 === 0) vm.getState(); // e.g. the snapshot cadence
        });
      });
      expect(t).toBeLessThan(5_000);
    });
  }
);
