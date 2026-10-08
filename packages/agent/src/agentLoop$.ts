import { isTainted, taintOf, tainted } from "@loom/classify";
import type { AgentDefinition, ExecutableTask, ToolDefinition } from "@loom/core";
import { SuspendError, TypedFailure, fail, fnv1a64, loadInstructions } from "@loom/core";
import type { Effect } from "@loom/effect-runtime";
import { ToolEffect } from "@loom/effect-runtime";
import type {
  LlmContent,
  LlmContentPartInput,
  LlmMessageInput,
  LlmResponse,
  LlmToolCall,
  LlmToolResultPartInput,
  LlmToolSpecInput,
} from "@loom/llm";
import { LLM_INTERRUPTED, MAX_INLINE_TOTAL_BYTES, assistantMessageOf } from "@loom/llm";
import type { TieredMemory } from "@loom/memory";
import type { ModelInvoker, ReasonOptions, ReasoningRuntime } from "@loom/reasoning";
import { ExecutionCancelledError, approvalViewDigest } from "@loom/workflow-runtime";
import type { BranchContext, ExecutionContext } from "@loom/workflow-runtime";
import type { SkillRegistry } from "./SkillRegistry";
import { type SkillSelector, deterministicSkillSelector } from "./SkillSelector";
import { createAgentModelEffect } from "./createAgentModelEffect";
import { AGENT_INTERRUPTED, type InterruptedAgentRun } from "./interrupted";
import { OVERSIZED_INPUT_REFUSAL, screenToolCalls } from "./screenToolCalls";
import { isTerminalToolError } from "./toolFailure";
import { inlineBytesIn, toolResultPart } from "./toolResultContent";
import { buildToolMenu, toolSpecFor } from "./toolSchema";
import type { AgentInput, AgentOutput, AgentStep } from "./types";

// ── R1 — the agent loop as a RUNNER BODY, not a step handler ─────────────────
//
// `agentStep$` wraps the whole ReAct loop in one `step$({ handler })`, and a
// handler receives `StepHandlerContext`: `emit`, and nothing else. No `execute`,
// no `suspend`, no `decide`. Forty model calls and N tool calls are ONE frame, so
// a crash at turn 39 re-runs all 39; approval has to be hoisted out of the agent
// entirely; and routing choices are hand-emitted in a shape `@loom/learning`
// cannot evaluate. The kernel's entire agent-relevant surface was present and
// unreachable from the agent.
//
// This is the same construct with the loop on the other side of the boundary: an
// ordinary function over `ExecutionContext`, called FROM a runner body, issuing
// `ctx.execute` per turn.
//
// IDENTITY (ADR 0061 D1). Ids are minted `#turn:<i>` and `#turn:<i>:tool:<j>`.
// Both indices are pure functions of logged inputs — the turn index from the
// number of completed turns, the tool index from the model response, which is
// itself a recorded step output — so a recovery re-run re-derives exactly the
// same id sequence and every completed task is served from the log instead of
// re-invoked. This is the idiom `interpreterLoop.test.ts` crash-injects at every
// position; `agentLoopCrash.test.ts` does the same for this loop.
//
// `agentStep$` (and `AgentRunner`) remain for existing callers but are DEPRECATED since R10 (ADR 0121):
// this loop is the canonical one. `agentStep$` is still the cheap opaque form (one frame instead of 2N)
// for an agent that wants none of the above, and nothing is removed by this change.

/** The payload the model effect receives. `createAgentModelEffect` builds one that accepts it. */
export interface AgentModelCall {
  messages: LlmMessageInput[];
  tools?: LlmToolSpecInput[];
  system?: LlmContent;
  /** R9 — set only by a routed turn forwarding the reasoning request's own sampling bounds. */
  maxTokens?: number;
  temperature?: number;
}

/** What a tool call must clear before it runs. Returning `false` parks the loop on a gate. */
export type ApprovalPolicy = (
  toolCall: LlmToolCall,
  turn: number,
  /**
   * Whether the tool name is on this loop's menu (agent tools + selected skills'
   * tools). `false` means the call WILL be refused whatever the answer; the hook
   * is still consulted (it sits before the menu gate) so a host can return `true`
   * to skip prompting a human about a call that cannot run.
   */
  onMenu?: boolean
) => boolean;

