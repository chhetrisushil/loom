import type { EventEnvelope } from "@loom/core";
import { foldEvents } from "@loom/replay-vm";

// ── T2.3 — language-agnostic fold conformance vectors ─────────────────────────
//
// The event log is the kernel's on-disk ABI (K5): state = fold(events). These
// vectors are the EXECUTABLE, language-agnostic conformance suite the amendment
// requires — event-log fixtures in, expected folds out. Any client
// implementation (in any language) can load `FOLD_VECTORS` as plain JSON, run
// its own fold, and assert equality; the TS reference below is one such runner.
// This extends the K1/K5 pins from "the fold understands these types" to "the
// fold produces exactly this state for this log".

export interface FoldVector {
  name: string;
  events: EventEnvelope[];
  /** The expected `fold(events)` — compared field-by-field (JSON-equal). */
  expected: {
    status: string;
    sequence: number;
    variables: Record<string, unknown>;
    frames: Record<string, { status: string; attempts: number }>;
  };
}

function ev(
  executionId: string,
  sequence: number,
  eventType: string,
  payload: unknown,
  metadata?: Record<string, unknown>
): EventEnvelope {
  return {
    id: `${executionId}-${sequence}`,
    workflowId: "wf",
    executionId,
    eventType,
    sequence,
    timestamp: 1000 + sequence,
    payload,
    ...(metadata !== undefined && { metadata }),
  };
}

/**
 * The canonical vectors. Deliberately covers the core lifecycle plus a
 * representative kernel-ring fact, so a foreign fold that mishandles any of them
 * fails loudly. Extend (never repurpose) alongside the K5 schema.
 */
