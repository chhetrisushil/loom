import type { AgentDefinition, ToolDefinition } from "@loom/core";
import { loadInstructions } from "@loom/core";
import type { Effect } from "@loom/effect-runtime";
import type {
  LlmContent,
  LlmMessageInput,
  LlmResponse,
  LlmToolCall,
  LlmToolSpecInput,
} from "@loom/llm";
import type { TieredMemory } from "@loom/memory";
import type { ModelInvoker, ReasoningRuntime } from "@loom/reasoning";
import { approvalViewDigest } from "@loom/workflow-runtime";
import type { ExecutionContext } from "@loom/workflow-runtime";
import type { SkillRegistry } from "./SkillRegistry";
import { type SkillSelector, deterministicSkillSelector } from "./SkillSelector";
import { createAgentModelEffect } from "./createAgentModelEffect";
import { toolResultContent } from "./toolResultContent";
import { buildToolMenu, toolInputJsonSchema } from "./toolSchema";
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
// `agentStep$` stays. It is the cheap opaque form for an agent that wants none of
// the above, and it costs one frame instead of 2N.

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
   * authorization, metering and quotas, the kill switch and K9 in-doubt do not apply, and the
   * model call is not journaled (a resumed run re-calls the model). Set
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
    "agentLoop$: `reasoning` is used without `reasoningToolId`, so its routed model calls bypass authorization, metering, the kill switch and the journal. Set `reasoningToolId` (see registerReasoningRoutes) or `requireEffectRing: true`.",
    { code: "LOOM_AGENT_RING" }
  );
}

/** Test seam: re-arm the one-time advisory. */
export function resetReasoningRingWarning(): void {
  warnedReasoningOutsideRing = false;
}

/** Build the model's tool menu, carrying `LlmContent` so a tainted description is REFUSED (R2). */
function toolSpecsFor(tools: readonly ToolDefinition[]): LlmToolSpecInput[] {
  return tools.map((t) => ({
    name: t.id,
    description: t.description as LlmContent,
    inputSchema: toolInputJsonSchema(t.inputSchema),
  }));
}

// ── The byte counter (compaction's `afterBytes` trigger) ─────────────────────
//
// A pure function of a message's own content — never wall-clock, never a
// re-serialization of the whole transcript — so it is a deterministic function
// of already-journaled values: replaying the turns that produced `messages` up
// to any point recomputes the identical running total, and therefore the
// identical compaction decision, every time.

const UTF8 = new TextEncoder();

/** UTF-8 byte length of a message's content, unwrapping taint (ADR 0085) without stripping it. */
function messageBytes(msg: LlmMessageInput): number {
  const raw = typeof msg.content === "string" ? msg.content : msg.content.value;
  return UTF8.encode(raw).length;
}

/**
 * How many of the newest messages the byte-trigger fold keeps: the longest
 * suffix whose bytes total at most `afterBytes / 2`, floored at 1 (the newest
 * message always reaches the model) and capped at `keepRecent`.
 */