export interface AgentLoopConfig {
  definition: AgentDefinition;
  /**
   * The effect id the model call resolves to. THIS is what puts the model call
   * inside the protection ring — K2 authorization, metering and quotas, retry,
   * `idempotencyKey`, K9 in-doubt — on the most expensive and least reliable call
   * the agent makes. Register `createAgentModelEffect(provider)` under it.
   */
  modelToolId?: string;
  /**
   * Route the turn through the Reasoning Runtime instead of a fixed effect, with
   * the route and every elevation recorded as REAL decisions.
   *
   * `AgentRunner` fakes this seam: it builds a local `decide` that runs the
   * decider and hand-emits DECISION_RECORDED through `emit`. That is a fact in
   * the log and it is NOT served on replay, so a re-run re-routes — and if
   * routing improves run-to-run, which is the point of a Reasoning Runtime, the
   * replayed run can take a different route than the one whose answer is
   * recorded. A bare log that LOOKS scored while being unevaluable is exactly
   * what the `learning-router` example exists to demonstrate.
   *
   * From a runner body the real seam is in reach, so this passes `ctx.decide`.
   *
   * **The ring, and how to get it (R9).** By default the Reasoning Runtime's routes call their
   * providers DIRECTLY: `guardRequest` still runs (R2 guards `ReasoningRuntime.call`), but K2
   * authorization, metering and quotas, the kill switch and K9 in-doubt do not apply. Since R10
   * the response is nonetheless JOURNALED as a decision (`<agent>#turn:<i>:response:<n>`), so a
   * resumed run serves the recorded answer and makes no model call for a completed turn (an
   * execution recorded before R10 has no such decision and re-asks that turn once, as it always did). Set
   * {@link reasoningToolId} and each route's call is instead resolved through the
   * `EffectRuntime` as a durable frame (`#turn:<i>:call:<n>`), which brings all of those and a
   * recorded response; {@link registerReasoningRoutes} registers one effect per route. The
   * `modelToolId` path always had the full ring and no routing; this gives routing the same.
   * {@link requireEffectRing} turns the unguarded default into a refusal.
   */
  reasoning?: ReasoningRuntime;
  /**
   * R9 — route each `reasoning` model call through the effect ring. Either one effect id for
   * every route, or a function from the route id to the effect id registered for it (see
   * {@link registerReasoningRoutes}). Each call is a journaled `ctx.execute` frame with the id
   * `<agent>#turn:<i>:call:<n>` (`n` counts the route + elevation calls within the turn, which
   * the recorded decisions make deterministic), so authorization, metering, the kill switch and
   * `guardRequest` apply and a replay serves the recorded response. Ignored without `reasoning`.
   */
  reasoningToolId?: string | ((routeId: string) => string);
  /**
   * R10 — partition the Reasoning Runtime's response cache (`ReasonOptions.cacheScope`). A runner body
   * cannot read its own principal, so a multi-tenant host that configures a cache passes the tenant id
   * here; unset, identical prompts share cache entries. Ignored without `reasoning`.
   */
  cacheScope?: string;
  /**
   * R9 — refuse to run any model call outside the effect ring. With this set, `agentLoop$`
   * throws up front when `reasoning` is configured without {@link reasoningToolId}, and when a
   * `skillSelector` calls a provider directly instead of being `effectBacked`.
   * `@loom/app`'s strict profile CANNOT set this for you (it does not construct agents): pass it
   * at each call site. Without it, `agentLoop$` emits a one-time process warning
   * (`LOOM_AGENT_RING`) when `reasoning` is used with no `reasoningToolId`. Default `false`
   * keeps today's behaviour.
   */
  requireEffectRing?: boolean;
  systemPrompt?: string;
  maxIterations?: number;
  /**
   * R10 — what a FAILING tool does to the run. `"feedback"` (default): the failure becomes an
   * `isError` `tool_result` (`{ error }`) the model reads and can recover from, exactly as
   * {@link AgentRunner} always did; the run continues. `"fail"`: the failure propagates and fails
   * the execution (the pre-R10 behaviour; under {@link parallelTools} it also aborts the sibling
   * calls, a fail-fast scope).
   *
   * Never fed back, in either mode: a park (`SuspendError`), an authority error
   * (`CapabilityDeniedError`, `EffectModeViolationError`; R4), a safety or budget stop
   * (`SafetyViolationError`, `KillSwitchEngagedError`, `QuotaExceededError`), a cancellation and a
   * replay divergence. Those are the runtime's, not the tool's.
   *
   * REPLAY: in `"feedback"` mode each call's OUTCOME (`ok` or the bounded error text) is a recorded
   * decision (`<loop>#turn:<i>:tool:<j>:outcome`, wrapping the `ctx.execute`), so a resume serves
   * what the model already consumed and never re-runs a failed tool (an untyped failure is
   * otherwise re-run live by the kernel's at-least-once rule for a failed step). `"fail"` records
   * nothing extra. A tool of `kind: "human"` is not wrapped (its answer is consumed by the step
   * itself).
   */
  toolErrors?: "feedback" | "fail";
  /**
   * R10 — run the tool calls of ONE model turn concurrently through `ctx.parallel`. `false`
   * (default) keeps the strictly sequential gate, run, gate, run order (and the exact frame
   * sequence of every earlier version, so in-flight executions resume unchanged). `true` runs
   * them all at once; a number bounds the concurrency.
   *
   * Step ids are unchanged (`<loop>#turn:<i>:tool:<j>`, `j` the index in the model's response, a
   * pure function of the recorded response), results are fed back in the model's order whichever
   * call finishes first, and one call's failure is that call's `isError` result, not the scope's
   * (see {@link toolErrors}). Approvals ({@link requireApproval}) are collected sequentially, in
   * call order, BEFORE any call of the turn starts, so a turn parked on an approval has run none of
   * its calls. Needs `kernel.features.scopes` for cancellation scoping; without it `ctx.parallel`
   * is the pre-R6 bounded `Promise.all` and everything else holds.
   */
  parallelTools?: boolean | number;
  /**
   * R10 — a signal that stops THIS run without cancelling the execution (a user barge-in, a host
   * shutting a turn down). Checked before every turn, before the turn's tool calls and before each
   * call's approval and run; once aborted, no further model or tool call is issued and the run fails
   * on {@link AGENT_INTERRUPTED} with what it had produced ({@link InterruptedAgentRun}: the partial
   * text, the iterations begun, the tool calls that completed). It is also handed to a routed
   * model call that makes its own provider request.
   *
   * REPLAY. A signal is not data, so each checkpoint's answer is a RECORDED decision
   * (`<loop>#abort:<site>`, `source: "agent-abort"`): a replay reproduces the interruption at the
   * same point, so a host that catches `AGENT_INTERRUPTED` and carries on takes the same branch on
   * a resume. The cost is a few small decisions per turn, written ONLY when a signal is configured.
   * (An error a provider throws mid-generation because the signal fired is converted live and is
   * not recorded; its model call was never journaled either, so a replay re-asks it.) An execution
   * `cancel` needs no signal here: the kernel stops it at the next `ctx.execute` and aborts the
   * effect in flight; the two compose.
   */
  signal?: AbortSignal;
  /**
   * R10 — a per-turn deadline for the MODEL call, in milliseconds. On the effect path
   * (`modelToolId`, or `reasoning` + `reasoningToolId`) it is the frame's kernel `timeoutMs`
   * (anchored to the first logged start, so a crash-recovery re-run resumes the countdown); on the
   * direct `reasoning` path it aborts the provider request. A model call that times out fails the
   * run (there is nothing to continue with); a tool call that does (`toolTimeoutMs`) is an
   * `isError` result.
   */
  turnTimeoutMs?: number;
  /** R10 — a per-call deadline for each TOOL call, in milliseconds (the frame's kernel `timeoutMs`). */
  toolTimeoutMs?: number;
  /**
   * Park the execution for approval before a tool call the policy declines.
   * Returning `false` suspends on {@link approvalGate}; the resume payload
   * `{ approved: false }` refuses the call and feeds the refusal back to the
   * model as a tool result, so the agent can settle rather than retry blindly.
   *
   * This is the capability `agentStep$` structurally cannot have: a handler
   * cannot suspend, so approval had to be hoisted out of the agent — which is
   * precisely the design the feature exists to avoid.
   */
  requireApproval?: ApprovalPolicy;
  /** Gate name for approvals. Pair with `flow$({ resumeSchemas })` to parse the payload (ADR 0077). */
  approvalGate?: string;
  /**
   * R13 (ADR 0117) — bind each approval to the tool call the approver was shown. The gate
   * records a digest of `(position, tool, input)` in its suspend condition and the resume must
   * echo it (`answerApproval(state, { approved })` builds that); a bare or stale approval is
   * refused before anything is appended. Default `true`. `false` restores the unbound gate,
   * where whatever is parked when the approval arrives is what it approves.
   *
   * A `flow$({ resumeSchemas })` entry for this gate must let `viewDigest` through (a strict
   * `z.object` drops it from the recorded payload; a `.strict()` one rejects it).
   */
  bindApproval?: boolean;
  /**
   * Skills to select from. The selection is RECORDED through `ctx.decide`, so
   * replay serves the set that actually ran rather than re-selecting.
   *
   * That is what makes a model-driven selector safe here. `llmSkillSelector`
   * carried the caveat in its own comment — "the LLM decision is not recorded" —
   * and an unrecorded selection means a replayed run can rebuild a DIFFERENT
   * prompt than the one whose answer is in the log.
   */
  skills?: SkillRegistry;
  skillSelector?: SkillSelector;
  /**
   * Conversation memory, recalled through `ctx.decide` for the same reason: a
   * store that changed between the run and the replay would silently change the
   * prompt.
   */
  memory?: TieredMemory;
  /**
   * R10 — persist the run's outcome to {@link memory} when it finishes: the user's prompt and the
   * final answer, as `user` / `assistant` entries in the same tier and scope the next run recalls
   * from, so a conversation carried across executions (or across `continueAsNew` generations)
   * remembers itself. `true` uses {@link memoryTier} / {@link memoryScope}; the object form
   * overrides either. Requires {@link memory}.
   *
   * The write is a side effect in a body that re-runs on resume, so it is IDEMPOTENT: each entry
   * carries a deterministic id (execution, loop and a hash of the prompt / of prompt + answer) and
   * is first `forget`-ten by id (a keyed remove, not a scope read), so a crash between the write and
   * the run's completion does not duplicate it. A run that is interrupted or fails writes nothing.
   * A tier that summarizes may fold an entry's id away; the residual is one repeated entry, not a
   * lost one. PROVENANCE: if any tool result in the run was tainted (ADR 0085), the assistant entry
   * is stored tainted with that origin, so a later recall puts it in a fenced `user` message, never
   * an instruction (assistant / system) position.
   */
  writeBack?:
    | boolean
    | {
        tier?: string;
        scope?: string;
        /**
         * Make the write a journaled `ctx.execute` against this effect (register
         * {@link memoryWriteBackEffect} under it): K2 authorization, tenant / authority checks and
         * the kill switch apply, and a replay serves the recorded write. Without it the write is a
         * direct call on the `TieredMemory` you passed (outside the ring); `requireEffectRing`
         * refuses that.
         */
        toolId?: string;
        /**
         * Skip the write while this returns `true` (evaluated live, never journaled): the hook for a
         * forked or simulated execution, which must not write the real memory. The kernel gives a
         * body no way to tell it is a fork (a fork replays the prefix of a real execution), so the
         * host that forks passes it. The answer is journaled (`<loop>#writeback:skip`), so a resume in
         * another process reaches the same verdict. Adding a fork marker to the kernel is a separate
         * decision, noted in ADR 0121 as a follow-up.
         */
        unless?: () => boolean;
        /**
         * Accept a direct, unconditional, un-journaled write (no `toolId`, no `unless`). Required
         * to say so: without any of the three, construction throws {@link AgentLoopConfigError}.
         */
        allowDirect?: boolean;
      };
  /** Memory tier to recall from. Default `"working"`. */
  memoryTier?: string;
  /** Scope key. Default the execution id, so a run remembers its own conversation. */
  memoryScope?: string;
  /**
   * How many recalled entries reach the prompt, newest first. Unset ⇒ ALL of
   * them, which is the hard wall `AgentRunner` still has: conversation length
   * stops being a cost curve and becomes a limit. Set it.
   */
  recallLimit?: number;
  /**
   * Fold older messages into one summary when the transcript grows past
   * `afterMessages` messages OR `afterBytes` UTF-8 bytes, keeping the newest
   * intact.
   *
   * This is the second half of the log-growth answer (ADR 0087 D5 amendment):
   * the growing quantity is the journaled `STEP_STARTED` `input` on EVERY turn
   * (O(n²) bytes uncompacted), not a per-turn cost claim-check can bound —
   * claim-check offloads a tool RESULT's bytes, not the transcript an agent
   * re-sends every turn. Compaction bounds both dimensions of that input: turn
   * COUNT (`afterMessages`, the original trigger) and transcript BYTES
   * (`afterBytes`, for the case one oversized message — a large uncompacted
   * tool result — stays in every turn's input until it ages past `keepRecent`
   * on message count alone). At least one threshold is required; the
   * constructor throws if neither is set.
   *
   * It was deferred from R1 for a specific reason, and that reason shapes the
   * design — a summary is lossy and nondeterministic, so it cannot simply be
   * computed in the loop body. It runs through `ctx.execute` against `toolId`,
   * which makes it a recorded task: journaled once, served from the log on
   * replay, so a re-run reconstructs the SAME compacted transcript rather than
   * re-summarizing into a different one. The trigger itself is a pure function
   * of already-journaled message content (a running UTF-8 byte count,
   * maintained as messages are pushed — never wall-clock or re-serialized on
   * every check), so it fires identically on replay.
   *
   * The effect receives `{ messages }` and returns `{ summary: string }`.
   */
  compaction?: {
    toolId: string;
    /** Compact once the transcript exceeds this many messages. */
    afterMessages?: number;
    /**
     * Compact once the transcript's running UTF-8 byte count exceeds this
     * many bytes.
     *
     * The kept suffix is the longest run of the newest messages whose bytes
     * total at most `afterBytes / 2`, bounded below by 1 (the newest message
     * always reaches the model) and above by `keepRecent`. If that suffix
     * covers the whole transcript — one message alone is already over the
     * threshold — compaction is skipped for this turn rather than paying a
     * summary call that would fold nothing.
     */
    afterBytes?: number;
    /** How many of the newest messages to leave untouched. Default 4. */
    keepRecent?: number;
  };
}