export const FOLD_VECTORS: FoldVector[] = [
  {
    name: "start → step → complete",
    events: [
      ev("v1", 0, "EXECUTION_STARTED", { input: { n: 1 } }),
      ev("v1", 1, "STEP_STARTED", { stepId: "a", input: { n: 1 } }),
      ev("v1", 2, "STEP_COMPLETED", { stepId: "a", output: { n: 2 } }),
      ev("v1", 3, "EXECUTION_COMPLETED", { output: { n: 2 } }),
    ],
    expected: {
      status: "completed",
      sequence: 3,
      variables: { _input: { n: 1 }, _output: { n: 2 } },
      frames: { a: { status: "completed", attempts: 1 } },
    },
  },
  {
    name: "suspend leaves a running frame + suspended status",
    events: [
      ev("v2", 0, "EXECUTION_STARTED", { input: {} }),
      ev("v2", 1, "STEP_STARTED", { stepId: "gate", input: {} }),
      ev("v2", 2, "EXECUTION_SUSPENDED", { condition: { on: "Approval" } }),
    ],
    expected: {
      status: "suspended",
      sequence: 2,
      variables: { _input: {} },
      frames: { gate: { status: "running", attempts: 1 } },
    },
  },
  {
    name: "a metered + denied ring log folds its audit facts",
    events: [
      ev("v3", 0, "EXECUTION_STARTED", { input: {} }),
      ev("v3", 1, "RESOURCE_METERED", { tokens: 100, costUsd: 0.5, ms: 10 }),
      ev("v3", 2, "EFFECT_DENIED", { toolId: "delete-prod", reason: "not granted" }),
    ],
    expected: {
      status: "running",
      sequence: 2,
      variables: {
        _input: {},
        _resources: { tokens: 100, costUsd: 0.5, ms: 10, count: 1 },
        _denials: [{ toolId: "delete-prod", reason: "not granted" }],
      },
      frames: {},
    },
  },
  {
    // 1.19.0 (ADR 0102) — the one fold step keyed on an envelope stamp, not a type:
    // `metadata.flowEmit` (a 16-hex content digest) on ANY event type — here a domain
    // event and SURFACE_PATCH, neither of which has a handler — is counted per digest in
    // a 16-way trie of 16-slot arrays over the digest's last three hex digits. An unstamped event (a legacy log's emit, or one
    // appended while an effect was in flight) counts nothing.
    name: "stamped flow-level emits are counted per content digest; unstamped ones are not",
    events: [
      ev("v4", 0, "EXECUTION_STARTED", { input: {} }),
      ev("v4", 1, "response.committed", { msg: "m1" }, { flowEmit: "0123456789abcdef" }),
      ev("v4", 2, "SURFACE_PATCH", { patches: [] }, { flowEmit: "ffffffffffffffef", fence: 2 }),
      ev("v4", 3, "response.committed", { msg: "m1" }, { flowEmit: "0123456789abcdef" }),
      ev("v4", 4, "legacy.domain", {}),
    ],
    expected: {
      status: "running",
      sequence: 4,
      variables: {
        _input: {},
        // 16-slot arrays indexed by the digest's last three hex digits (f, e, then d / f).
        _flowEmits: [
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          [
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            [
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              { "0123456789abcdef": 2 },
              null,
              { ffffffffffffffef: 1 },
            ],
            null,
          ],
        ],
      },
      frames: {},
    },
  },
  {
    // 1.21.0 (ADR 0105) — STEP_FAILED folds the step's frame only. A flow that catches the
    // failure keeps running; only EXECUTION_FAILED fails the execution. A foreign fold that
    // still moves the execution status on a step failure reports a live execution terminal.
    name: "a caught step failure fails the frame, not the execution",
    events: [
      ev("v5", 0, "EXECUTION_STARTED", { input: {} }),
      ev("v5", 1, "STEP_STARTED", { stepId: "a", input: {} }),
      ev("v5", 2, "STEP_FAILED", { stepId: "a", error: "Error: 503" }),
      ev("v5", 3, "STEP_STARTED", { stepId: "fallback", input: {} }),
    ],
    expected: {
      status: "running",
      sequence: 3,
      variables: { _input: {} },
      frames: {
        a: { status: "failed", attempts: 1 },
        fallback: { status: "running", attempts: 1 },
      },
    },
  },
  {
    // 1.21.0 (ADR 0105) — a STEP_FAILED that lands while the execution is PARKED (a parallel
    // sibling) leaves it suspended and sets `_failedWhileParked`; a following `null` resume is
    // status-only (no gate passthrough) and clears it. A foreign fold that serves that null to
    // the gate lets it pass with no approval.
    name: "a null resume after a sibling failed while parked answers no gate",
    events: [
      ev("v6", 0, "EXECUTION_STARTED", { input: {} }),
      ev("v6", 1, "STEP_STARTED", { stepId: "slow", input: {} }),
      ev("v6", 2, "EXECUTION_SUSPENDED", { condition: { on: "Approval" } }),
      ev("v6", 3, "STEP_FAILED", { stepId: "slow", error: "Error: late" }),
      ev("v6", 4, "EXECUTION_RESUMED", null),
    ],
    expected: {
      status: "running",
      sequence: 4,
      variables: { _input: {} },
      frames: { slow: { status: "failed", attempts: 1 } },
    },
  },
  // ── 1.23.0 (Wave 2, W2-0) — the reserved shapes. No kernel writer exists yet; these pin what
  // a foreign fold must do with them, and (the last two) what it must NOT do without the stamp.
  {
    // ADR 0109: a continuation. The predecessor ends `continued` (NOT completed, no `_output`)
    // naming its successor; the stamp `metadata.kernel` is what makes the event count.
    name: "a stamped EXECUTION_CONTINUED ends the execution as `continued`",
    events: [
      ev("v7", 0, "EXECUTION_STARTED", {
        input: { n: 1 },
        principal: { v: 1 },
        chainId: "v7",
        generation: 0,
      }),
      ev(
        "v7",
        1,
        "EXECUTION_CONTINUED",
        { successorId: "v7~1", chainId: "v7", generation: 1 },
        { kernel: true }
      ),
    ],
    expected: {
      status: "continued",
      sequence: 1,
      variables: {
        _input: { n: 1 },
        _principal: { v: 1 },
        _chain: { chainId: "v7", generation: 0 },
        _continuedTo: "v7~1",
      },
      frames: {},
    },
  },
  {
    // ADR 0109 D3: the successor's start carries budget and inbox; the fold applies them.
    name: "a successor start seeds _resources and _inbox from its validated carry",
    events: [
      ev("v8", 0, "EXECUTION_STARTED", {
        input: { turn: 0 },
        principal: { v: 1, ref: "r" },
        parent: "p",
        chainId: "v7",
        generation: 1,
        codeHash: "sha256:00",
        continuedFrom: {
          executionId: "v7",
          carried: {
            resources: { tokens: 10, costUsd: 0, ms: 4, count: 2, custom: { credits: 3 } },
            inbox: { cursors: { chat: 4 }, dedupe: ["m1"] },
            chainDeadline: 5000,
          },
        },
      }),
      ev("v8", 1, "RESOURCE_METERED", { tokens: 5, custom: { credits: 1, gpu_seconds: 2 } }),
    ],
    expected: {
      status: "running",
      sequence: 1,
      variables: {
        _input: { turn: 0 },
        _principal: { v: 1, ref: "r" },
        _parent: "p",
        _chain: {
          chainId: "v7",
          generation: 1,
          continuedFrom: {
            executionId: "v7",
            carried: {
              resources: { tokens: 10, costUsd: 0, ms: 4, count: 2, custom: { credits: 3 } },
              inbox: { cursors: { chat: 4 }, dedupe: ["m1"] },
              chainDeadline: 5000,
            },
          },
        },
        _codeHash: "sha256:00",
        _resources: {
          tokens: 15,
          costUsd: 0,
          ms: 4,
          count: 3,
          custom: { credits: 4, gpu_seconds: 2 },
        },
        _inbox: { cursors: { chat: 4 }, dedupe: ["m1"] },
      },
      frames: {},
    },
  },
  {
    // ADR 0110: a two-arm park; the inbox arm is answered by a stamped MESSAGE_CONSUMED, then the
    // gate arm by a stamped wait-addressed resume (unwrapped into `_waitAnswers`, never into
    // `_resumePayloads`). The timer arm's `wakeAt` is pinned at its first registration.
    name: "a multi-wait park answered per wait (MESSAGE_CONSUMED, then a wait-addressed resume)",
    events: [
      ev("v9", 0, "EXECUTION_STARTED", { input: {} }),
      ev(
        "v9",
        1,
        "EXECUTION_SUSPENDED",
        {
          condition: {
            on: "Approval",
            waits: [
              { waitId: "#0", kind: "gate", on: "Approval" },
              { waitId: "#1", kind: "inbox", topic: "chat" },
              { waitId: "#2", kind: "timer", wakeAt: 7000 },
            ],
          },
        },
        { kernel: true }
      ),
      ev(
        "v9",
        2,
        "MESSAGE_CONSUMED",
        {
          waitId: "#1",
          topic: "chat",
          messageId: "m1",
          inboxSeq: 0,
          sender: { actor: "a" },
          payload: "hi",
        },
        { kernel: true }
      ),
      ev(
        "v9",
        3,
        "EXECUTION_RESUMED",
        { waitId: "#0", payload: { approved: true } },
        { kernel: true }
      ),
    ],
    expected: {
      status: "running",
      sequence: 3,
      variables: {
        _input: {},
        _waits: { "#2": { kind: "timer", wakeAt: 7000 } },
        _inbox: { cursors: { chat: 0 }, dedupe: ["m1"] },
        _waitAnswers: {
          "#1": { kind: "inbox", name: "chat", payload: "hi" },
          "#0": { kind: "gate", name: "Approval", payload: { approved: true } },
        },
      },
      frames: {},
    },
  },
  {
    // ADR 0112 D2, ADR 0115 D2, ADR 0116 D1: the scope outcome, an open metering dimension (a bad
    // key skipped, deterministically) and a late outcome.
    name: "PARALLEL_COMPLETED, RESOURCE_METERED.custom and a late OUTCOME_RECORDED",
    events: [
      ev("v10", 0, "EXECUTION_STARTED", { input: {} }),
      ev(
        "v10",
        1,
        "PARALLEL_COMPLETED",
        { scopePath: "/0.1", failedBranch: 1, error: "boom", cancelled: ["b#0"] },
        { kernel: true }
      ),
      ev("v10", 2, "RESOURCE_METERED", { ms: 1, custom: { gpu_seconds: 2, "Bad Key": 9 } }),
      ev(
        "v10",
        3,
        "OUTCOME_RECORDED",
        { key: "route", score: 1, decisionId: "d", recordedBy: "ops", late: true },
        { kernel: true }
      ),
    ],
    expected: {
      status: "running",
      sequence: 3,
      variables: {
        _input: {},
        _scopes: { "/0.1": { failedBranch: 1, error: "boom", cancelled: ["b#0"] } },
        _resources: { tokens: 0, costUsd: 0, ms: 1, count: 1, custom: { gpu_seconds: 2 } },
        _outcomes: [{ key: "route", score: 1, decisionId: "d", recordedBy: "ops", late: true }],
      },
      frames: {},
    },
  },
  {
    // ADR 0112 D2 — the scope record's ADDITIVE fields (amended 2026-10-06, R6 review): the
    // launched count, the per-branch gate-answer consumption + cursor, and the failing error's
    // class (and a typed failure's channel + payload). Malformed entries (a negative or fractional
    // index, a non-string path) are skipped; a record without them folds as before.
    name: "PARALLEL_COMPLETED's additive launched / consumed / cursor / error-class fields",
    events: [
      ev("v10b", 0, "EXECUTION_STARTED", { input: {} }),
      ev(
        "v10b",
        1,
        "PARALLEL_COMPLETED",
        {
          scopePath: "/0",
          failedBranch: 0,
          error: "TypedFailure: outage",
          errorName: "TypedFailure",
          errorChannel: "outage",
          errorPayload: { code: 503 },
          cancelled: [],
          launched: 2,
          consumed: [
            ["/0.0", 0],
            ["/0.1", 1.5],
            ["/0.1", -1],
            [7, 2],
            ["/0.1", 2],
          ],
          cursor: 3,
        },
        { kernel: true }
      ),
      ev(
        "v10b",
        2,
        "PARALLEL_COMPLETED",
        { scopePath: "/1", failedBranch: 0, error: "x", cancelled: [], launched: -1, cursor: "z" },
        { kernel: true }
      ),
    ],
    expected: {
      status: "running",
      sequence: 2,
      variables: {
        _input: {},
        _scopes: {
          "/0": {
            failedBranch: 0,
            error: "TypedFailure: outage",
            errorName: "TypedFailure",
            errorChannel: "outage",
            errorPayload: { code: 503 },
            cancelled: [],
            launched: 2,
            consumed: [
              ["/0.0", 0],
              ["/0.1", 2],
            ],
            cursor: 3,
          },
          "/1": { failedBranch: 0, error: "x", cancelled: [] },
        },
      },
      frames: {},
    },
  },
  {
    // The marker rule: the SAME events without `metadata.kernel` fold as an app event always did
    // (no handler effect at all), so an existing log that happens to use these names replays
    // byte-identically. Only PARALLEL_COMPLETED had a (no-op) handler before; it keeps it.
    name: "the new kinds without the kernel stamp fold as no-ops",
    events: [
      ev("v11", 0, "EXECUTION_STARTED", { input: {} }),
      ev("v11", 1, "EXECUTION_CONTINUED", { successorId: "v11~1", chainId: "v11", generation: 1 }),
      ev("v11", 2, "MESSAGE_CONSUMED", {
        waitId: "#0",
        topic: "t",
        messageId: "m",
        inboxSeq: 0,
        payload: 1,
      }),
      ev("v11", 3, "PARALLEL_COMPLETED", {
        scopePath: "/0.0",
        failedBranch: 0,
        error: "e",
        cancelled: [],
      }),
    ],
    expected: {
      status: "running",
      sequence: 3,
      variables: { _input: {} },
      frames: {},
    },
  },
  {
    // ADR 0110 D3/D4: `waits` is honoured only on a kernel-stamped EXECUTION_SUSPENDED. A flow that
    // forges one (no stamp) pins nothing, records no deadline, and a stamped wait-addressed
    // resume naming its wait answers nothing; an unstamped OUTCOME_RECORDED claiming
    // recordedBy/late folds without them.
    name: "an unstamped park's waits and an unstamped outcome's recordedBy/late are userspace and dropped",
    events: [
      ev("v13", 0, "EXECUTION_STARTED", { input: {} }),
      ev("v13", 1, "EXECUTION_SUSPENDED", {
        condition: {
          on: "A",
          waits: [
            { waitId: "root#0", kind: "timer", wakeAt: 9e15 },
            { waitId: "#0", kind: "gate", on: "A" },
          ],
        },
      }),
      ev("v13", 2, "EXECUTION_RESUMED", { waitId: "#0", payload: "yes" }, { kernel: true }),
      ev("v13", 3, "OUTCOME_RECORDED", { key: "k", score: 1, recordedBy: "ops", late: true }),
    ],
    expected: {
      status: "running",
      sequence: 3,
      variables: { _input: {}, _outcomes: [{ key: "k", score: 1 }] },
      frames: {},
    },
  },
  {
    // A fork of a chain member leaves the chain (ADR 0109 D7) and acts as the forker (ADR 0111 D7).
    name: "forkChain and forkedBy on a copied start replace the copied chain and principal",
    events: [
      ev(
        "v12",
        0,
        "EXECUTION_STARTED",
        {
          input: {},
          principal: { v: 1, ref: "owner" },
          chainId: "v7",
          generation: 2,
          continuedFrom: {
            executionId: "v7~1",
            carried: { inbox: { cursors: { t: 3 }, dedupe: [] } },
          },
        },
        { forkChain: { chainId: "v12", generation: 0 }, forkedBy: { v: 1, ref: "forker" } }
      ),
    ],
    expected: {
      status: "running",
      sequence: 0,
      variables: {
        _input: {},
        _principal: { v: 1, ref: "forker" },
        _chain: { chainId: "v12", generation: 0 },
      },
      frames: {},
    },
  },
];

/** Run the reference fold over every vector; returns per-vector pass/fail + detail. */
export function runFoldVectors(vectors: readonly FoldVector[] = FOLD_VECTORS): Array<{
  name: string;
  passed: boolean;
  detail?: string;
}> {
  return vectors.map((v) => {
    const state = foldEvents(v.events);
    const framesView: Record<string, { status: string; attempts: number }> = {};
    for (const [k, f] of Object.entries(state.frames)) {
      framesView[k] = { status: f.status, attempts: f.attempts };
    }
    const actual = {
      status: state.status,
      sequence: state.sequence,
      variables: state.variables,
      frames: framesView,
    };
    const passed = JSON.stringify(actual) === JSON.stringify(v.expected);
    return passed
      ? { name: v.name, passed }
      : {
          name: v.name,
          passed,
          detail: `expected ${JSON.stringify(v.expected)} got ${JSON.stringify(actual)}`,
        };
  });
}
