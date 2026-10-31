import { isTainted, taintOf, tainted } from "@loom/classify";
import type { AgentDefinition, ExecutableTask, ToolDefinition } from "@loom/core";
import {
  TypedFailure,
  canonicalJson,
  fail,
  fnv1a64,
  loadInstructions,
  sha256Hex,
} from "@loom/core";
import type { Effect } from "@loom/effect-runtime";
import { ToolEffect } from "@loom/effect-runtime";
import type {
  LlmContent,
  LlmContentPartInput,
  LlmLayoutEntry,
  LlmMessageInput,
  LlmReasoningOptions,
  LlmResponse,
  LlmToolCall,
  LlmToolResultPartInput,
  LlmToolSpecInput,
} from "@loom/llm";
import {
  LLM_INTERRUPTED,
  MAX_INLINE_TOTAL_BYTES,
  assistantMessageOf,
  base64ByteLength,
  hasReasoningParts,
  withoutReasoningParts,
} from "@loom/llm";
import type { TieredMemory } from "@loom/memory";
import type { ModelInvoker, ReasonOptions, ReasoningRuntime } from "@loom/reasoning";
import { approvalViewDigest } from "@loom/workflow-runtime";
import type { BranchContext, DecideOptions, ExecutionContext } from "@loom/workflow-runtime";
import type { SkillRegistry } from "./SkillRegistry";
import { type SkillSelector, deterministicSkillSelector } from "./SkillSelector";
import { createAgentModelEffect } from "./createAgentModelEffect";
import { AGENT_INTERRUPTED, type InterruptedAgentRun } from "./interrupted";
import { OVERSIZED_INPUT_REFUSAL, screenToolCalls } from "./screenToolCalls";
import { type SkillActivationConfig, SkillActivationSession } from "./skillActivation";
import { isTerminalToolError, markToolRaised } from "./toolFailure";
import { inlineBytesIn, toolResultPart } from "./toolResultContent";
import { buildToolMenu, toolSpecFor } from "./toolSchema";
import { type ToolSearchConfig, ToolSearchError, ToolSearchSession } from "./toolSearchSession";
import type { AgentInput, AgentOutput, AgentStep, LeanAgentStep } from "./types";

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

/** Whether a tool call must be parked for human approval. `true` parks, `false` runs it. */
export type NeedsApprovalPolicy = (
  toolCall: LlmToolCall,
  turn: number,
  /** Whether the tool name is on this loop's menu; `false` means the call WILL be refused whatever the answer. */
  onMenu?: boolean
) => boolean;