const DEFAULT_GATE = "AgentToolApproval";

let warnedReasoningOutsideRing = false;
/** One advisory per process: `reasoning` without `reasoningToolId` calls providers unguarded (R9). */
function warnReasoningOutsideRing(): void {
  if (warnedReasoningOutsideRing) return;
  warnedReasoningOutsideRing = true;
  const proc = (globalThis as { process?: { emitWarning?: (m: string, o?: object) => void } })
    .process;
  proc?.emitWarning?.(
    "agentLoop$: `reasoning` is used without `reasoningToolId`, so its routed model calls bypass authorization, metering and the kill switch (the response is still journaled, as a decision, so a resume does not re-call the model). Set `reasoningToolId` (see registerReasoningRoutes) or `requireEffectRing: true`.",
    { code: "LOOM_AGENT_RING" }
  );
}

/** Test seam: re-arm the one-time advisory. */
export function resetReasoningRingWarning(): void {
  warnedReasoningOutsideRing = false;
}

/** Build the model's tool menu, carrying `LlmContent` so a tainted description is REFUSED (R2). */
function toolSpecsFor(tools: readonly ToolDefinition[]): LlmToolSpecInput[] {
  return tools.map((t) => {
    const spec = toolSpecFor(t);
    return { ...spec, description: spec.description as LlmContent };
  });
}

// ── The byte counter (compaction's `afterBytes` trigger) ─────────────────────
//
// A pure function of a message's own content — never wall-clock, never a
// re-serialization of the whole transcript — so it is a deterministic function
// of already-journaled values: replaying the turns that produced `messages` up
// to any point recomputes the identical running total, and therefore the
// identical compaction decision, every time.

const UTF8 = new TextEncoder();

const textBytes = (t: LlmContent): number =>
  UTF8.encode(typeof t === "string" ? t : t.value).length;

// ── The compaction measure is the PRE-R5 measure, on purpose ──────────────────
//
// R5 changed the transcript's shape (one assistant message + ONE user message of `tool_result` parts
// per turn, where it was one assistant message + one user message PER RESULT). The compaction trigger
// (`afterMessages` / `afterBytes`) and the kept-suffix size are decided from that transcript, and the
// summary frame's id (`#turn:<t>:compact`) is a function of WHEN they fire. A measure over the new
// shape would fire on different turns, so a run recorded by the old body and resumed by the new one
// would ask for frames the log does not hold and skip ones it does (a replay divergence). So the
// trigger is computed over a VIRTUAL transcript: one entry per message the old body would have held,
// each with the byte size the old body measured. Physical messages carry how many virtual entries
// they stand for (`physOld`). Everything below is a pure function of journaled values.

/** Bytes of one part that has no pre-R5 equivalent (media, `tool_use`): its journaled size. */
function partBytes(p: LlmContentPartInput): number {
  switch (p.type) {
    case "text":
      return textBytes(p.text);
    case "image":
    case "audio":
    case "file":
      return p.source.kind === "data" ? p.source.data.length : p.source.ref.address.length + 16;
    case "tool_use":
      return p.id.length + p.name.length + JSON.stringify(p.input ?? null).length;
    case "tool_result":
      return p.toolUseId.length + resultContentBytes(p.content);
  }
}

function resultContentBytes(content: LlmToolResultPartInput["content"]): number {
  return Array.isArray(content)
    ? content.reduce((n, r) => n + partBytes(r), 0)
    : textBytes(content as LlmContent);
}

/**
 * The virtual size of one tool result: exactly what the old body measured for its free-standing
 * `user` message (the UTF-8 length of the `{ tool, result }` text, taint unwrapped). A media result
 * has no old equivalent, so it counts its parts.
 */
function resultBytes(part: LlmToolResultPartInput): number {
  return resultContentBytes(part.content);
}

/** Whether a message answers tool calls — it must never be the first kept message without its call. */
function isToolResultMessage(msg: LlmMessageInput): boolean {
  return (
    msg.role === "user" &&
    Array.isArray(msg.content) &&
    msg.content.some((p) => p.type === "tool_result")
  );
}

/**
 * How many of the newest VIRTUAL messages the byte-trigger fold keeps: the longest suffix whose
 * bytes total at most `afterBytes / 2`, floored at 1 (the newest message always reaches the model)
 * and capped at `keepRecent`.
 */
function keptSuffixByBytes(
  sizes: readonly number[],
  afterBytes: number,
  keepRecent: number
): number {
  const halfBudget = afterBytes / 2;
  let count = 1;
  let bytes = sizes[sizes.length - 1] as number;
  for (let i = sizes.length - 2; i >= 0 && count < keepRecent; i--) {
    const b = sizes[i] as number;
    if (bytes + b > halfBudget) break;
    bytes += b;
    count++;
  }
  return count;
}

