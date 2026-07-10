import type { EventEnvelope } from "@loom/core";
import type { ExecutionFrame, ExecutionState } from "@loom/core";

type Handler = (state: ExecutionState, event: EventEnvelope) => ExecutionState;

// Copy-on-write a single frame: a shallow spread of the frames container (S key
// references, untouched frames shared) plus the one new frame — O(S) refs + 1
// allocation, instead of deep-cloning all S frames on every step event. Safe
// because handlers never mutate a frame in place; they always write a new object.
function withFrame(
  frames: Record<string, ExecutionFrame>,
  stepId: string,
  frame: ExecutionFrame
): Record<string, ExecutionFrame> {
  return { ...frames, [stepId]: frame };
}

const handlers: Record<string, Handler> = {
  EXECUTION_STARTED: (state, event) => {
    // `flowHash` (K11.1, additive — absent on legacy logs) is the content hash
    // of the flow code this execution started under; resume/recovery compares
    // it against the registered flow so changed code never silently folds an
    // in-flight log. Reserved fold key: `variables._flowHash`.
    const payload = event.payload as { input?: unknown; flowHash?: string };
    const hasVars = payload.input !== undefined || payload.flowHash !== undefined;
    return {
      ...state,
      status: "running",
      startedAt: event.timestamp,
      updatedAt: event.timestamp,
      ...(hasVars && {
        variables: {
          ...state.variables,
          ...(payload.input !== undefined && { _input: payload.input }),
          ...(payload.flowHash !== undefined && { _flowHash: payload.flowHash }),
        },
      }),
    };
  },

  STEP_STARTED: (state, event) => {
    const payload = event.payload as { stepId: string; input?: unknown };
    const existing = state.frames[payload.stepId];
    const frame: ExecutionFrame = {
      stepId: payload.stepId,
      status: "running",
      attempts: (existing?.attempts ?? 0) + 1,
      startedAt: event.timestamp,
      // K8.3 — the first attempt's logged start survives re-runs, so deadlines
      // anchored here are never reset by crash recovery.
      firstStartedAt: existing?.firstStartedAt ?? existing?.startedAt ?? event.timestamp,
      ...(payload.input !== undefined && { input: payload.input }),
    };
    return {
      ...state,
      frames: withFrame(state.frames, payload.stepId, frame),
      updatedAt: event.timestamp,
    };
  },

  STEP_COMPLETED: (state, event) => {
    const payload = event.payload as { stepId: string; output?: unknown };
    const existing = state.frames[payload.stepId];
    const frame: ExecutionFrame = {
      stepId: payload.stepId,
      status: "completed",
      attempts: existing?.attempts ?? 1,
      completedAt: event.timestamp,
      ...(existing?.startedAt !== undefined && { startedAt: existing.startedAt }),
      ...(existing?.firstStartedAt !== undefined && { firstStartedAt: existing.firstStartedAt }),
      ...(existing?.input !== undefined && { input: existing.input }),
      ...(payload.output !== undefined && { output: payload.output }),
    };
    return {
      ...state,
      frames: withFrame(state.frames, payload.stepId, frame),
      updatedAt: event.timestamp,
    };
  },

  STEP_FAILED: (state, event) => {
    const payload = event.payload as { stepId: string; error?: unknown };
    const existing = state.frames[payload.stepId];
    const frame: ExecutionFrame = {
      stepId: payload.stepId,
      status: "failed",
      attempts: existing?.attempts ?? 1,
      ...(existing?.startedAt !== undefined && { startedAt: existing.startedAt }),
      ...(existing?.firstStartedAt !== undefined && { firstStartedAt: existing.firstStartedAt }),
      ...(existing?.input !== undefined && { input: existing.input }),
      ...(payload.error !== undefined && { error: payload.error }),
    };
    return {
      ...state,
      status: "failed",
      frames: withFrame(state.frames, payload.stepId, frame),
      updatedAt: event.timestamp,
    };
  },

  STEP_CANCELLED: (state, event) => {
    // Marks the in-flight step as cancelled WITHOUT touching execution status —
    // the surrounding EXECUTION_CANCELLED event owns the execution-level status,
    // and this must not overwrite it back to a failure/other state.
    const payload = event.payload as { stepId: string };
    const existing = state.frames[payload.stepId];
    const frame: ExecutionFrame = {
      stepId: payload.stepId,
      status: "cancelled",
      attempts: existing?.attempts ?? 1,
      ...(existing?.startedAt !== undefined && { startedAt: existing.startedAt }),
      ...(existing?.firstStartedAt !== undefined && { firstStartedAt: existing.firstStartedAt }),
      ...(existing?.input !== undefined && { input: existing.input }),
    };
    return {
      ...state,
      frames: withFrame(state.frames, payload.stepId, frame),
      updatedAt: event.timestamp,
    };
  },

  STEP_RETRYING: (state, event) => {
    const payload = event.payload as { stepId: string; attempt: number };
    const existing = state.frames[payload.stepId];
    const frame: ExecutionFrame = {
      stepId: payload.stepId,
      status: "pending",
      attempts: payload.attempt,
      ...(existing?.input !== undefined && { input: existing.input }),
    };
    return {
      ...state,
      frames: withFrame(state.frames, payload.stepId, frame),
      updatedAt: event.timestamp,
    };
  },

  PARALLEL_STARTED: (state, event) => {
    const payload = event.payload as { stepIds: string[] };
    // One fresh container, then write each new frame into it (the container is
    // not shared, so in-place writes are safe).
    const frames = { ...state.frames };
    for (const stepId of payload.stepIds) {
      frames[stepId] = {
        stepId,
        status: "pending",
        attempts: 0,
        startedAt: event.timestamp,
      };
    }
    return { ...state, frames, updatedAt: event.timestamp };
  },

  PARALLEL_COMPLETED: (state, event) => {
    return { ...state, updatedAt: event.timestamp };
  },

  EXECUTION_SUSPENDED: (state, event) => {
    const payload = event.payload as {
      condition: { on: string; timeout?: number; correlationKey?: string };
    };
    return {
      ...state,
      status: "suspended",
      suspendedOn: payload.condition,
      updatedAt: event.timestamp,
    };
  },

  EXECUTION_RESUMED: (state, event) => {
    const { suspendedOn: _removed, ...rest } = state;
    return {
      ...rest,
      status: "running",
      variables: {
        ...state.variables,
        ...(event.payload !== undefined && { _resumePayload: event.payload }),
      },
      updatedAt: event.timestamp,
    };
  },

  // Loom 2.0 (P9) — a durable record of an advisory/optimizer choice. Stored in a
  // reserved `_decisions` map keyed by decisionId so replay serves the recorded
  // choice instead of re-consulting the optimizer, keeping the fold pure (P2).
  DECISION_RECORDED: (state, event) => {
    const payload = event.payload as {
      decisionId: string;
      choice: unknown;
      rationale?: unknown;
      source?: string;
    };
    const existing = (state.variables._decisions as Record<string, unknown> | undefined) ?? {};
    return {
      ...state,
      variables: {
        ...state.variables,
        _decisions: {
          ...existing,
          [payload.decisionId]: {
            choice: payload.choice,
            ...(payload.rationale !== undefined && { rationale: payload.rationale }),
            ...(payload.source !== undefined && { source: payload.source }),
          },
        },
      },
      updatedAt: event.timestamp,
    };
  },

  // Loom 2.0 (K2) — a capability denial: the EffectRuntime refused an ungranted
  // effect. Recorded as a durable audit fact in a reserved `_denials` list (the
  // step itself still fails via the STEP_FAILED that follows). Pure audit — it does
  // not change frame/execution status.
  EFFECT_DENIED: (state, event) => {
    const payload = event.payload as { toolId: string; stepId?: string; reason?: string };
    const existing = (state.variables._denials as unknown[] | undefined) ?? [];
    return {
      ...state,
      variables: {
        ...state.variables,
        _denials: [
          ...existing,
          {
            toolId: payload.toolId,
            ...(payload.stepId !== undefined && { stepId: payload.stepId }),
            ...(payload.reason !== undefined && { reason: payload.reason }),
          },
        ],
      },
      updatedAt: event.timestamp,
    };
  },

  // Loom 2.0 (learning seam) — an OUTCOME_RECORDED fact: how a prior choice (a
  // route/capability/tool, by `key`) actually turned out. The symmetric counterpart
  // to DECISION_RECORDED ("what was chosen"): this records "how it went", so
  // @loom/analytics can mine it into a ranking fed back to the router — closing the
  // loop while keeping every future route a logged decision (P9). Folded into a
  // reserved `_outcomes` audit list; pure audit, does not change status.
  OUTCOME_RECORDED: (state, event) => {
    const p = event.payload as {
      key: string;
      success?: boolean;
      score?: number;
      decisionId?: string;
    };
    const existing = (state.variables._outcomes as unknown[] | undefined) ?? [];
    return {
      ...state,
      variables: {
        ...state.variables,
        _outcomes: [
          ...existing,
          {
            key: p.key,
            ...(p.success !== undefined && { success: p.success }),
            ...(p.score !== undefined && { score: p.score }),
            ...(p.decisionId !== undefined && { decisionId: p.decisionId }),
          },
        ],
      },
      updatedAt: event.timestamp,
    };
  },

  // Loom 2.0 (K6) — a behavioral-safety block: a safety validator refused an
  // effect's input or output. Recorded as a durable audit fact in a reserved
  // `_safety` list (the step itself still fails via the STEP_FAILED that follows).
  // Pure audit — it does not change frame/execution status, so a blocked run
  // reconstructs its safety verdict exactly on replay.
  SAFETY_BLOCKED: (state, event) => {
    const p = event.payload as {
      validatorId: string;
      stepId?: string;
      phase?: string;
      reason?: string;
      category?: string;
    };
    const existing = (state.variables._safety as unknown[] | undefined) ?? [];
    return {
      ...state,
      variables: {
        ...state.variables,
        _safety: [
          ...existing,
          {
            validatorId: p.validatorId,
            ...(p.stepId !== undefined && { stepId: p.stepId }),
            ...(p.phase !== undefined && { phase: p.phase }),
            ...(p.reason !== undefined && { reason: p.reason }),
            ...(p.category !== undefined && { category: p.category }),
          },
        ],
      },
      updatedAt: event.timestamp,
    };
  },

  // Loom 2.1 (K9) — an in-doubt effect: recovery found a tool declared
  // `idempotent: false` whose prior attempt is in an UNKNOWN state (STEP_STARTED
  // with no terminal step event) and refused to silently re-run it. Recorded in a
  // reserved `_indoubt` audit list; the EXECUTION_SUSPENDED that follows owns the
  // status change. Pure audit — replay reconstructs the parking exactly, and the
  // list length per step is the durable epoch for fresh idempotency keys after a
  // "retry-fresh" verdict.
  EFFECT_INDOUBT: (state, event) => {
    const p = event.payload as {
      stepId: string;
      toolId?: string;
      attempts?: number;
      idempotencyKey?: string;
    };
    const existing = (state.variables._indoubt as unknown[] | undefined) ?? [];
    return {
      ...state,
      variables: {
        ...state.variables,
        _indoubt: [
          ...existing,
          {
            stepId: p.stepId,
            ...(p.toolId !== undefined && { toolId: p.toolId }),
            ...(p.attempts !== undefined && { attempts: p.attempts }),
            ...(p.idempotencyKey !== undefined && { idempotencyKey: p.idempotencyKey }),
          },
        ],
      },
      updatedAt: event.timestamp,
    };
  },

  // Loom 2.1 (K11.3) — a durable migration verdict: the execution was explicitly
  // resumed on DIFFERENT flow code (resumeAs, replay-check or operator-ack).
  // Re-points the recorded flow-code fingerprint (`_flowHash`) and the flow
  // resolution pointer (`_migratedTo` — the flow id this execution now resolves
  // to; unconditional so the fold never depends on seed identity), and appends
  // an audit entry to the reserved `_migrations` list. Replay re-applies the
  // same verdict at the same sequence (G1).
  EXECUTION_MIGRATED: (state, event) => {
    const p = event.payload as {
      toFlowId: string;
      toHash?: string;
      fromHash?: string;
      strategy?: string;
    };
    const existing = (state.variables._migrations as unknown[] | undefined) ?? [];
    return {
      ...state,
      variables: {
        ...state.variables,
        ...(p.toHash !== undefined && { _flowHash: p.toHash }),
        _migratedTo: p.toFlowId,
        _migrations: [
          ...existing,
          {
            toFlowId: p.toFlowId,
            ...(p.toHash !== undefined && { toHash: p.toHash }),
            ...(p.fromHash !== undefined && { fromHash: p.fromHash }),
            ...(p.strategy !== undefined && { strategy: p.strategy }),
          },
        ],
      },
      updatedAt: event.timestamp,
    };
  },

  // Loom 2.1 (K12) — a VERIFIED approval: a ResumeAuthenticator confirmed the
  // identity behind an authority-gating resume, so "who approved" is durable
  // evidence, not an unverified claim. Folded into a reserved `_approvals`
  // audit list. Pure audit — the accompanying EXECUTION_RESUMED owns the
  // lifecycle; a REJECTED approval never reaches the log (the resume is refused
  // before any event is committed).
  APPROVAL_GRANTED: (state, event) => {
    const p = event.payload as { actor?: string; verifiedBy?: string; on?: string };
    const existing = (state.variables._approvals as unknown[] | undefined) ?? [];
    return {
      ...state,
      variables: {
        ...state.variables,
        _approvals: [
          ...existing,
          {
            ...(p.actor !== undefined && { actor: p.actor }),
            ...(p.verifiedBy !== undefined && { verifiedBy: p.verifiedBy }),
            ...(p.on !== undefined && { on: p.on }),
            at: event.timestamp,
          },
        ],
      },
      updatedAt: event.timestamp,
    };
  },

  // Loom 2.1 (K10) — a crypto-shred tombstone: the subject's encryption key was
  // destroyed, so this execution's sensitive payload fields are permanently
  // unrecoverable (GDPR erasure of an append-only log). Written AT SHRED TIME by
  // the lifecycle service (never at replay). Marks `variables._shredded` so the
  // folded state records the erasure; a decrypting store read of the affected
  // fields fails loudly with PayloadShreddedError (the erasure is not silent).
  PAYLOAD_SHREDDED: (state, event) => {
    const p = event.payload as { subjectId?: string; reason?: string };
    return {
      ...state,
      variables: {
        ...state.variables,
        _shredded: {
          ...(p.subjectId !== undefined && { subjectId: p.subjectId }),
          ...(p.reason !== undefined && { reason: p.reason }),
          at: event.timestamp,
        },
      },
      updatedAt: event.timestamp,
    };
  },

  // Loom 2.1 (K7) — an egress denial: the kernel-side broker refused an
  // isolated tool's network target (not in its static allowlist), BEFORE any
  // connection was opened. Folded into a reserved `_egress` audit list,
  // mirroring EFFECT_DENIED's `_denials`. Pure audit — whether the step fails
  // is the tool's error path (an uncaught denial fails via STEP_FAILED).
  EGRESS_DENIED: (state, event) => {
    const p = event.payload as {
      toolId?: string;
      stepId?: string;
      target?: string;
      reason?: string;
    };
    const existing = (state.variables._egress as unknown[] | undefined) ?? [];
    return {
      ...state,
      variables: {
        ...state.variables,
        _egress: [
          ...existing,
          {
            ...(p.toolId !== undefined && { toolId: p.toolId }),
            ...(p.stepId !== undefined && { stepId: p.stepId }),
            ...(p.target !== undefined && { target: p.target }),
            ...(p.reason !== undefined && { reason: p.reason }),
          },
        ],
      },
      updatedAt: event.timestamp,
    };
  },

  // Loom 2.1 (T1) — a durable timer fired: the wake that ends a
  // `ctx.sleep`/`sleepUntil` (or a timer-service-backed `suspend({ timeout })`).
  // Pure audit into the reserved `_timers` list — the EXECUTION_RESUMED that
  // accompanies it owns the status change. `wakeAt` is the SCHEDULED time (from
  // the log); `firedAt` (event timestamp) records actual delivery, so drift is
  // observable but never enters control flow.
  TIMER_FIRED: (state, event) => {
    const p = event.payload as { wakeAt?: number; scheduleId?: string; occurrence?: number };
    const existing = (state.variables._timers as unknown[] | undefined) ?? [];
    return {
      ...state,
      variables: {
        ...state.variables,
        _timers: [
          ...existing,
          {
            firedAt: event.timestamp,
            ...(p.wakeAt !== undefined && { wakeAt: p.wakeAt }),
            ...(p.scheduleId !== undefined && { scheduleId: p.scheduleId }),
            ...(p.occurrence !== undefined && { occurrence: p.occurrence }),
          },
        ],
      },
      updatedAt: event.timestamp,
    };
  },

  // Loom 2.0 (K3) — accumulate metered resource usage (tokens / cost / wall-time)
  // into a reserved `_resources` running total. Emitted by accounting middleware
  // when an effect actually runs, so the total is deterministic on replay.
  RESOURCE_METERED: (state, event) => {
    const p = event.payload as { tokens?: number; costUsd?: number; ms?: number };
    const r = (state.variables._resources as
      | { tokens: number; costUsd: number; ms: number; count: number; exceeded?: boolean }
      | undefined) ?? { tokens: 0, costUsd: 0, ms: 0, count: 0 };
    return {
      ...state,
      variables: {
        ...state.variables,
        _resources: {
          tokens: r.tokens + (p.tokens ?? 0),
          costUsd: r.costUsd + (p.costUsd ?? 0),
          ms: r.ms + (p.ms ?? 0),
          count: r.count + 1,
          ...(r.exceeded === true && { exceeded: true }),
        },
      },
      updatedAt: event.timestamp,
    };
  },

  // A quota admission-control denial: the execution exceeded its budget, so the
  // effect was refused. Marks `_resources.exceeded` (the STEP_FAILED that follows
  // fails the step). Pure audit.
  QUOTA_EXCEEDED: (state, event) => {
    const p = event.payload as { reason?: string };
    const r = (state.variables._resources as
      | { tokens: number; costUsd: number; ms: number; count: number; exceeded?: boolean }
      | undefined) ?? { tokens: 0, costUsd: 0, ms: 0, count: 0 };
    return {
      ...state,
      variables: {
        ...state.variables,
        _resources: { ...r, exceeded: true, ...(p.reason !== undefined && { reason: p.reason }) },
      },
      updatedAt: event.timestamp,
    };
  },

  EXECUTION_COMPLETED: (state, event) => {
    const payload = event.payload as { output?: unknown };
    return {
      ...state,
      status: "completed",
      ...(payload.output !== undefined && {
        variables: { ...state.variables, _output: payload.output },
      }),
      updatedAt: event.timestamp,
    };
  },

  EXECUTION_FAILED: (state, event) => {
    const payload = event.payload as { error?: unknown };
    return {
      ...state,
      status: "failed",
      ...(payload.error !== undefined && {
        variables: { ...state.variables, _error: payload.error },
      }),
      updatedAt: event.timestamp,
    };
  },

  EXECUTION_CANCELLED: (state, event) => {
    const payload = event.payload as { reason?: unknown };
    return {
      ...state,
      status: "cancelled",
      ...(payload.reason !== undefined && {
        variables: { ...state.variables, _cancelReason: payload.reason },
      }),
      updatedAt: event.timestamp,
    };
  },
};