/**
 * What a tool call must clear before it runs, as the DEPRECATED `requireApproval` reads it: an
 * auto-approve policy where `true` = proceed and `false` = park the loop on a gate. Prefer
 * {@link NeedsApprovalPolicy}, whose polarity is the one its name says.
 */
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
   * R18 (ADR 0124) — the prompt template and model configuration in force, as content-addressed
   * references (`promptVersion` / `modelVersion` from `@loom/learning`). Recorded in the `policy`
   * stamp of each journaled model-response decision (`policy.refs`), so an evaluation can slice
   * trajectories by prompt or model version. Additive and descriptive: a decision's `choice` is the
   * only replay input, so a log with or without it replays identically. Applies to the direct
   * `reasoning` path (where the response is a decision); the effect-ring paths record the call as
   * an effect frame and carry the version on the effect input instead.
   */
  versions?: {
    prompt?: { id: string; version: string };
    model?: { id: string; version: string };
  };
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
   * here. Only the DIRECT (un-ringed) path consults the response cache: REQUIRED when the runtime has
   * a response cache and calls go direct (no `reasoningToolId`), where `agentLoop$` throws
   * {@link AgentLoopConfigError} without it. With `reasoningToolId` (the effect ring) the cache is
   * bypassed, so ring users need not set it and it has no effect for them. Use a per-tenant value; a constant
   * value means every run that uses it shares cache entries. Ignored without `reasoning`.
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
  /**
   * ADR 0133 D7 - refuse (throw {@link AgentLoopConfigError}) when the direct routed path (`reasoning`
   * without `reasoningToolId`) is used with a route whose provider declares `capabilities.reasoning`:
   * that path discards the model's reasoning every turn. Default `false` (a one-time warning instead).
   * `@loom/app`'s `observability.reasoning.requireContinuation` sets the app-wide default.
   */
  requireReasoningContinuation?: boolean;
  /** Where the direct-path reasoning warning goes. Default: the app's `observability.onWarn`, else a process warning. */
  onWarn?: (message: string) => void;
  /**
   * Issue #721 / ADR 0137 - with NO `compaction`, warn ONCE per run (through {@link onWarn}, else the
   * app's `observability.onWarn`, else a process warning `LOOM_AGENT_STATE_GROWTH`) when the running
   * transcript byte count (the one `compaction.afterBytes` reads) exceeds this many UTF-8 bytes. Every turn
   * journals its whole model input, so uncompacted state grows O(turns^2) (see docs/scaling.md,
   * "Agent state growth"). Default {@link DEFAULT_STATE_GROWTH_WARN_BYTES} (256 KiB); `false` turns it
   * off. Report-only: it changes no behaviour, writes nothing to the log, and is a pure function of
   * journaled content (a replay in a fresh process warns again at the same turn). The warning also names the
   * opt-in claim-check of large tool outputs, `defineConfig({ execution: { claimCheck } })` (ADR 0140).
   */
  warnTranscriptBytes?: number | false;
  /**
   * ADR 0142 / issue #732 - the shape of `toolCallLog` in the returned `AgentOutput` (and in the
   * `agentInterrupted` payload). `"full"` (default, byte-identical to before) keeps every
   * `{iteration, toolName, toolInput, toolOutput}`. `"lean"` replaces `toolOutput` with
   * `{status: "ok"|"error", bytes, digest, stepId}`: `stepId` is the tool frame id
   * `<loop>#turn:<i>:tool:<j>`, so the full output stays resolvable from the frame / the log / the
   * ADR 0138 archive, and `digest` is sha256 of `canonicalJson(output)` (null when the output has
   * none: `undefined`, a non-JSON value, or deeper than the canonicalizer's cap). The duplicate of every
   * tool output in the step's `_output` is the single largest part of a finished run's state.
   * The mode is FIXED per loop: an explicit value is journaled (`<loop>#toolCallLog`, a decision) and a resume
   * configured with the other value fails with {@link AgentLoopConfigError}. Unset journals nothing. A non-`"full"`/`"lean"`
   * value throws {@link AgentLoopConfigError}. Readers of `toolOutput` must opt in knowingly.
   */
  toolCallLog?: "full" | "lean";
  systemPrompt?: string;
  /**
   * R17 (ADR 0122) — the id prefix of this loop's frames, decisions and gates. Default: the
   * definition id. Two loops in ONE execution must not share it (the second would be served the
   * first's recorded frames), so a flow that runs a loop per dialogue turn passes a per-turn id.
   */
  loopId?: string;
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
   * (see {@link toolErrors}). Approvals ({@link needsApproval}) are collected sequentially, in
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
   * Park the execution for approval before a tool call this policy flags. Returning `true`
   * suspends on {@link approvalGate}; returning `false` runs the call. The resume payload
   * `{ approved: false }` refuses the call and feeds the refusal back to the model as a tool
   * result, so the agent can settle rather than retry blindly.
   *
   * ```ts
   * needsApproval: (call) => call.name === "drop-table", // only drop-table stops for a human
   * ```
   *
   * A tool declared `kind: "human"` parks by itself (inside its own step, for the human's answer);
   * this policy is independent of that and composes exactly as `requireApproval` did: it is consulted
   * first, so a flagged human tool asks for approval and then for its answer.
   * Anything but an explicit `false` parks, so a policy that forgets to return fails closed.
   * Supplying both this and the deprecated `requireApproval` throws {@link AgentLoopConfigError}.
   *
   * This is the capability `agentStep$` structurally cannot have: a handler
   * cannot suspend, so approval had to be hoisted out of the agent — which is
   * precisely the design the feature exists to avoid.
   */
  needsApproval?: NeedsApprovalPolicy;
  /**
   * @deprecated ADR 0121 amendment (2026-10-10) — use {@link needsApproval}, which has the OPPOSITE
   * polarity. `requireApproval` is an auto-approve policy: `true` = proceed, `false` = PARK, so
   * `requireApproval: (c) => c.name !== "x"` is `needsApproval: (c) => c.name === "x"`. Behaviour
   * and the recorded log are unchanged; using it emits one `LOOM_AGENT_REQUIRE_APPROVAL_DEPRECATED`
   * process warning. Supplying both options throws {@link AgentLoopConfigError}.
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
  /**
   * R22 (ADR 0125) — opt-in tool search. Instead of putting every tool on the menu, offer the model
   * a `search_tools` meta-tool: it searches the host's {@link ToolSearchConfig.catalog} (the agent's
   * own tools and the selected skills' tools stay on the menu from turn 0), and the best matches are added
   * to the menu for the following turns (append-only, so the prompt prefix stays cacheable).
   *
   * Authority is unchanged: a loaded tool still passes the R4 menu gate, the approval hook and the
   * effect ring when called; nothing outside the offered set can be found or loaded; a tool's
   * un-vouched third-party description is neither ranked on nor shown, and a result that names a
   * third-party tool is tainted (ADR 0085). Each search is a recorded decision
   * (`<loop>#turn:<i>:tool:<j>:search`, `source: "agent-tool-search"`), so a replay re-ranks
   * nothing and reproduces the menu. Absent (the default) the run is unchanged, ids included. Not
   * worth enabling below ~30 tools: the menu is cheaper than the extra round trip.
   */
  toolSearch?: ToolSearchConfig;
  /**
   * R22 (ADR 0125 D11) — opt-in mid-loop skill activation. The system prompt gets a cheap, bounded
   * index (id, description, tags) of the skills NOT selected up front, and the model gets an
   * `activate_skill({ name })` meta-tool. The skill's instructions come back AS THE RESULT of that
   * call (the turn-0 prompt is never rewritten, so its cache prefix is stable) and its tools join the
   * menu from the next step (deduped; the menu only grows). Each activation is a recorded decision
   * (`<loop>#turn:<i>:tool:<j>:skill`, `source: "agent-skill-activation"`), so a replay re-applies it
   * without re-deciding. Unknown / already-active / over-cap / oversized / tainted-instruction calls
   * are typed error results and record nothing. Skills are host-registered author text; the upfront
   * `skills` selection is unchanged and combinable. Absent (the default) the run is unchanged.
   *
   * R22b (ADR 0125 D12): `discovery: "search" | "both"` (needs `toolSearch`) makes the whole skill
   * catalog findable through `search_tools` (hits under `skills`, `{ kind: "skill", id, description }`,
   * recorded in the same `agent-tool-search` decision, never loaded by the search; an already-active
   * skill is not a hit) so a registry larger than the index cap stays reachable; `"search"` also
   * replaces the prompt index with one fixed line. The default `"index"` is unchanged.
   */
  skillActivation?: SkillActivationConfig;
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
   *
   * OPT-IN, and uncompacted state grows O(turns^2) (50 turns ~ 3.5 MB of folded state, 200 turns ~ 55 MB; see
   * docs/scaling.md "Agent state growth"): without this option the loop warns once when the transcript
   * passes {@link AgentLoopConfig.warnTranscriptBytes}. `createSummarizerEffect(provider)` is a
   * ready-made effect for `toolId`:
   *
   * ```ts
   * effects.register("summarize", createSummarizerEffect(provider));
   * // ... compaction: { toolId: "summarize", afterBytes: 256 * 1024 }
   * ```
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
/**
 * Default for {@link AgentLoopConfig.warnTranscriptBytes}: 256 KiB (~64k tokens). [measured, offline
 * harness, cloning store] An uncompacted run counts ~2.5 kB of transcript per turn and holds 3.5 MB of
 * folded state at turn 50 (128 kB transcript) and 54.9 MB at turn 200 (500 kB). 256 KiB is turn ~107 and
 * ~16 MB of state: early enough to act on, still above every short-lived agent. A 1 MB transcript is turn
 * ~450 and ~280 MB, past a Postgres JSONB value's 255 MB cap.
 */
export const DEFAULT_STATE_GROWTH_WARN_BYTES = 256 * 1024;

/**
 * Send a loop warning to the loop's own sink, else the app's, else a process warning. A broken sink never
 * fails the run: a throw (or a rejecting Promise a sink returned) is swallowed, and so is a failing
 * `process.emitWarning`.
 */
function emitLoopWarning(config: AgentLoopConfig, message: string, code: string): void {
  try {
    const sink = config.onWarn ?? loopDefaultsSlot().onWarn;
    if (sink !== undefined) {
      try {
        const returned: unknown = sink(message);
        // A sink that returns a rejecting Promise must not become an unhandled rejection.
        if (typeof (returned as { then?: unknown } | undefined)?.then === "function") {
          (returned as PromiseLike<unknown>).then(undefined, () => undefined);
        }
        return;
      } catch {
        // fall through to the process warning
      }
    }
    const proc = (globalThis as { process?: { emitWarning?: (m: string, o?: object) => void } })
      .process;
    proc?.emitWarning?.(message, { code });
  } catch {
    // a warning is advisory: nothing here may fail the run
  }
}

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

// ── ADR 0133 D7 - the direct routed path discards reasoning every turn ─────────
type LoopDefaults = {
  onWarn?: ((m: string) => void) | undefined;
  requireReasoningContinuation?: boolean | undefined;
};
// Process-wide, but keyed on a global symbol so a duplicate copy of @loom/agent shares ONE slot
// instead of silently configuring a copy the loop never reads.
const LOOP_DEFAULTS_KEY = Symbol.for("loom.agent.loopDefaults");
function loopDefaultsSlot(): LoopDefaults {
  const g = globalThis as { [LOOP_DEFAULTS_KEY]?: LoopDefaults };
  let slot = g[LOOP_DEFAULTS_KEY];
  if (slot === undefined) {
    slot = {};
    g[LOOP_DEFAULTS_KEY] = slot;
  }
  return slot;
}
/**
 * App-wide defaults for `agentLoop$` options that an app (not each call site) owns. `@loom/app`'s
 * `defineConfig` calls this with `observability.onWarn` (only when the app gave one) and
 * `observability.reasoning.requireContinuation`. FAIL-CLOSED: `requireReasoningContinuation: true` is
 * monotonic (once any caller in the process sets it, no later call clears it; use
 * {@link resetAgentLoopDefaults}, test-only), and an omitted field leaves the earlier value alone.
 * `onWarn` is last-wins. A loop's own option always wins.
 */
export function configureAgentLoopDefaults(defaults: {
  onWarn?: (message: string) => void;
  requireReasoningContinuation?: boolean;
}): void {
  const slot = loopDefaultsSlot();
  if (defaults.onWarn !== undefined) slot.onWarn = defaults.onWarn;
  if (defaults.requireReasoningContinuation === true) slot.requireReasoningContinuation = true;
}

/**
 * @internal TEST-ONLY. Clears the process-wide `agentLoop$` defaults, including another app's
 * `requireReasoningContinuation: true` (a fail-closed setting an app never un-requires). Exported
 * only because tests in sibling packages and repos need a clean slate; production code must not call it.
 */
export function resetAgentLoopDefaults(): void {
  const slot = loopDefaultsSlot();
  slot.onWarn = undefined;
  slot.requireReasoningContinuation = undefined;
}

const warnedDirectReasoning = new WeakSet<object>();
/**
 * ADR 0133 D7 - the direct routed path (`reasoning` with no `reasoningToolId`) records no reasoning
 * and sends no thinking block back, so a reasoning-capable route loses its reasoning every turn (the
 * vendor's documented one-time recovery shape, not a steady state). Warn once per runtime, or refuse.
 */
function checkDirectPathReasoning(config: AgentLoopConfig): boolean {
  const runtime = config.reasoning;
  if (runtime === undefined || config.reasoningToolId !== undefined) return false;
  const capable = runtime.availableRoutes
    .filter((r) => r.provider.capabilities?.reasoning === true)
    .map((r) => r.id);
  if (capable.length === 0) return false;
  const named = capable.map((id) => `"${id}"`).join(", ");
  const refuse =
    config.requireReasoningContinuation ?? loopDefaultsSlot().requireReasoningContinuation;
  if (refuse === true) {
    throw new AgentLoopConfigError(
      `agentLoop$: route ${named} can return model reasoning, but the direct routed path (no \`reasoningToolId\`) discards it every turn. Set \`reasoningToolId\` (see registerReasoningRoutes) to carry it, or drop \`requireReasoningContinuation\`.`
    );
  }
  // `requireEffectRing` throws its own error just below: one condition, one message.
  if (config.requireEffectRing === true) return false;
  if (warnedDirectReasoning.has(runtime)) return true;
  warnedDirectReasoning.add(runtime);
  const message = `agentLoop$: route ${named} can return model reasoning, but the direct routed path (no \`reasoningToolId\`) discards it every turn (the model never gets its earlier thinking back). Set \`reasoningToolId\` (see registerReasoningRoutes) to carry it.`;
  const sink = config.onWarn ?? loopDefaultsSlot().onWarn;
  if (sink !== undefined) {
    try {
      sink(message);
      return true;
    } catch {
      // A broken warning sink must never fail the run: fall through to the process warning.
    }
  }
  const proc = (globalThis as { process?: { emitWarning?: (m: string, o?: object) => void } })
    .process;
  proc?.emitWarning?.(message, { code: "LOOM_AGENT_REASONING_DISCARDED" });
  return true;
}

let warnedRequireApproval = false;
/** One advisory per process: `requireApproval` is the deprecated, inverted-polarity spelling. */
function warnRequireApprovalDeprecated(): void {
  if (warnedRequireApproval) return;
  warnedRequireApproval = true;
  const proc = (globalThis as { process?: { emitWarning?: (m: string, o?: object) => void } })
    .process;
  proc?.emitWarning?.(
    "agentLoop$: `requireApproval` is deprecated; use `needsApproval`, which has the opposite polarity (`true` PARKS for approval, `false` runs). `requireApproval: (c) => c.name !== 'x'` is `needsApproval: (c) => c.name === 'x'`.",
    { code: "LOOM_AGENT_REQUIRE_APPROVAL_DEPRECATED", type: "DeprecationWarning" }
  );
}

/** The single place both spellings meet: does this call park? (`needsApproval` fails closed.) */
function parksForApproval(
  config: AgentLoopConfig,
  toolCall: LlmToolCall,
  turn: number,
  onMenu: boolean
): boolean {
  if (config.needsApproval !== undefined)
    return config.needsApproval(toolCall, turn, onMenu) !== false;
  return config.requireApproval?.(toolCall, turn, onMenu) === false;
}

/** Test seam: re-arm the one-time `requireApproval` deprecation warning. */
export function resetRequireApprovalWarning(): void {
  warnedRequireApproval = false;
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
    case "reasoning":
      // ADR 0133 D5: zero bytes, so a run recorded before reasoning parts existed and resumed
      // after compacts on the same turns.
      return 0;
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

/** The virtual size of a message, as the measure above counts its parts. */
function messageBytes(msg: LlmMessageInput): number {
  return Array.isArray(msg.content)
    ? msg.content.reduce((n, p) => n + partBytes(p), 0)
    : textBytes(msg.content);
}

/**
 * ADR 0133 D5 - the single user message that starts the request after a SIMPLE compaction: the summary,
 * then the in-flight round (everything after the latest assistant turn) as text, so no `tool_use`
 * stays open and no `tool_result` is orphaned. Result content keeps its own part (a tainted text
 * stays tainted, so the prompt boundary fences it exactly as it fences a tool result); media parts
 * pass through (a user message may carry them). Only trusted labels are added around them.
 */
function simpleCompactionMessage(
  summary: LlmContent,
  transcript: readonly LlmMessageInput[]
): LlmMessageInput {
  const parts: LlmContentPartInput[] = [{ type: "text", text: summary }];
  let last = -1;
  for (let i = transcript.length - 1; i >= 0; i--) {
    if ((transcript[i] as LlmMessageInput).role === "assistant") {
      last = i;
      break;
    }
  }
  const names = new Map<string, string>();
  if (last >= 0) {
    const content = (transcript[last] as LlmMessageInput).content;
    if (Array.isArray(content)) {
      for (const p of content) if (p.type === "tool_use") names.set(p.id, p.name);
    }
  }
  const tail = last >= 0 ? transcript.slice(last + 1) : [];
  for (const m of tail) {
    if (!Array.isArray(m.content)) {
      parts.push({ type: "text", text: m.content });
      continue;
    }
    for (const p of m.content) {
      if (p.type === "tool_result") {
        const label = `Result of ${names.get(p.toolUseId) ?? "a tool call"} (call ${p.toolUseId})${p.isError === true ? " [error]" : ""}:`;
        parts.push({ type: "text", text: label });
        if (Array.isArray(p.content)) parts.push(...p.content);
        else parts.push({ type: "text", text: p.content });
      } else if (p.type !== "tool_use" && p.type !== "reasoning") {
        parts.push(p);
      }
    }
  }
  return { role: "user", content: parts };
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

/** Decoded inline bytes of the top-level media parts of a simple-compaction frame (ADR 0133 D5). */
function inlineBytesInFrame(frame: LlmMessageInput): number {
  if (!Array.isArray(frame.content)) return 0;
  let n = 0;
  for (const p of frame.content) {
    if (
      (p.type === "image" || p.type === "audio" || p.type === "file") &&
      p.source.kind === "data"
    ) {
      n += base64ByteLength(p.source.data) ?? 0;
    }
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
  if (config.needsApproval !== undefined && config.requireApproval !== undefined) {
    throw new AgentLoopConfigError(
      "agentLoop$: supply `needsApproval` OR the deprecated `requireApproval`, not both (they have opposite polarity)"
    );
  }
  if (config.requireApproval !== undefined) warnRequireApprovalDeprecated();
  if (config.modelToolId === undefined && config.reasoning === undefined) {
    // Refused up front rather than running zero turns and returning an empty
    // answer, which is what an absent model access would otherwise look like.
    throw new Error("agentLoop$ requires a `modelToolId` or a `reasoning` runtime");
  }
  // The reasoning-discarded advisory names the same remedy (`reasoningToolId`), so when it covers
  // this path the ring advisory stays quiet: one message for one condition.
  const directReasoningCovered = checkDirectPathReasoning(config);
  if (
    !directReasoningCovered &&
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
  if (
    config.reasoning?.hasResponseCache === true &&
    config.reasoningToolId === undefined &&
    config.cacheScope === undefined
  ) {
    // The direct path consults the runtime's response cache, keyed on the request as written. A runner
    // body cannot read its principal, so without a scope two tenants asking the same thing would share
    // an answer. Fail closed: sharing must be a decision.
    throw new AgentLoopConfigError(
      "agentLoop$: the ReasoningRuntime has a response cache, so `cacheScope` is required (use a per-tenant value; a constant value means every run using it shares entries)"
    );
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
  const idPrefix = config.loopId ?? config.definition.id;
  if (
    config.toolCallLog !== undefined &&
    config.toolCallLog !== "full" &&
    config.toolCallLog !== "lean"
  ) {
    throw new AgentLoopConfigError(
      `agentLoop$: toolCallLog must be "full" or "lean" (got ${String(config.toolCallLog)})`
    );
  }
  const lean = config.toolCallLog === "lean";
  if (config.toolCallLog !== undefined) {
    // Pin an EXPLICIT mode for the life of the loop: it is journaled once and served on replay, and a
    // resume configured with the other mode is refused rather than silently producing the other
    // shape. (An unset option journals nothing, so the default's log is byte-identical to before;
    // it is therefore not checked, and cannot detect a recorded "lean".)
    const recorded = await ctx.decide<"full" | "lean">(
      `${idPrefix}#toolCallLog`,
      () => config.toolCallLog as "full" | "lean",
      { source: "agent-tool-call-log" }
    );
    if (recorded !== config.toolCallLog) {
      throw new AgentLoopConfigError(
        `agentLoop$: this loop recorded toolCallLog "${recorded}" but is configured "${String(config.toolCallLog)}"; the mode is fixed for the life of a run (ADR 0142 D3)`
      );
    }
  }

  // ── The choices, recorded (P9) ─────────────────────────────────────────────
  // Both of these change what the model is asked and neither is derivable from
  // the log, which is exactly what `ctx.decide` is for: the decider runs once,
  // its result is journaled, and replay serves the recorded value.

  const skillTools: ToolDefinition[] = [];
  const selectedSkillIds = new Set<string>();
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
      selectedSkillIds.add(id);
      const skill = registry.get(id);
      if (skill === undefined) continue;
      skillInstructions.push(await loadInstructions(skill.instructions));
      if (skill.tools !== undefined) {
        skillTools.push(...skill.tools);
      }
    }
  }

  let system =
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
  // R22 — with tool search the menu STARTS as definition.tools + the selected skills' tools (user
  // ruling: they stay on the menu as without toolSearch) + `alwaysLoaded` catalog entries, and grows
  // by recorded searches over the host `catalog` only.
  let search: ToolSearchSession | undefined;
  if (config.toolSearch !== undefined) {
    search = new ToolSearchSession(config.toolSearch, toolDefs);
    toolDefs.push(...search.initial);
  }
  // R22 D11 — skill activation: the index joins the turn-0 system prompt (fixed for the run), the
  // meta-tool joins the leading specs. Omitted entirely when nothing is left to activate.
  let activation: SkillActivationSession | undefined;
  if (config.skillActivation !== undefined) {
    const a = new SkillActivationSession(config.skillActivation, {
      registry: config.skills,
      selected: selectedSkillIds,
      reservedNames: [
        ...toolDefs.map((t) => t.id),
        ...(config.toolSearch?.catalog ?? []).map((t) => t.id),
        ...(search !== undefined ? [search.name] : []),
      ],
      ...(search !== undefined && {
        search: { name: search.name },
      }),
    });
    // The two meta-tools share one menu: a skill that brings a tool named like the search meta-tool
    // would put two entries of the same name on the menu once activated.
    if (search !== undefined && a.offeredToolIds().has(search.name)) {
      throw new ToolSearchError(
        `toolSearch.searchToolName "${search.name}" collides with a tool an offered skill brings`
      );
    }
    if (a.hasOffers) {
      activation = a;
      // R22b: skills found through search (a no-op for the default `discovery: "index"`).
      if (a.discovery !== "index") search?.attachSkills(a);
      system = [system, a.indexText()].filter((x) => x != null && x !== "").join("\n\n");
    }
  }
  const tools = toolSpecsFor(toolDefs);
  if (activation !== undefined) {
    tools.unshift({
      ...activation.metaSpec,
      description: activation.metaSpec.description as LlmContent,
    });
  }
  if (search !== undefined) {
    // The meta-tool leads, and the menu only ever grows at the END: stable prefix, cache-friendly.
    tools.unshift({ ...search.metaSpec, description: search.metaSpec.description as LlmContent });
  }
  // R4 — the same definitions the model was shown are the only ones that may run.
  let menu = buildToolMenu(toolDefs);

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
  // ADR 0133 D5 - which route produced a message's reasoning parts (routed turns only), by index in
  // `messages` (the guarded request copies lose object identity; compaction drops them all and clears this). A same-provider
  // model switch must not send one model's blocks to another (Anthropic binds a block to its model).
  const reasonedBy = new Map<number, string>();
  const assistantTurn = (
    response: {
      content: string;
      toolCalls?: readonly LlmToolCall[];
      reasoning?: readonly object[];
      layout?: readonly LlmLayoutEntry[];
    },
    modelId?: string
  ): void => {
    const msg = assistantMessageOf(response);
    if (modelId !== undefined && hasReasoningParts(msg)) reasonedBy.set(messages.length, modelId);
    // The old body journaled the placeholder text for a tool-only turn; its length is what it measured.
    pushMessage(msg, [UTF8.encode(response.content || "(tool calls)").length]);
  };
  const mediaTools = new Set(toolDefs.filter((t) => t.returnsMedia === true).map((t) => t.id));
  // A `kind: "human"` step consumes its resume answer in call order; a turn holding one keeps the
  // original sequential shape whatever `parallelTools` says (see `runToolCalls`).
  const humanTools = new Set(toolDefs.filter((t) => t.kind === "human").map((t) => t.id));
  const menuIds = new Set(toolDefs.map((t) => t.id));
  /** R22 — append tools a search loaded: spec at the END of the list, menu gate and tool classes updated. */
  const growMenu = (incoming: readonly ToolDefinition[]): void => {
    // Deduped against the menu (a skill may bring a tool already there); only genuinely new ids grow it.
    const added: ToolDefinition[] = [];
    for (const t of incoming) {
      if (menuIds.has(t.id)) continue;
      menuIds.add(t.id);
      added.push(t);
    }
    if (added.length === 0) return;
    toolDefs.push(...added);
    tools.push(...toolSpecsFor(added));
    // ADR 0133 D5 - a provider's reasoning signature binds the SET of tools, so every block produced
    // under the old menu is invalid under the new one. Drop them all from the transcript for good
    // (tool-call signatures stay); turns after this one carry fresh, valid blocks. A pure function of
    // the recorded search/activation result, so a replay lands on the same transcript.
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i] as LlmMessageInput;
      const stripped = withoutReasoningParts(m);
      if (stripped !== m) messages[i] = stripped;
    }
    reasonedBy.clear();
    menu = buildToolMenu(toolDefs);
    for (const t of added) {
      if (t.returnsMedia === true) mediaTools.add(t.id);
      if (t.kind === "human") humanTools.add(t.id);
    }
  };

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
  // R17 (ADR 0122) — earlier turns of a dialogue, then the prompt. Untrusted content (an end user's
  // words) is tainted here, so the prompt boundary fences it and refuses it outside a `user` message.
  for (const h of input.history ?? []) {
    const content: LlmContent = h.origin !== undefined ? tainted(h.content, h.origin) : h.content;
    pushMessage({ role: h.role, content }, [textBytes(content)]);
  }
  if (input.promptOrigin !== undefined) {
    if (input.context != null) {
      throw new AgentLoopConfigError(
        "agentLoop$: `promptOrigin` (untrusted prompt) cannot be combined with `context`"
      );
    }
    const content = tainted(input.prompt, input.promptOrigin);
    pushMessage({ role: "user", content }, [textBytes(content)]);
  } else {
    textMessage({
      role: "user",
      content:
        input.context != null
          ? `Context: ${JSON.stringify(input.context)}\n\n${input.prompt}`
          : input.prompt,
    });
  }

  const toolCallLog: (AgentStep | LeanAgentStep)[] = [];
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
      {
        content: partial,
        iterations,
        toolCallLog: toolCallLog as AgentStep[] | LeanAgentStep[],
      } satisfies InterruptedAgentRun,
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
    /** D14 — the size compaction's byte trigger counts for this result, when not its own (a changed skill text on replay). */
    virtualBytes?: number;
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
    // R22 — the meta-tool is the loop's own: no effect, no approval (it changes what may be asked,
    // not what runs; every tool it loads is still gated when called). Handled here, in the
    // sequential settle phase, so menu growth is ordered by the model's call order on every path.
    if (!tooBig && search?.isSearchCall(toolCall.name) === true) {
      const r = await search.run(ctx, `${idPrefix}#turn:${turn}:tool:${j}:search`, toolCall.input);
      growMenu(r.newlyLoaded);
      return { output: r.output, isError: r.isError };
    }
    // R22 D11 — activating a skill: instructions are the RESULT; its tools join the menu. Like the
    // search it needs no approval (it grants no authority: every loaded tool is gated when called).
    if (!tooBig && activation?.isActivationCall(toolCall.name) === true) {
      const r = await activation.run(
        ctx,
        `${idPrefix}#turn:${turn}:tool:${j}:skill`,
        toolCall.input
      );
      growMenu(r.newlyLoaded);
      search?.noteLoaded(r.newlyLoaded);
      return {
        output: r.output,
        isError: r.isError,
        ...(r.virtualBytes !== undefined && { virtualBytes: r.virtualBytes }),
      };
    }

    if (!tooBig && parksForApproval(config, toolCall, turn, menu.has(toolCall.name))) {
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
            if (fatal(err)) {
              markToolRaised(err);
              throw err;
            }
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
        markToolRaised(err);
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
    const sizes: number[] = [];
    const record = (
      toolCall: LlmToolCall,
      j: number,
      { output, isError, virtualBytes }: Outcome
    ): void => {
      if (sawTaintFrom === undefined && isTainted(output)) {
        sawTaintFrom = taintOf(output)?.origin ?? "unknown";
      }
      toolCallLog.push(
        lean
          ? {
              iteration: iterations,
              toolName: toolCall.name,
              toolInput: toolCall.input,
              ...leanOutputFields(output, isError, `${idPrefix}#turn:${turn}:tool:${j}`),
            }
          : {
              iteration: iterations,
              toolName: toolCall.name,
              toolInput: toolCall.input,
              toolOutput: output,
            }
      );
      const part = toolResultPart(toolCall.id, toolCall.name, output, {
        isError,
        allowMedia: mediaTools.has(toolCall.name),
        inlineBudget: MAX_INLINE_TOTAL_BYTES - inlineUsed,
      });
      inlineUsed += inlineBytesIn(part);
      results.push(part);
      sizes.push(virtualBytes ?? resultBytes(part));
    };

    if (parallelTools === false || calls.some((c) => humanTools.has(c.name))) {
      // The original shape, call by call: gate_j, run_j, gate_{j+1}, ...
      for (const [j, toolCall] of calls.entries()) {
        const settled =
          (await settleBeforeRun(toolCall, turn, j, oversized.has(j))) ??
          (await runTool(ctx, toolCall, turn, j, false));
        record(toolCall, j, settled);
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
      } else if (toRun.some((j) => humanTools.has((calls[j] as LlmToolCall).name))) {
        // R22 — the settle phase above can GROW the menu (a search / skill activation bringing a
        // `kind: "human"` tool), so the choice made before it read a stale `humanTools`. A turn that
        // holds a human call stays sequential, in call order (R10 P3-7): its resume answer is
        // consumed in call order.
        for (const j of toRun) {
          outcomes[j] = await runTool(ctx, calls[j] as LlmToolCall, turn, j, false);
        }
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
            if (o !== undefined && o.notRun !== true) record(toolCall, j, o);
          }
          interrupted();
        }
      }
      // Fed back in the model's order, whichever call finished first.
      for (const [j, toolCall] of calls.entries()) record(toolCall, j, outcomes[j] as Outcome);
    }
    // R5 — ONE user message answers all of the turn's calls, after the assistant message that
    // made them (providers require that adjacency). Pushed only once every call has run, so a
    // park on the approval gate mid-turn leaves the transcript as it was.
    if (results.length > 0) pushMessage({ role: "user", content: results }, sizes);
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

  /**
   * ADR 0133 D5 - a model request for `routeId`: reasoning parts produced by a DIFFERENT route are
   * dropped (a same-provider switch included: Anthropic binds a block to its model; other providers'
   * parts are already omitted by the provider mapping). Pure over the journaled transcript and the
   * recorded route decisions, so a replay builds the same request. The same object when nothing drops.
   */
  const forRoute = <R extends { messages: readonly LlmMessageInput[] }>(
    request: R,
    routeId: string
  ): R => {
    let changed = false;
    const next = request.messages.map((m, i) => {
      const by = reasonedBy.get(i);
      if (by === undefined || by === routeId) return m;
      changed = true;
      return withoutReasoningParts(m);
    });
    return changed ? { ...request, messages: next } : request;
  };

  let warnedStateGrowth = false;
  const warnBytes = config.warnTranscriptBytes ?? DEFAULT_STATE_GROWTH_WARN_BYTES;
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

            if (foldLength > 0 && messages.some(hasReasoningParts)) {
              // ADR 0133 D5 - the transcript carries reasoning, and a provider's signature binds every
              // earlier message, so a kept tail (or an open tool round) cannot stay valid after the prefix
              // is replaced. SIMPLE compaction: the summary covers the WHOLE transcript, the in-flight
              // round included, and the next request is one user message (summary + that round's
              // results): no assistant turn, no thinking block, no open tool_use. A pure function of the
              // journaled transcript; a transcript without reasoning never reaches this branch.
              const fold = messages.map(withoutReasoningParts);
              const compacted = await ctx.execute(
                {
                  _tag: "TaskDefinition",
                  kind: "memory",
                  id: `${idPrefix}#turn:${turn}:compact`,
                  toolId: compaction.toolId,
                },
                { messages: fold }
              );
              assertNotClaimChecked("compaction", compaction.toolId, compacted);
              const { summary } = compacted as { summary: string };
              const summaryText = `Summary of earlier turns: ${summary}`;
              const summaryContent: LlmContent = JSON.stringify(fold).includes('"__loomTainted"')
                ? tainted(summaryText, "agent:compaction-summary")
                : summaryText;
              const frame = simpleCompactionMessage(summaryContent, messages);
              messages.length = 0;
              reasonedBy.clear();
              messages.push(frame);
              physOld = [1];
              oldSizes = [messageBytes(frame)];
              transcriptBytes = oldSizes[0] as number;
              // The frame flattens result media into top-level parts; they still ride inline in the request.
              inlineUsed = inlineBytesOf(messages) + inlineBytesInFrame(frame);
            } else if (foldLength > 0) {
              // ADR 0133 D5 - no reasoning on the transcript: the keep-tail shape, unchanged.
              const fold = messages.slice(0, foldLength).map(withoutReasoningParts);
              const recent = messages.slice(foldLength).map(withoutReasoningParts);
              const compacted = await ctx.execute(
                {
                  _tag: "TaskDefinition",
                  kind: "memory",
                  id: `${idPrefix}#turn:${turn}:compact`,
                  toolId: compaction.toolId,
                },
                { messages: fold }
              );
              assertNotClaimChecked("compaction", compaction.toolId, compacted);
              const { summary } = compacted as { summary: string };
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
              reasonedBy.clear();
              // R17 (ADR 0122) — a summary written over content any of which was untrusted is itself
              // model output derived from untrusted text. Re-inserted as a plain `user` message it would
              // shed the fence; carry the taint so the prompt boundary keeps fencing it.
              const summaryContent: LlmContent = JSON.stringify(fold).includes('"__loomTainted"')
                ? tainted(summaryText, "agent:compaction-summary")
                : summaryText;
              messages.push({ role: "user", content: summaryContent }, ...recent);
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

      if (
        compaction === undefined &&
        !warnedStateGrowth &&
        warnBytes !== false &&
        transcriptBytes > warnBytes
      ) {
        warnedStateGrowth = true;
        emitLoopWarning(
          config,
          `agentLoop$: the transcript is ${transcriptBytes} bytes by the loop's compaction measure (> ${warnBytes}; text and tool-result bytes, not JSON size), every turn's whole model input is journaled, and this loop has no \`compaction\`, so its journaled state grows O(turns^2) and resume reads it all. Set \`compaction: { toolId, afterBytes }\` (\`createSummarizerEffect(provider)\` is a ready-made toolId); to also shrink the tool outputs (about 80% of the state) opt in to claim-check with \`defineConfig({ execution: { claimCheck: { store, toolIds } } })\` (ADR 0140), which WITHHOLDS an offloaded tool's result from the model except its digest/preview, so list only tools whose output the model does not need in full; see docs/scaling.md "Agent state growth". Silence with \`warnTranscriptBytes: false\`.`,
          "LOOM_AGENT_STATE_GROWTH"
        );
      }

      // Issue #722 - what this turn SENDS is journaled as the step's input, and the kernel journals the
      // reference it is handed (a store may serialize after `append` returns). The loop keeps pushing to
      // `messages` (and growing `tools`) after the turn, so hand over a per-turn copy: a message object is
      // never mutated once pushed (the transcript only changes by push / replace-slot / truncate), so a
      // shallow copy of each array is a faithful snapshot.
      const turnRequest = {
        messages: [...messages],
        ...(tools.length > 0 && { tools: [...tools] }),
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
                  forRoute(request, route.id) satisfies AgentModelCall
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
                      // ADR 0133 - this path has no sidecar to keep reasoning text in and is not an
                      // effect, so the decision record never carries it (readable text stays out of
                      // the journal). Tool-call signatures stay; reasoning blocks are not continued.
                      const { reasoning: _dropped, layout: _order, ...answer } = await run();
                      return boundResponse(answer);
                    } catch (err) {
                      // The signal landed inside the call: record that, not an unrecorded throw.
                      if (config.signal !== undefined && abortedInsideCall(err)) {
                        return { interrupted: true, partial: partialOf(err) } satisfies Interrupt;
                      }
                      throw err;
                    }
                  },
                  {
                    source: SOURCE_RESPONSE,
                    ...(config.versions !== undefined && {
                      policy: {
                        id: "agent-llm",
                        version: config.versions.model?.version ?? "unversioned",
                        refs: config.versions,
                      } as NonNullable<DecideOptions["policy"]>,
                    }),
                  }
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
        assistantTurn(
          {
            content: routed.content,
            toolCalls: screened.calls,
            ...(routed.reasoning !== undefined && { reasoning: routed.reasoning }),
            ...(routed.layout !== undefined && { layout: routed.layout }),
          },
          routed.modelId
        );
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
        turnRequest
      );

      assertNotClaimChecked("model", config.modelToolId, response);
      lastContent = response.content;
      if (response.stopReason === "end_turn" || !response.toolCalls?.length) break;

      const screened = screenToolCalls(response.toolCalls);
      assistantTurn({
        content: response.content,
        toolCalls: screened.calls,
        ...(response.reasoning !== undefined && { reasoning: response.reasoning }),
        ...(response.layout !== undefined && { layout: response.layout }),
      });

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

  return {
    content: lastContent,
    toolCallLog: toolCallLog as AgentStep[] | LeanAgentStep[],
    iterations,
  };
}