/** Decoded inline media bytes in the transcript (what `MAX_INLINE_TOTAL_BYTES` counts). */
function inlineBytesOf(messages: readonly LlmMessageInput[]): number {
  let n = 0;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content) if (p.type === "tool_result") n += inlineBytesIn(p);
  }
  return n;
}

/**
 * Run an agent's ReAct loop with one durable frame per turn.
 *
 * Call it from a runner body, where `ctx` is the `ExecutionContext`:
 *
 * ```ts
 * runtime.registerFlow(flow, async (ctx, input) =>
 *   agentLoop$(ctx, { definition: myAgent, modelToolId: "model" }, { prompt: input.question })
 * );
 * ```
 *
 * **The trade-off, stated plainly.** Per-turn durability journals each turn's
 * message array, so the log grows with conversation length. That is real and it
 * is not free. The existing answers are claim-check middleware (ADR 0054) for the
 * bytes and `TieredMemory`'s summarization for the turns; an adopter who wants
 * neither keeps `agentStep$` and pays one frame.
 */
export async function agentLoop$(
  ctx: ExecutionContext,
  config: AgentLoopConfig,
  input: AgentInput
): Promise<AgentOutput> {
  if (config.modelToolId === undefined && config.reasoning === undefined) {
    // Refused up front rather than running zero turns and returning an empty
    // answer, which is what an absent model access would otherwise look like.
    throw new Error("agentLoop$ requires a `modelToolId` or a `reasoning` runtime");
  }
  if (
    config.requireEffectRing !== true &&
    config.reasoning !== undefined &&
    config.reasoningToolId === undefined
  ) {
    warnReasoningOutsideRing();
  }
  if (config.requireEffectRing === true) {
    if (config.reasoning !== undefined && config.reasoningToolId === undefined) {
      throw new Error(
        "agentLoop$ requireEffectRing: `reasoning` calls its routes' providers directly, outside authorization/metering/the kill switch. Set `reasoningToolId` (see registerReasoningRoutes) or drop `reasoning` for `modelToolId`."
      );
    }
    if (
      config.writeBack !== undefined &&
      config.writeBack !== false &&
      (typeof config.writeBack !== "object" || config.writeBack.toolId === undefined)
    ) {
      throw new Error(
        "agentLoop$ requireEffectRing: `writeBack` writes the TieredMemory directly, outside authorization. Set `writeBack.toolId` (see memoryWriteBackEffect)."
      );
    }
    if (config.skillSelector !== undefined && config.skillSelector.effectBacked !== true) {
      throw new Error(
        "agentLoop$ requireEffectRing: this `skillSelector` calls a provider directly, outside authorization/metering/the kill switch. Use llmSkillSelector({ toolId }) or deterministicSkillSelector()."
      );
    }
  }
  if (
    config.compaction !== undefined &&
    config.compaction.afterMessages === undefined &&
    config.compaction.afterBytes === undefined
  ) {
    // A compaction block that can never trigger reads as coverage it isn't.
    throw new Error("agentLoop$ compaction requires `afterMessages` or `afterBytes`");
  }
  if (config.writeBack !== undefined && config.writeBack !== false) {
    const w = config.writeBack;
    if (
      w === true ||
      (w.toolId === undefined && w.unless === undefined && w.allowDirect !== true)
    ) {
      // A fork or a simulation replays the prefix of a real execution; an unconditional direct write
      // from it would put its prompt and answer in the REAL memory. So the unsafe form is never the
      // default: say where the write goes (`toolId`), when it must not happen (`unless`), or that you
      // accept both (`allowDirect`).
      throw new AgentLoopConfigError(
        "agentLoop$ writeBack needs `toolId` (a journaled effect), `unless` (skip for forks / simulations) or `allowDirect: true`"
      );
    }
  }
  if (config.writeBack !== undefined && config.writeBack !== false && config.memory === undefined) {
    // A write-back with nowhere to write reads as persistence it isn't.
    throw new Error("agentLoop$ writeBack requires `memory`");
  }
  const parallelTools = config.parallelTools ?? false;
  if (
    typeof parallelTools === "number" &&
    (!Number.isSafeInteger(parallelTools) || parallelTools < 1)
  ) {
    throw new RangeError(
      `agentLoop$ parallelTools must be true, false or a positive integer (got ${String(parallelTools)})`
    );
  }
  for (const [name, v] of [
    ["turnTimeoutMs", config.turnTimeoutMs],
    ["toolTimeoutMs", config.toolTimeoutMs],
  ] as const) {
    if (v !== undefined && (!Number.isFinite(v) || v <= 0)) {
      throw new RangeError(`agentLoop$ ${name} must be a positive number (got ${String(v)})`);
    }
  }
  const maxIterations = config.maxIterations ?? 10;
  const gate = config.approvalGate ?? DEFAULT_GATE;
  const idPrefix = config.definition.id;

  // ── The choices, recorded (P9) ─────────────────────────────────────────────
  // Both of these change what the model is asked and neither is derivable from
  // the log, which is exactly what `ctx.decide` is for: the decider runs once,
  // its result is journaled, and replay serves the recorded value.

  const skillTools: ToolDefinition[] = [];
  const skillInstructions: string[] = [];
  if (config.skills !== undefined && config.skills.all().length > 0) {
    const selector = config.skillSelector ?? deterministicSkillSelector();
    const registry = config.skills;
    // The selection is journaled as a DECISION in both forms, so replay serves the ids that
    // actually ran — never a re-parse of the recorded model response against the CURRENT
    // registry (a skill added or removed since would change the selected set). For an
    // effect-backed selector the model call inside the decider is still a durable `ctx.execute`
    // frame (authorized, metered, kill-switched, served from the log), not a transient call, so
    // its spend reaches the fold. Switching an in-flight execution from the provider form to
    // the `toolId` form serves the existing `#skills` decision and makes no new call.
    const selected = await ctx.decide<string[]>(`${idPrefix}#skills`, () =>
      selector.effectBacked === true
        ? selector.select(input, registry, {
            invoke: (toolId, request) =>
              ctx.execute(
                { _tag: "TaskDefinition", kind: "llm", id: `${idPrefix}#skills:select`, toolId },
                request
              ) as Promise<LlmResponse>,
          })
        : selector.select(input, registry)
    );
    for (const id of selected) {
      const skill = registry.get(id);
      if (skill === undefined) continue;
      skillInstructions.push(await loadInstructions(skill.instructions));
      if (skill.tools !== undefined) skillTools.push(...skill.tools);
    }
  }

  const system =
    skillInstructions.length > 0
      ? [config.systemPrompt, ...skillInstructions]
          .filter((s) => s != null && s !== "")
          .join("\n\n")
      : config.systemPrompt;

  // The agent's tools plus whatever the selected skills bring, deduped by id
  // (the agent's own win).
  const toolDefs: ToolDefinition[] = [...config.definition.tools];
  const seenToolIds = new Set(toolDefs.map((t) => t.id));
  for (const t of skillTools) {
    if (!seenToolIds.has(t.id)) {
      seenToolIds.add(t.id);
      toolDefs.push(t);
    }
  }
  const tools = toolSpecsFor(toolDefs);
  // R4 — the same definitions the model was shown are the only ones that may run.
  const menu = buildToolMenu(toolDefs);

  const messages: LlmMessageInput[] = [];
  // The virtual (pre-R5-shaped) transcript behind compaction's triggers: `oldSizes` holds one byte
  // size per message the old body would have held; `physOld[i]` is how many of them `messages[i]`
  // stands for (the invariant: they sum to `oldSizes.length`); `transcriptBytes` is their sum. All
  // updated per push, O(1) amortized, never a re-serialization — see the block comment above.
  let oldSizes: number[] = [];
  let physOld: number[] = [];
  let transcriptBytes = 0;
  let inlineUsed = 0;
  const pushMessage = (msg: LlmMessageInput, sizes: readonly number[]): void => {
    messages.push(msg);
    physOld.push(sizes.length);
    for (const b of sizes) {
      oldSizes.push(b);
      transcriptBytes += b;
    }
  };
  const textMessage = (msg: LlmMessageInput & { content: string }): void =>
    pushMessage(msg, [UTF8.encode(msg.content).length]);
  const assistantTurn = (response: { content: string; toolCalls?: readonly LlmToolCall[] }): void =>
    // The old body journaled the placeholder text for a tool-only turn; its length is what it measured.
    pushMessage(assistantMessageOf(response), [
      UTF8.encode(response.content || "(tool calls)").length,
    ]);
  const mediaTools = new Set(toolDefs.filter((t) => t.returnsMedia === true).map((t) => t.id));
  // A `kind: "human"` step consumes its resume answer in call order; a turn holding one keeps the
  // original sequential shape whatever `parallelTools` says (see `runToolCalls`).
  const humanTools = new Set(toolDefs.filter((t) => t.kind === "human").map((t) => t.id));

  if (config.memory !== undefined) {
    const tier = config.memoryTier ?? "working";
    const scope = config.memoryScope ?? ctx.executionId;
    const recalled = await config.memory.recall(tier, scope, {
      ...(config.recallLimit !== undefined && { limit: config.recallLimit }),
      // Passed bare: the context binds `decide` in its constructor, exactly so
      // that a helper taking it as an option gets a working function.
      decide: ctx.decide,
      decisionKey: `${idPrefix}#recall`,
    });
    for (const entry of recalled) {
      if (isTainted(entry.content)) {
        // Written back from a run that saw untrusted content: it stays untrusted. A fenced `user`
        // message, whatever role it was stored under (the guard refuses taint in assistant position).
        pushMessage({ role: "user", content: entry.content as LlmContent }, [
          textBytes(entry.content as LlmContent),
        ]);
        continue;
      }
      textMessage({
        role: entry.role === "assistant" ? "assistant" : "user",
        content: String(entry.content),
      });
    }
  }
  textMessage({
    role: "user",
    content:
      input.context != null
        ? `Context: ${JSON.stringify(input.context)}\n\n${input.prompt}`
        : input.prompt,
  });

  const toolCallLog: AgentStep[] = [];
  let iterations = 0;
  let lastContent = "";

  // ── R10 — stopping, and what a stop carries out ─────────────────────────────
  // The interruption can arrive from several places (a checkpoint, a model call the provider
  // aborted mid-generation, a tool that took too long), and the work already done is worth the
  // same in all of them, so the capture wraps the whole loop rather than each site.
  const partialOf = (err: unknown): string =>
    err instanceof TypedFailure && err.channel === LLM_INTERRUPTED
      ? ((err.payload as { content?: string }).content ?? "")
      : "";
  const interruptedWith = (partial: string): never =>
    fail(
      AGENT_INTERRUPTED,
      { content: partial, iterations, toolCallLog } satisfies InterruptedAgentRun,
      "agent run interrupted"
    );
  const interrupted = (err?: unknown): never => interruptedWith(partialOf(err));
  /**
   * Whether `err` is the signal landing INSIDE a model call (the provider aborted, or the transport
   * threw because the signal fired), as opposed to a failure the runtime owns.
   */
  const abortedInsideCall = (err: unknown): boolean =>
    config.signal?.aborted === true &&
    !isTerminalToolError(err) &&
    !(err instanceof TypedFailure && err.channel === AGENT_INTERRUPTED);
  /**
   * R10 — make a model call's INTERRUPTION a recorded fact (signal configured only). The call itself
   * is journaled (a frame, or a response decision), but a call the signal killed has no recorded
   * outcome, so a replay would re-ask it live and carry on where the first run stopped. This wraps
   * the call in a decision that records `{ interrupted, partial }` instead; the interruption is then
   * raised from the record, identically on every replay.
   */
  type Interrupt = { interrupted: true; partial: string };
  const isInterrupt = (v: unknown): v is Interrupt =>
    typeof v === "object" && v !== null && (v as { interrupted?: unknown }).interrupted === true;
  /**
   * Whether the caller's signal had fired at this checkpoint. With a signal configured the answer is
   * a RECORDED decision (one id per site, so concurrent branches never share a counter), served on
   * replay; with none, nothing is read or written.
   */
  const aborted = async (c: ExecutionContext, site: string): Promise<boolean> => {
    const signal = config.signal;
    if (signal === undefined) return false;
    return c.decide<boolean>(`${idPrefix}#abort:${site}`, () => signal.aborted, {
      source: SOURCE_ABORT,
    });
  };
  /** No further model or tool call is issued once the caller's signal has fired. */
  const checkAbort = async (c: ExecutionContext, site: string): Promise<void> => {
    if (await aborted(c, site)) interrupted();
  };
  /** The signal a DIRECT provider request carries: the caller's, bounded by the turn deadline. */
  const modelCallSignal = (): AbortSignal | undefined => {
    const signals: AbortSignal[] = [];
    if (config.signal !== undefined) signals.push(config.signal);
    if (config.turnTimeoutMs !== undefined) signals.push(AbortSignal.timeout(config.turnTimeoutMs));
    if (signals.length === 0) return undefined;
    return signals.length === 1 ? (signals[0] as AbortSignal) : AbortSignal.any(signals);
  };

  /** A call's outcome as the model will see it: `output` undefined means "not settled yet, run it". */
  interface Outcome {
    output: unknown;
    isError: boolean;
    /** A parallel branch that reached its checkpoint after the stop: it never ran. */
    notRun?: true;
  }
  /** Provenance of the run so far: the origin of the first tainted tool result, if any. */
  let sawTaintFrom: string | undefined;

  /**
   * Everything that can settle a call WITHOUT running it: the oversize refusal, the approval gate,
   * the menu / input check. Pure of the recorded model response plus the approval verdicts, so a
   * replay reproduces it. Returns `undefined` when the call must run.
   */
  const settleBeforeRun = async (
    toolCall: LlmToolCall,
    turn: number,
    j: number,
    tooBig: boolean
  ): Promise<Outcome | undefined> => {
    await checkAbort(ctx, `t${turn}:gate:${j}`);
    let output: unknown;
    let isError = false;
    if (tooBig) {
      output = OVERSIZED_INPUT_REFUSAL;
      isError = true;
    }

    // Mid-loop HITL. The gate is BEFORE the effect, so a declined call never
    // runs — the point of asking.
    if (!tooBig && config.requireApproval?.(toolCall, turn, menu.has(toolCall.name)) === false) {
      // The key carries `idPrefix` (the loop's definition id), so two loops in one flow do not
      // share `#turn:0:tool:0` — a shared key would let one loop's approval read as the other's.
      const gateKey = `${ctx.executionId}#${idPrefix}#turn:${turn}:tool:${j}`;
      // R13 — bind the approval to the exact call parked here (tool + args + position). Tool
      // input is MODEL output: one nested past the canonicalizer's depth cap cannot be digested,
      // and that is not a reason to fail the run — it is a call nobody can be shown, so it is
      // refused and the refusal is fed back to the model like any other.
      let viewDigest: string | undefined;
      let undigestible = false;
      if (config.bindApproval !== false) {
        try {
          viewDigest = approvalViewDigest(gateKey, toolCall.name, toolCall.input);
        } catch {
          undigestible = true;
        }
      }
      if (undigestible) {
        isError = true;
        output = {
          refused: true,
          reason: "the tool input could not be put in front of an approver (too deeply nested)",
        };
      } else {
        const verdict = await ctx.suspend<{ approved?: boolean; reason?: string }>({
          on: gate,
          correlationKey: gateKey,
          ...(viewDigest !== undefined && { viewDigest }),
        });
        if (verdict?.approved !== true) {
          // A refusal is a fact the model should see and settle on, not an error:
          // it asked to do something a human declined, which is information.
          isError = true;
          output = {
            refused: true,
            ...(verdict?.reason !== undefined && { reason: verdict.reason }),
          };
        }
      }
    }

    // R4 — menu + input gate. It sits AFTER the approval gate on purpose: moving it
    // before would change which calls reach `ctx.suspend`, so a resume's
    // passthrough ordering (gate keyed by turn/index) would no longer line up
    // with logs recorded earlier. A refusal is a RESULT fed back to the model (it can
    // recover), computed purely from the recorded model output and the static
    // menu, so replay reproduces it with nothing appended to the log.
    if (output === undefined) {
      const refusal = menu.check(toolCall.name, toolCall.input);
      if (refusal !== undefined) {
        output = refusal;
        isError = true;
      }
    }
    return output === undefined ? undefined : { output, isError };
  };

  /** Set once any call hits an error that must reach the runtime: siblings' noise is then not feedback. */
  let fatalSeen = false;

  /**
   * Run one call as a durable frame on `c` (the context, or a `parallel` branch's).
   *
   * Feedback mode wraps the `execute` in a decision that records its OUTCOME, so a resume serves what
   * the model already consumed instead of re-running a failed tool; the step's output itself is read
   * back from its own (completed) frame, never duplicated into the decision.
   */
  const runTool = async (
    c: ExecutionContext,
    toolCall: LlmToolCall,
    turn: number,
    j: number,
    inBranch: boolean
  ): Promise<Outcome> => {
    // A branch that wakes after the stop does not throw (that would fail the scope and drop the
    // work its siblings completed): it reports "not run" and the interruption is raised after.
    if (await aborted(c, `t${turn}:run:${j}`)) {
      if (inBranch) return { output: undefined, isError: false, notRun: true };
      interrupted();
    }
    const id = `${idPrefix}#turn:${turn}:tool:${j}`;
    const task = {
      _tag: "TaskDefinition",
      kind: "tool",
      id,
      toolId: toolCall.name,
      ...(config.toolTimeoutMs !== undefined && { timeoutMs: config.toolTimeoutMs }),
    } as const;
    const fatal = (err: unknown): boolean =>
      fatalSeen || config.toolErrors === "fail" || isTerminalToolError(err);
    try {
      if (config.toolErrors === "fail" || humanTools.has(toolCall.name)) {
        return { output: await c.execute(task, toolCall.input), isError: false };
      }
      const recorded = await c.decide<{ ok: true } | { failed: unknown } | { error: string }>(
        `${id}:outcome`,
        async () => {
          try {
            await c.execute(task, toolCall.input);
            return { ok: true as const };
          } catch (err) {
            // Authority, safety, park, cancel and divergence are the runtime's: not recorded.
            if (fatal(err)) throw err;
            return { failed: failureOutput(toolCall.name, err) };
          }
        },
        { source: SOURCE_OUTCOME }
      );
      if ("failed" in recorded) return { output: recorded.failed, isError: true };
      // (A pre-fix-round-2 record held the bare string; it is fenced on the way out all the same.)
      if ("error" in recorded) {
        return {
          output: tainted({ error: recorded.error }, errorOrigin(toolCall.name)),
          isError: true,
        };
      }
      // Served from the completed frame (no second run).
      return { output: await c.execute(task, toolCall.input), isError: false };
    } catch (err) {
      // R10 — a failing tool is feedback, not a failed run. Authority, safety, park, cancel and
      // divergence are the runtime's (see `isTerminalToolError`); `toolErrors: "fail"` opts out.
      if (fatal(err)) {
        fatalSeen = true;
        throw err;
      }
      return { output: failureOutput(toolCall.name, err), isError: true };
    }
  };

  /** Execute one turn's tool calls: gate, run, record, feed back. Shared by both model paths. */
  const runToolCalls = async (
    calls: readonly LlmToolCall[],
    turn: number,
    oversized: ReadonlySet<number>
  ): Promise<void> => {
    const results: LlmToolResultPartInput[] = [];
    const record = (toolCall: LlmToolCall, { output, isError }: Outcome): void => {
      if (sawTaintFrom === undefined && isTainted(output)) {
        sawTaintFrom = taintOf(output)?.origin ?? "unknown";
      }
      toolCallLog.push({
        iteration: iterations,
        toolName: toolCall.name,
        toolInput: toolCall.input,
        toolOutput: output,
      });
      const part = toolResultPart(toolCall.id, toolCall.name, output, {
        isError,
        allowMedia: mediaTools.has(toolCall.name),
        inlineBudget: MAX_INLINE_TOTAL_BYTES - inlineUsed,
      });
      inlineUsed += inlineBytesIn(part);
      results.push(part);
    };

    if (parallelTools === false || calls.some((c) => humanTools.has(c.name))) {
      // The original shape, call by call: gate_j, run_j, gate_{j+1}, ...
      for (const [j, toolCall] of calls.entries()) {
        const settled =
          (await settleBeforeRun(toolCall, turn, j, oversized.has(j))) ??
          (await runTool(ctx, toolCall, turn, j, false));
        record(toolCall, settled);
      }
    } else {
      // Approvals first, sequentially and in call order: a turn parked on an approval has run
      // none of its calls, and a resume re-asks the gates in the same order.
      const outcomes: Array<Outcome | undefined> = [];
      const toRun: number[] = [];
      for (const [j, toolCall] of calls.entries()) {
        const settled = await settleBeforeRun(toolCall, turn, j, oversized.has(j));
        outcomes.push(settled);
        if (settled === undefined) toRun.push(j);
      }
      if (toRun.length === 1) {
        const j = toRun[0] as number;
        outcomes[j] = await runTool(ctx, calls[j] as LlmToolCall, turn, j, false);
      } else if (toRun.length > 1) {
        await checkAbort(ctx, `t${turn}:scope`);
        const ran = await ctx.parallel<Outcome[]>(
          toRun.map(
            (j) => (b: BranchContext) => runTool(b, calls[j] as LlmToolCall, turn, j, true)
          ) as never,
          typeof parallelTools === "number" ? { limit: parallelTools } : {}
        );
        for (const [k, j] of toRun.entries()) outcomes[j] = ran[k] as Outcome;
        if (ran.some((o) => o.notRun === true)) {
          // The stop landed while the scope ran: carry out every call that completed (the ones that
          // never started are simply absent), then raise the interruption outside the scope.
          for (const [j, toolCall] of calls.entries()) {
            const o = outcomes[j];
            if (o !== undefined && o.notRun !== true) record(toolCall, o);
          }
          interrupted();
        }
      }
      // Fed back in the model's order, whichever call finished first.
      for (const [j, toolCall] of calls.entries()) record(toolCall, outcomes[j] as Outcome);
    }
    // R5 — ONE user message answers all of the turn's calls, after the assistant message that
    // made them (providers require that adjacency). Pushed only once every call has run, so a
    // park on the approval gate mid-turn leaves the transcript as it was.
    if (results.length > 0)
      pushMessage({ role: "user", content: results }, results.map(resultBytes));
  };

  /** A model call as a durable frame; with a signal, its interruption is a recorded decision too. */
  const modelFrame = async (
    task: ExecutableTask,
    request: AgentModelCall
  ): Promise<LlmResponse> => {
    if (config.signal === undefined) return (await ctx.execute(task, request)) as LlmResponse;
    const recorded = await ctx.decide<{ ok: true } | Interrupt>(
      `${task.id}:interrupt`,
      async () => {
        try {
          await ctx.execute(task, request);
          return { ok: true as const };
        } catch (err) {
          if (abortedInsideCall(err)) return { interrupted: true, partial: partialOf(err) };
          throw err;
        }
      },
      { source: SOURCE_ABORT }
    );
    if ("interrupted" in recorded) return interruptedWith(recorded.partial);
    return (await ctx.execute(task, request)) as LlmResponse; // served from the completed frame
  };

  try {
    while (iterations < maxIterations) {
      await checkAbort(ctx, `t${iterations}:turn`);
      const turn = iterations;
      iterations++;

      // Compact BEFORE the turn's model call, so the summary is what gets asked
      // — compacting after would journal a transcript the model never saw.
      const compaction = config.compaction;
      if (compaction !== undefined) {
        const overMessages =
          compaction.afterMessages !== undefined && oldSizes.length > compaction.afterMessages;
        const overBytes =
          compaction.afterBytes !== undefined && transcriptBytes > compaction.afterBytes;

        if (overMessages || overBytes) {
          const keepRecent = compaction.keepRecent ?? 4;
          // The byte trigger sizes its own kept suffix (longest run ≤ half the
          // budget); the message trigger keeps the original fixed count — G2. Both over the VIRTUAL
          // transcript, so they match what the old body decided.
          const keepOld = overBytes
            ? keptSuffixByBytes(oldSizes, compaction.afterBytes as number, keepRecent)
            : keepRecent;

          if (oldSizes.length - keepOld > 0) {
            // The smallest physical suffix standing for at least `keepOld` virtual messages...
            let keepPhys = 0;
            for (let covered = 0; covered < keepOld && keepPhys < messages.length; ) {
              keepPhys++;
              covered += physOld[messages.length - keepPhys] as number;
            }
            // ...never starting on a `tool_result` message: its `tool_use` would be folded away and the
            // provider rejects an orphan result. Pull the assistant turn in.
            while (
              keepPhys > 0 &&
              keepPhys < messages.length &&
              isToolResultMessage(messages[messages.length - keepPhys] as LlmMessageInput)
            ) {
              keepPhys++;
            }
            const foldLength = messages.length - keepPhys;

            if (foldLength > 0) {
              const fold = messages.slice(0, foldLength);
              const recent = messages.slice(foldLength);
              const { summary } = (await ctx.execute(
                {
                  _tag: "TaskDefinition",
                  kind: "memory",
                  id: `${idPrefix}#turn:${turn}:compact`,
                  toolId: compaction.toolId,
                },
                { messages: fold }
              )) as { summary: string };
              const summaryText = `Summary of earlier turns: ${summary}`;
              // Rebuild the virtual transcript exactly as the old body would hold it: the summary plus
              // its `keepOld` newest messages. Physical messages pulled in beyond that (the alignment's
              // assistant turn) stand for none of them.
              const keptSizes = keepOld > 0 ? oldSizes.slice(oldSizes.length - keepOld) : [];
              let remaining = keepOld;
              const newPhysOld: number[] = new Array(recent.length).fill(0);
              for (let k = recent.length - 1; k >= 0 && remaining > 0; k--) {
                const take = Math.min(physOld[foldLength + k] as number, remaining);
                newPhysOld[k] = take;
                remaining -= take;
              }
              const summarySize = UTF8.encode(summaryText).length;
              messages.length = 0;
              messages.push({ role: "user", content: summaryText }, ...recent);
              physOld = [1, ...newPhysOld];
              oldSizes = [summarySize, ...keptSizes];
              transcriptBytes = oldSizes.reduce((n, b) => n + b, 0);
              inlineUsed = inlineBytesOf(messages);
            }
          }
          // Else the kept suffix already covers the whole transcript — one
          // message alone is over `afterBytes` — so compaction is skipped for
          // this turn rather than paying a summary call that folds nothing.
        }
      }

      const turnRequest = {
        messages,
        ...(tools.length > 0 && { tools }),
        ...(system !== undefined && { system }),
      } satisfies AgentModelCall;

      // Routed turn: the route and each elevation are recorded through the REAL
      // decision seam, so a replay takes the route that ran.
      if (config.reasoning !== undefined) {
        // `callSeq` is per turn; the route + elevation decisions are recorded, so a replay makes
        // the same sequence of calls and finds each frame / decision under the same id.
        let callSeq = 0;
        const reasoningToolId = config.reasoningToolId;
        // R9 — each model call as a journaled effect frame, when a tool id is configured.
        const invoke: ModelInvoker | undefined =
          reasoningToolId === undefined
            ? undefined
            : (route, request) =>
                modelFrame(
                  {
                    _tag: "TaskDefinition",
                    kind: "llm",
                    id: `${idPrefix}#turn:${turn}:call:${callSeq++}`,
                    toolId:
                      typeof reasoningToolId === "string"
                        ? reasoningToolId
                        : reasoningToolId(route.id),
                    ...(config.turnTimeoutMs !== undefined && { timeoutMs: config.turnTimeoutMs }),
                  },
                  request satisfies AgentModelCall
                );
        // R10 — no effect id to journal a frame under, so the RESPONSE is journaled as a decision:
        // a replay serves the recorded answer and the provider is not called, so a completed turn is
        // never re-asked (and cannot answer differently and move the `#turn:<i>:tool:<j>` ids under
        // the log). The runtime still guards the request, checks modalities and keeps its response
        // cache; only the network part (`run`) is wrapped. Bounded (`boundResponse`) and stamped so
        // `@loom/learning` does not read it as a policy choice. Still OUTSIDE the ring: no
        // authorization, metering or kill switch; `reasoningToolId` is how a host gets those.
        const wrapCall: ReasonOptions["wrapCall"] | undefined =
          reasoningToolId === undefined
            ? async (_route, run) => {
                const recorded = await ctx.decide<LlmResponse | Interrupt>(
                  `${idPrefix}#turn:${turn}:response:${callSeq++}`,
                  async () => {
                    try {
                      return boundResponse(await run());
                    } catch (err) {
                      // The signal landed inside the call: record that, not an unrecorded throw.
                      if (config.signal !== undefined && abortedInsideCall(err)) {
                        return { interrupted: true, partial: partialOf(err) } satisfies Interrupt;
                      }
                      throw err;
                    }
                  },
                  { source: SOURCE_RESPONSE }
                );
                if (isInterrupt(recorded)) return interruptedWith(recorded.partial);
                return recorded;
              }
            : undefined;
        const callSignal = modelCallSignal();
        const routed = await config.reasoning.reason(
          { ...turnRequest, strategy: "agent" },
          {
            decide: ctx.decide,
            decisionKey: `${idPrefix}#turn:${turn}`,
            ...(invoke !== undefined && { invoke }),
            ...(wrapCall !== undefined && { wrapCall }),
            ...(callSignal !== undefined && { signal: callSignal }),
            ...(config.cacheScope !== undefined && { cacheScope: config.cacheScope }),
          }
        );
        lastContent = routed.content;
        if (routed.stopReason === "end_turn" || !routed.toolCalls?.length) break;
        const screened = screenToolCalls(routed.toolCalls);
        assistantTurn({ content: routed.content, toolCalls: screened.calls });
        await checkAbort(ctx, `t${turn}:tools`);
        await runToolCalls(screened.calls, turn, screened.oversized);
        continue;
      }

      // One durable frame per turn. On recovery this is served from the log for
      // every turn that completed — the crash at turn 39 costs turn 39, not 1..39.
      const response = await modelFrame(
        {
          _tag: "TaskDefinition",
          kind: "llm",
          id: `${idPrefix}#turn:${turn}`,
          // Non-null by the constructor guard: one of `modelToolId` / `reasoning`
          // is required, and the reasoning path returned above.
          toolId: config.modelToolId as string,
          ...(config.turnTimeoutMs !== undefined && { timeoutMs: config.turnTimeoutMs }),
        },
        {
          messages,
          ...(tools.length > 0 && { tools }),
          ...(system !== undefined && { system }),
        } satisfies AgentModelCall
      );

      lastContent = response.content;
      if (response.stopReason === "end_turn" || !response.toolCalls?.length) break;

      const screened = screenToolCalls(response.toolCalls);
      assistantTurn({ content: response.content, toolCalls: screened.calls });

      await checkAbort(ctx, `t${turn}:tools`);
      await runToolCalls(screened.calls, turn, screened.oversized);
    }
  } catch (err) {
    // Only a STOP is an interruption. A park, an authority / safety error, a kernel cancel and a
    // divergence propagate untouched: the run is not "stopped by the caller", the runtime owns it.
    if (
      config.signal?.aborted === true &&
      !isTerminalToolError(err) &&
      !(err instanceof TypedFailure && err.channel === AGENT_INTERRUPTED)
    ) {
      interrupted(err);
    }
    throw err;
  }

  const wb = config.writeBack;
  if (wb !== undefined && wb !== false && config.memory !== undefined) {
    const o = typeof wb === "object" ? wb : {};
    // The verdict is a recorded decision, so a resume in another process (where the host's flag may
    // read differently) does not flip a write that was, or was not, skipped.
    const skip =
      o.unless === undefined
        ? false
        : await ctx.decide<boolean>(`${idPrefix}#writeback:skip`, () => o.unless?.() === true, {
            source: SOURCE_ABORT,
          });
    if (!skip) {
      const req = writeBackRequest({
        tier: o.tier ?? config.memoryTier ?? "working",
        scope: o.scope ?? config.memoryScope ?? ctx.executionId,
        key: `${ctx.executionId}:${idPrefix}`,
        prompt: input.prompt,
        answer: lastContent,
        ...(sawTaintFrom !== undefined && { taintOrigin: sawTaintFrom }),
      });
      if (o.toolId !== undefined) {
        await ctx.execute(
          {
            _tag: "TaskDefinition",
            kind: "memory",
            id: `${idPrefix}#writeback`,
            toolId: o.toolId,
          },
          req
        );
      } else {
        await applyWriteBack(config.memory, req);
      }
    }
  }

  return { content: lastContent, toolCallLog, iterations };
}