export function getHandler(eventType: string): Handler | undefined {
  return handlers[eventType];
}

// ── Event-schema ABI governance (Loom 2.0 K5) ────────────────────────────────
//
// The event log is the kernel's on-disk ABI: state is `fold(events)`, and stored
// logs must replay across deploys (this is what `@loom/deploy-sim` guards at the
// flow level). This names and versions the *set of event types the fold understands*.
// Governance: adding an event type is additive (bump MINOR, update the pinned list);
// removing or repurposing one changes how historical logs fold and is a MAJOR break
// that must be deliberate — the conformance test pins `knownEventTypes()`.
// 1.4.0: additive optional `flowHash` payload field on EXECUTION_STARTED (K11.1) —
// per the K5 payload-extension rule, folds treat absence as legacy.
// 1.5.0: added EXECUTION_MIGRATED (K11.3).
// 1.6.0: added TIMER_FIRED (T1 — durable timers).
// 1.7.0: added EGRESS_DENIED (K7 — data-plane isolation & egress control).
// 1.8.0: added PAYLOAD_SHREDDED (K10 — crypto-shredding).
// 1.9.0: added APPROVAL_GRANTED (K12 — verified approvals).
export const EVENT_SCHEMA_VERSION = "1.9.0";

export function knownEventTypes(): string[] {
  return Object.keys(handlers).sort();
}