/**
 * ADR 0142 D2 - the lean log entry's description of a tool output. The output is first taken through
 * its JSON round trip (`JSON.parse(JSON.stringify(output))`): that is the form a JSON event store
 * records and a resumed run reads back (a `Date` is its ISO string, a `Map` is `{}`, `toJSON` is
 * honoured), so `digest` - sha256 (hex) of `canonicalJson` of it (@loom/core: sorted keys, no whitespace)
 * - equals the canonical form of the output the log holds, live or resumed. `bytes` is its UTF-8 length.
 * An output JSON cannot represent (`undefined`, a function, a bigint, a cycle, or deeper than the
 * canonicalizer's cap) has `digest: null, bytes: 0`: the entry never throws.
 */
function leanOutputFields(
  output: unknown,
  isError: boolean,
  stepId: string
): { status: "ok" | "error"; bytes: number; digest: string | null; stepId: string } {
  let bytes = 0;
  let digest: string | null = null;
  try {
    const text = canonicalJson(JSON.parse(JSON.stringify(output)));
    bytes = new TextEncoder().encode(text).length;
    digest = sha256Hex(text);
  } catch {
    // no canonical form
  }
  return { status: isError ? "error" : "ok", bytes, digest, stepId };
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
  options: { prefix?: string; stream?: boolean; reasoning?: LlmReasoningOptions } = {}
): (routeId: string) => string {
  const prefix = options.prefix ?? "model";
  const toolIdFor = (routeId: string): string => `${prefix}:${routeId}`;
  for (const route of reasoning.availableRoutes) {
    effects.register(
      toolIdFor(route.id),
      createAgentModelEffect(route.provider, {
        ...(options.stream !== undefined && { stream: options.stream }),
        // ADR 0133 - one store/policy for every route; the route id is what the audit event records as the model.
        ...(options.reasoning !== undefined && {
          reasoning: { ...options.reasoning, model: options.reasoning.model ?? route.id },
        }),
      })
    );
  }
  return toolIdFor;
}

/**
 * ADR 0140 - the model turn and the compaction summary are read INLINE by the loop. If the opt-in claim-check
 * (`defineConfig({ execution: { claimCheck: { toolIds } } })`) was pointed at the model or summarizer effect, its
 * result is a `{ __loomClaimCheck, ref }` envelope the loop cannot read: fail with the cause named, not a
 * confusing "no content" or an undefined `summary`.
 */
function assertNotClaimChecked(what: string, toolId: string | undefined, value: unknown): void {
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { __loomClaimCheck?: unknown }).__loomClaimCheck === true
  ) {
    throw new Error(
      `agentLoop$: the ${what} effect "${toolId ?? "(reasoning)"}" returned a claim-check envelope, so \`execution.claimCheck.toolIds\` lists it. The loop reads the ${what} result inline; list only your TOOLS' ids there (ADR 0140).`
    );
  }
}