const SOURCE_RESPONSE = "agent-response";
const SOURCE_OUTCOME = "agent-outcome";
const SOURCE_ABORT = "agent-abort";

/** Cap on a recorded error text: a tool's failure message is third-party bytes in the log. */
const MAX_ERROR_CHARS = 2000;
/**
 * What the model reads when a tool fails. Error text is NEVER trusted instructions: an MCP server's
 * remote text, an A2A peer's response body and a database driver's message all arrive inside thrown
 * errors. So it is carried as a tainted value (ADR 0085) and fenced as data at the prompt boundary,
 * and the recorded outcome keeps the taint, so a replay feeds it back fenced too.
 */
const errorOrigin = (toolName: string): string => `tool-error:${toolName}`;
function failureOutput(toolName: string, err: unknown) {
  return tainted({ error: boundedError(err) }, errorOrigin(toolName));
}
function boundedError(err: unknown): string {
  const text = String(err);
  return text.length <= MAX_ERROR_CHARS ? text : `${text.slice(0, MAX_ERROR_CHARS)}[truncated]`;
}

/**
 * Cap on a response recorded as a decision (JSON characters). The effect path claim-checks a large
 * result (ADR 0054); a decision is inline in the log and in the folded state, so a runaway
 * generation is bounded here, deterministically (the bounded value is what is recorded and what a
 * replay serves): the text is cut with a marker. A response whose NON-text part (tool calls) is
 * itself over the cap is refused, because truncating a tool call would run a different call.
 */
