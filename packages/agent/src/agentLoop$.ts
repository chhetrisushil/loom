import type { AgentDefinition, ToolDefinition } from "@loom/core";
import { loadInstructions } from "@loom/core";
import type {
  LlmContent,
  LlmMessageInput,
  LlmResponse,
  LlmToolCall,
  LlmToolSpecInput,
} from "@loom/llm";
import type { TieredMemory } from "@loom/memory";
import type { ReasoningRuntime } from "@loom/reasoning";
import type { ExecutionContext } from "@loom/workflow-runtime";
import type { SkillRegistry } from "./SkillRegistry";
import { type SkillSelector, deterministicSkillSelector } from "./SkillSelector";
import { toolResultContent } from "./toolResultContent";
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
}

/** What a tool call must clear before it runs. Returning `false` parks the loop on a gate. */
export type ApprovalPolicy = (toolCall: LlmToolCall, turn: number) => boolean;

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
   * **The trade-off, stated rather than hidden.** On this path the model call is
   * made by the Reasoning Runtime's own routes, so it does NOT pass through the
   * `EffectRuntime`: `guardRequest` still runs (R2 guards `ReasoningRuntime.call`),
   * but K2 authorization, metering and K9 in-doubt do not apply to it. The
   * `modelToolId` path gets the full ring and no routing. Pick per agent; they
   * are alternatives, and one of the two is required.
   */
  reasoning?: ReasoningRuntime;
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
   * `afterMessages`, keeping the newest `keepRecent` intact.
   *
   * This is the second half of the log-growth answer (ADR 0087 D5): claim-check
   * bounds the BYTES per turn, this bounds the TURNS per conversation. It was
   * deferred from R1 for a specific reason, and that reason shapes the design —
   * a summary is lossy and nondeterministic, so it cannot simply be computed in
   * the loop body. It runs through `ctx.execute` against `toolId`, which makes it
   * a recorded task: journaled once, served from the log on replay, so a
   * re-run reconstructs the SAME compacted transcript rather than re-summarizing
   * into a different one.
   *
   * The effect receives `{ messages }` and returns `{ summary: string }`.
   */
  compaction?: {
    toolId: string;
    /** Compact once the transcript exceeds this many messages. */
    afterMessages: number;
    /** How many of the newest messages to leave untouched. Default 4. */
    keepRecent?: number;
  };
}

const DEFAULT_GATE = "AgentToolApproval";

/** Build the model's tool menu, carrying `LlmContent` so a tainted description is REFUSED (R2). */
function toolSpecsFor(tools: readonly ToolDefinition[]): LlmToolSpecInput[] {
  return tools.map((t) => ({
    name: t.id,
    description: t.description as LlmContent,
    inputSchema: {},
  }));
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
    const selected = await ctx.decide<string[]>(`${idPrefix}#skills`, () =>
      selector.select(input, registry)
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

  const messages: LlmMessageInput[] = [];
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
      messages.push({
        role: entry.role === "assistant" ? "assistant" : "user",
        content: String(entry.content),
      });
    }
  }
  messages.push({
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
      if (config.requireApproval?.(toolCall, turn) === false) {
        const verdict = await ctx.suspend<{ approved?: boolean; reason?: string }>({
          on: gate,
          correlationKey: `${ctx.executionId}#turn:${turn}:tool:${j}`,
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
      messages.push({ role: "user", content: toolResultContent(toolCall.name, output) });
    }
  };

  while (iterations < maxIterations) {
    const turn = iterations;
    iterations++;

    // Compact BEFORE the turn's model call, so the summary is what gets asked
    // — compacting after would journal a transcript the model never saw.
    const compaction = config.compaction;
    if (compaction !== undefined && messages.length > compaction.afterMessages) {
      const keep = compaction.keepRecent ?? 4;
      const fold = messages.slice(0, messages.length - keep);
      const recent = messages.slice(messages.length - keep);
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
      messages.push({ role: "user", content: `Summary of earlier turns: ${summary}` }, ...recent);
    }

    const turnRequest = {
      messages,
      ...(tools.length > 0 && { tools }),
      ...(system !== undefined && { system }),
    } satisfies AgentModelCall;

    // Routed turn: the route and each elevation are recorded through the REAL
    // decision seam, so a replay takes the route that ran.
    if (config.reasoning !== undefined) {
      const routed = await config.reasoning.reason(
        { ...turnRequest, strategy: "agent" },
        {
          decide: ctx.decide,
          decisionKey: `${idPrefix}#turn:${turn}`,
        }
      );
      lastContent = routed.content;
      if (routed.stopReason === "end_turn" || !routed.toolCalls?.length) break;
      messages.push({ role: "assistant", content: routed.content || "(tool calls)" });
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

    messages.push({ role: "assistant", content: response.content || "(tool calls)" });

    await runToolCalls(response.toolCalls, turn);
  }

  return { content: lastContent, toolCallLog, iterations };
}