function keptSuffixByBytes(
  messages: readonly LlmMessageInput[],
  afterBytes: number,
  keepRecent: number
): number {
  const halfBudget = afterBytes / 2;
  let count = 1;
  let bytes = messageBytes(messages[messages.length - 1] as LlmMessageInput);
  for (let i = messages.length - 2; i >= 0 && count < keepRecent; i--) {
    const b = messageBytes(messages[i] as LlmMessageInput);
    if (bytes + b > halfBudget) break;
    bytes += b;
    count++;
  }
  return count;
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
  // The running byte counter behind `compaction.afterBytes`: updated at every
  // push, O(1) amortized per message, never a re-serialization of the array —
  // see `messageBytes` above for why that keeps it replay-deterministic.
  let transcriptBytes = 0;
  const pushMessage = (msg: LlmMessageInput): void => {
    messages.push(msg);
    transcriptBytes += messageBytes(msg);
  };
  const pushMessages = (...msgs: LlmMessageInput[]): void => {
    for (const msg of msgs) pushMessage(msg);
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
      pushMessage({
        role: entry.role === "assistant" ? "assistant" : "user",
        content: String(entry.content),
      });
    }
  }
  pushMessage({
    role: "user",
    content:
      input.context != null
        ? `Context: ${JSON.stringify(input.context)}\n\n${input.prompt}`
        : input.prompt,
  });

  const toolCallLog: AgentStep[] = [];
  let iterations = 0;
  let lastContent = "";

  /** Execute one turn's tool calls: gate, run, record, feed back. Shared by both paths. */
  const runToolCalls = async (calls: readonly LlmToolCall[], turn: number): Promise<void> => {
    for (const [j, toolCall] of calls.entries()) {
      let output: unknown;

      // Mid-loop HITL. The gate is BEFORE the effect, so a declined call never
      // runs — the point of asking.
      if (config.requireApproval?.(toolCall, turn, menu.has(toolCall.name)) === false) {
        const gateKey = `${ctx.executionId}#turn:${turn}:tool:${j}`;
        const verdict = await ctx.suspend<{ approved?: boolean; reason?: string }>({
          on: gate,
          correlationKey: gateKey,
          // R13 — bind the approval to the exact call parked here (tool + args + position).
          ...(config.bindApproval !== false && {
            viewDigest: approvalViewDigest(gateKey, toolCall.name, toolCall.input),
          }),
        });
        if (verdict?.approved !== true) {
          // A refusal is a fact the model should see and settle on, not an error:
          // it asked to do something a human declined, which is information.
          output = {
            refused: true,
            ...(verdict?.reason !== undefined && { reason: verdict.reason }),
          };
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
        if (refusal !== undefined) output = refusal;
      }

      if (output === undefined) {
        output = await ctx.execute(
          {
            _tag: "TaskDefinition",
            kind: "tool",
            id: `${idPrefix}#turn:${turn}:tool:${j}`,
            toolId: toolCall.name,
          },
          toolCall.input
        );
      }

      toolCallLog.push({
        iteration: iterations,
        toolName: toolCall.name,
        toolInput: toolCall.input,
        toolOutput: output,
      });
      pushMessage({ role: "user", content: toolResultContent(toolCall.name, output) });
    }
  };

  while (iterations < maxIterations) {
    const turn = iterations;
    iterations++;

    // Compact BEFORE the turn's model call, so the summary is what gets asked
    // — compacting after would journal a transcript the model never saw.
    const compaction = config.compaction;
    if (compaction !== undefined) {
      const overMessages =
        compaction.afterMessages !== undefined && messages.length > compaction.afterMessages;
      const overBytes =
        compaction.afterBytes !== undefined && transcriptBytes > compaction.afterBytes;

      if (overMessages || overBytes) {
        const keepRecent = compaction.keepRecent ?? 4;
        // The byte trigger sizes its own kept suffix (longest run ≤ half the
        // budget); the message trigger keeps the original fixed count — G2.
        const keep = overBytes
          ? keptSuffixByBytes(messages, compaction.afterBytes as number, keepRecent)
          : keepRecent;
        const foldLength = messages.length - keep;

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
          messages.length = 0;
          transcriptBytes = 0;
          pushMessages(
            { role: "user", content: `Summary of earlier turns: ${summary}` },
            ...recent
          );
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
      // R9 — each model call as a journaled effect frame, when a tool id is configured.
      // `callSeq` is per turn; the route + elevation decisions are recorded, so a replay makes
      // the same sequence of calls and finds each frame under the same id.
      let callSeq = 0;
      const reasoningToolId = config.reasoningToolId;
      const invoke: ModelInvoker | undefined =
        reasoningToolId === undefined
          ? undefined
          : (route, request) =>
              ctx.execute(
                {
                  _tag: "TaskDefinition",
                  kind: "llm",
                  id: `${idPrefix}#turn:${turn}:call:${callSeq++}`,
                  toolId:
                    typeof reasoningToolId === "string"
                      ? reasoningToolId
                      : reasoningToolId(route.id),
                },
                request satisfies AgentModelCall
              ) as Promise<LlmResponse>;
      const routed = await config.reasoning.reason(
        { ...turnRequest, strategy: "agent" },
        {
          decide: ctx.decide,
          decisionKey: `${idPrefix}#turn:${turn}`,
          ...(invoke !== undefined && { invoke }),
        }
      );
      lastContent = routed.content;
      if (routed.stopReason === "end_turn" || !routed.toolCalls?.length) break;
      pushMessage({ role: "assistant", content: routed.content || "(tool calls)" });
      await runToolCalls(routed.toolCalls, turn);
      continue;
    }

    // One durable frame per turn. On recovery this is served from the log for
    // every turn that completed — the crash at turn 39 costs turn 39, not 1..39.
    const response = (await ctx.execute(
      {
        _tag: "TaskDefinition",
        kind: "llm",
        id: `${idPrefix}#turn:${turn}`,
        // Non-null by the constructor guard: one of `modelToolId` / `reasoning`
        // is required, and the reasoning path returned above.
        toolId: config.modelToolId as string,
      },
      {
        messages,
        ...(tools.length > 0 && { tools }),
        ...(system !== undefined && { system }),
      } satisfies AgentModelCall
    )) as LlmResponse;

    lastContent = response.content;
    if (response.stopReason === "end_turn" || !response.toolCalls?.length) break;

    pushMessage({ role: "assistant", content: response.content || "(tool calls)" });

    await runToolCalls(response.toolCalls, turn);
  }

  return { content: lastContent, toolCallLog, iterations };
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