/** Raised when the agent loop is configured in a way that is unsafe or contradictory. */
export class AgentLoopConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentLoopConfigError";
    Object.setPrototypeOf(this, AgentLoopConfigError.prototype);
  }
}

/** A model response whose tool calls alone exceed the recordable cap. Nothing is recorded; a resume re-asks. */
export class ResponseTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(
      `agentLoop$: a model response's tool calls exceed ${limit} characters and cannot be recorded; refusing rather than truncating a call`
    );
    this.name = "ResponseTooLargeError";
    Object.setPrototypeOf(this, ResponseTooLargeError.prototype);
  }
}

export const MAX_RECORDED_RESPONSE_CHARS = 256 * 1024;
export function boundResponse(res: LlmResponse): LlmResponse {
  const size = (r: LlmResponse): number => JSON.stringify(r).length;
  if (size(res) <= MAX_RECORDED_RESPONSE_CHARS) return res;
  const marker = `\n[truncated: the response exceeded ${MAX_RECORDED_RESPONSE_CHARS} characters]`;
  const withoutText = size({ ...res, content: marker });
  if (withoutText > MAX_RECORDED_RESPONSE_CHARS) {
    throw new ResponseTooLargeError(MAX_RECORDED_RESPONSE_CHARS);
  }
  let keep = Math.min(res.content.length, MAX_RECORDED_RESPONSE_CHARS - withoutText);
  let out = { ...res, content: res.content.slice(0, keep) + marker };
  while (size(out) > MAX_RECORDED_RESPONSE_CHARS && keep > 0) {
    keep = Math.floor(keep / 2); // JSON escaping can expand text; bounded halving
    out = { ...res, content: res.content.slice(0, keep) + marker };
  }
  return out;
}

