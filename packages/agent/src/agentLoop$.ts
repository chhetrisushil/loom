import type { AgentDefinition, ToolDefinition } from "@loom/core";
import type {
  LlmContent,
  LlmMessageInput,
  LlmResponse,
  LlmToolCall,
  LlmToolSpecInput,
} from "@loom/llm";
import type { ExecutionContext } from "@loom/workflow-runtime";
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
  modelToolId: string;
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
  const maxIterations = config.maxIterations ?? 10;
  const gate = config.approvalGate ?? DEFAULT_GATE;
  const idPrefix = config.definition.id;

  // Skills are deliberately not resolved here: `SkillRegistry` selection is a
  // per-turn CHOICE, and doing it right means `ctx.decide` so replay serves the
  // same set. That is a follow-up with its own shape, not a thing to half-wire.
  const system = config.systemPrompt;

  const tools = toolSpecsFor(config.definition.tools);
  const messages: LlmMessageInput[] = [
    {
      role: "user",
      content:
        input.context != null
          ? `Context: ${JSON.stringify(input.context)}\n\n${input.prompt}`
          : input.prompt,
    },
  ];

  const toolCallLog: AgentStep[] = [];
  let iterations = 0;
  let lastContent = "";

  while (iterations < maxIterations) {
    const turn = iterations;
    iterations++;

    // One durable frame per turn. On recovery this is served from the log for
    // every turn that completed — the crash at turn 39 costs turn 39, not 1..39.
    const response = (await ctx.execute(
      {
        _tag: "TaskDefinition",
        kind: "llm",
        id: `${idPrefix}#turn:${turn}`,
        toolId: config.modelToolId,
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

    for (const [j, toolCall] of response.toolCalls.entries()) {
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
  }

  return { content: lastContent, toolCallLog, iterations };
}