interface WriteBackRequest {
  tier: string;
  scope: string;
  entries: { id: string; role: string; content: unknown }[];
}

/**
 * R10 — a finished run's prompt and answer as memory entries with deterministic ids (a hash of the
 * prompt, and of prompt + answer). The answer is stored TAINTED when the run saw untrusted tool
 * output, so a recall never places it in an instruction position.
 */
function writeBackRequest(w: {
  tier: string;
  scope: string;
  key: string;
  prompt: string;
  answer: string;
  taintOrigin?: string;
}): WriteBackRequest {
  return {
    tier: w.tier,
    scope: w.scope,
    entries: [
      { id: `${w.key}:user:${fnv1a64(w.prompt)}`, role: "user", content: w.prompt },
      {
        id: `${w.key}:assistant:${fnv1a64(`${w.prompt}\u0000${w.answer}`)}`,
        role: "assistant",
        content: w.taintOrigin === undefined ? w.answer : tainted(w.answer, w.taintOrigin),
      },
    ],
  };
}

/** Idempotent: a keyed `forget` of the ids, then the append, so a re-run writes nothing twice. */
async function applyWriteBack(memory: TieredMemory, req: WriteBackRequest): Promise<void> {
  await memory.forget(
    req.tier,
    req.scope,
    req.entries.map((e) => e.id)
  );
  for (const entry of req.entries) await memory.remember(req.tier, req.scope, entry);
}

/**
 * R10 — the effect `writeBack.toolId` resolves to: register it on the `EffectRuntime` and the
 * write-back is authorized, metered and kill-switched like any other effect, and journaled.
 */
export function memoryWriteBackEffect(memory: TieredMemory): ToolEffect {
  return new ToolEffect(async (input) => {
    await applyWriteBack(memory, input as WriteBackRequest);
    return { written: (input as WriteBackRequest).entries.length };
  });
}

/** The minimal registration surface of an `EffectRuntime` (`app.effectRuntime`). */
export interface EffectRegistry {
  register(toolId: string, effect: Effect): void;
}

/**
 * R9 — register one model effect per route of `reasoning` under `<prefix>:<routeId>`, and
 * return the route-id → effect-id mapping for {@link AgentLoopConfig.reasoningToolId}:
 *
 * ```ts
 * const toolIdFor = registerReasoningRoutes(app.effectRuntime, reasoning);
 * agentLoop$(ctx, { definition, reasoning, reasoningToolId: toolIdFor }, input);
 * ```
 *
 * Grant each returned id to the flow in the authorizer, exactly as you would `modelToolId`.
 */
export function registerReasoningRoutes(
  effects: EffectRegistry,
  reasoning: ReasoningRuntime,
  options: { prefix?: string; stream?: boolean } = {}
): (routeId: string) => string {
  const prefix = options.prefix ?? "model";
  const toolIdFor = (routeId: string): string => `${prefix}:${routeId}`;
  for (const route of reasoning.availableRoutes) {
    effects.register(
      toolIdFor(route.id),
      createAgentModelEffect(route.provider, {
        ...(options.stream !== undefined && { stream: options.stream }),
      })
    );
  }
  return toolIdFor;
}
