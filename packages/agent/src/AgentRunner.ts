import { isTainted, taintOf, tainted, unwrapTainted } from "@loom/classify";
import type { AgentDefinition, ToolDefinition } from "@loom/core";
import { loadInstructions } from "@loom/core";
import type { EffectContext, EffectRuntime } from "@loom/effect-runtime";
import { CapabilityDeniedError, EffectModeViolationError, LlmEffect } from "@loom/effect-runtime";
import type {
  LlmContent,
  LlmMessageInput,
  LlmProvider,
  LlmResponse,
  LlmToolCall,
  LlmToolSpecInput,
} from "@loom/llm";
import { guardRequest } from "@loom/llm";
import type { MemoryRuntime } from "@loom/memory";
import type { ReasoningRuntime } from "@loom/reasoning";
import { parallelLimit, throwIfAborted } from "@loom/scheduler";
import type { SkillRegistry } from "./SkillRegistry";
import { type SkillSelector, deterministicSkillSelector } from "./SkillSelector";
import type { AgentInput, AgentOutput, AgentStep } from "./types";

export interface AgentConfig {
  definition: AgentDefinition;
  // The model access. Provide a bare `provider` OR a `reasoning` runtime (preferred):
  // when `reasoning` is set the agent's model calls are routed/elevated by the
  // Reasoning Runtime and the chosen route is logged as a durable decision (P9) — the
  // agent stays thin while the runtime does the model heavy-lifting (M8). At least
  // one must be supplied.
  provider?: LlmProvider;
  reasoning?: ReasoningRuntime;
  effectRuntime: EffectRuntime;
  maxIterations?: number;
  systemPrompt?: string;
  // Optional Agent Runtime memory. When the agent's definition has a memoryId
  // and a MemoryRuntime is provided, prior turns are recalled into the prompt
  // and this turn's answer is remembered — scoped by input.memoryScope.
  memory?: MemoryRuntime;
  // Opt-in parallel tool execution within a single model turn. `false` (default)
  // keeps the safe sequential behaviour; `true` runs all tool calls at once;
  // a number caps concurrency. Results, event emission, and message order are
  // ALWAYS in the model's tool-call order regardless of completion order, so
  // event-sourced replay stays deterministic.
  parallelTools?: boolean | number;
  // Optional Skills. When a registry is supplied, the runner selects the
  // relevant skills for this turn (deterministic by default — replay-safe),
  // emits SKILLS_SELECTED, lazy-loads only their instruction bodies, appends
  // them to the system prompt, and adds their tools to the model's tool menu.
  skills?: SkillRegistry;
  skillSelector?: SkillSelector;
}

/**
 * Render one tool result as the message content fed back to the model, KEEPING the
 * taint on the outside of the serialization.
 *
 * A plain `JSON.stringify` of a tainted result is worse than an unenforced marker —
 * it is an erased one. `{__loomTainted, value}` flattens into ordinary text, so
 * `isTainted` is false afterwards and no guard added later, including one at the
 * provider, can recover the provenance. Stringifying the UNWRAPPED value and
 * re-tainting the string keeps the fact alive to the prompt boundary, where
 * `guardRequest` fences it.
 */
function toolResultContent(toolName: string, toolOutput: unknown): LlmContent {
  if (!isTainted(toolOutput)) {
    return JSON.stringify({ tool: toolName, result: toolOutput });
  }
  const origin = taintOf(toolOutput)?.origin ?? "unknown";
  const body = JSON.stringify({ tool: toolName, result: unwrapTainted(toolOutput) });
  return tainted(body, origin);
}

export class AgentRunner {
  private readonly maxIterations: number;
  private readonly parallelTools: boolean | number;

  constructor(private readonly config: AgentConfig) {
    if (config.provider === undefined && config.reasoning === undefined) {
      throw new Error("AgentRunner requires a `provider` or a `reasoning` runtime");
    }
    this.maxIterations = config.maxIterations ?? 10;
    this.parallelTools = config.parallelTools ?? false;
  }

  async run(input: AgentInput, ctx: EffectContext): Promise<AgentOutput> {
    const { definition, effectRuntime, systemPrompt, memory, skills } = this.config;

    // Resolve skills first: choose the relevant ones, record the choice for
    // replay, then lazy-load only those instruction bodies and their tools.
    const skillTools: ToolDefinition[] = [];
    const skillInstructions: string[] = [];
    if (skills !== undefined && skills.all().length > 0) {
      const selector = this.config.skillSelector ?? deterministicSkillSelector();
      const selectedIds = await selector.select(input, skills);
      ctx.emit("SKILLS_SELECTED", { skillIds: selectedIds });
      for (const id of selectedIds) {
        const skill = skills.get(id);
        if (skill === undefined) continue;
        skillInstructions.push(await loadInstructions(skill.instructions));
        if (skill.tools !== undefined) skillTools.push(...skill.tools);
      }
    }

    const effectiveSystem =
      skillInstructions.length > 0
        ? [systemPrompt, ...skillInstructions].filter((s) => s != null && s !== "").join("\n\n")
        : systemPrompt;

    // Model tool menu = the agent's tools plus any tools the selected skills
    // bring, de-duplicated by id (the agent's own tools win).
    const toolDefs: ToolDefinition[] = [...definition.tools];
    const seenToolIds = new Set(toolDefs.map((t) => t.id));
    for (const t of skillTools) {
      if (!seenToolIds.has(t.id)) {
        seenToolIds.add(t.id);
        toolDefs.push(t);
      }
    }
    // Tool names and descriptions are read as instructions by every provider, and
    // with MCP dynamic dispatch (ADR 0063) a description is third-party bytes. Carry
    // them as `LlmContent` so `guardRequest` sees any taint and REFUSES it, instead
    // of a `string` annotation asserting a cleanliness nothing checked.
    const toolSpecs: LlmToolSpecInput[] = toolDefs.map((t) => ({
      name: t.id,
      description: t.description as LlmContent,
      inputSchema: {},
    }));

    const memoryId = definition.memoryId;
    const memoryScope = input.memoryScope ?? ctx.executionId;

    const messages: LlmMessageInput[] = [];

    // Recall prior memory for this agent+scope, if configured.
    if (memory !== undefined && memoryId !== undefined) {
      for (const entry of await memory.read(memoryId, memoryScope)) {
        const role = entry.role === "assistant" ? "assistant" : "user";
        messages.push({ role, content: String(entry.content) });
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

    while (iterations < this.maxIterations) {
      // Interruption checkpoint: bail before spending another (expensive) LLM
      // round-trip if the execution was cancelled.
      throwIfAborted(ctx.signal);
      iterations++;

      const response = await this.complete(
        {
          messages,
          toolSpecs,
          ...(effectiveSystem !== undefined && { system: effectiveSystem }),
          ...(ctx.signal !== undefined && { signal: ctx.signal }),
        },
        ctx,
        iterations
      );

      lastContent = response.content;

      if (response.stopReason === "end_turn" || !response.toolCalls?.length) {
        break;
      }

      messages.push({ role: "assistant", content: response.content || "(tool calls)" });

      const toolCalls = response.toolCalls;

      // Execute a single tool call, swallowing errors into a result object so a
      // failing tool never rejects the batch (keeps behaviour identical between
      // sequential and parallel modes).
      const runToolCall = async (toolCall: (typeof toolCalls)[number]): Promise<unknown> => {
        try {
          return await effectRuntime.execute(toolCall.name, toolCall.input, ctx);
        } catch (err) {
          // R4 — an AUTHORITY error is not a tool error. Swallowing it into a
          // result hands the model "not authorized", which it reads as feedback:
          // it reformulates and probes a neighbouring tool, turning one denial
          // into a search over the grant table. `EFFECT_DENIED` is durably logged
          // either way, but auditable is not the same as stopped, so a denial is
          // terminal for the turn.
          //
          // The blanket catch below stays, because it is right for everything
          // else: a timing-out API or a malformed argument IS feedback the model
          // can act on. The fix is telling the two apart.
          if (err instanceof CapabilityDeniedError || err instanceof EffectModeViolationError) {
            throw err;
          }
          return { error: String(err) };
        }
      };

      let toolOutputs: unknown[];
      if (this.parallelTools !== false) {
        throwIfAborted(ctx.signal);
        const limit =
          typeof this.parallelTools === "number" ? this.parallelTools : toolCalls.length;
        // parallelLimit preserves input order in the result array.
        toolOutputs = await parallelLimit(
          toolCalls.map((tc) => () => runToolCall(tc)),
          { limit, ...(ctx.signal !== undefined && { signal: ctx.signal }) }
        );
      } else {
        toolOutputs = [];
        for (const toolCall of toolCalls) {
          throwIfAborted(ctx.signal);
          toolOutputs.push(await runToolCall(toolCall));
        }
      }

      // Record, emit, and feed results back in the model's tool-call order —
      // deterministic regardless of which tool finished first.
      for (let i = 0; i < toolCalls.length; i++) {
        const toolCall = toolCalls[i]!;
        const toolOutput = toolOutputs[i];

        toolCallLog.push({
          iteration: iterations,
          toolName: toolCall.name,
          toolInput: toolCall.input,
          toolOutput,
        });

        ctx.emit("AGENT_TOOL_CALL", {
          iteration: iterations,
          toolName: toolCall.name,
          toolInput: toolCall.input,
          toolOutput,
        });

        messages.push({ role: "user", content: toolResultContent(toolCall.name, toolOutput) });
      }
    }

    // Remember this turn (the user's prompt and the agent's answer).
    if (memory !== undefined && memoryId !== undefined) {
      await memory.append(memoryId, memoryScope, { role: "user", content: input.prompt });
      await memory.append(memoryId, memoryScope, { role: "assistant", content: lastContent });
    }

    ctx.emit("AGENT_COMPLETED", {
      content: lastContent,
      iterations,
      toolCallCount: toolCallLog.length,
    });

    return { content: lastContent, toolCallLog, iterations };
  }

  // The model call, re-based onto the Reasoning Runtime when configured (M8). With
  // `reasoning`, route/elevation is decided by the runtime and the chosen model is
  // recorded as a durable DECISION_RECORDED fact (P9) via the effect's emit — no
  // short-circuit needed, since the whole agent step is served from the log on replay.
  // With only a `provider`, the original bare-provider path is preserved exactly.
  private async complete(
    args: {
      messages: LlmMessageInput[];
      toolSpecs: LlmToolSpecInput[];
      system?: LlmContent;
      signal?: AbortSignal;
    },
    ctx: EffectContext,
    iteration: number
  ): Promise<Pick<LlmResponse, "content" | "stopReason"> & { toolCalls?: LlmToolCall[] }> {
    // R2 — the prompt boundary. `guardRequest` refuses tainted content in every
    // instruction position (system, assistant, tool name/description) and fences it
    // in `user` messages, handing providers plain strings. It runs unconditionally:
    // a check that defaults to off protects exactly the applications that never
    // think about it, and an untainted request comes back structurally unchanged.
    //
    // This is the site ADR 0085 always described and never reached — `guardRequest`
    // lived only inside `createLlmEffect`, which had no production consumer, while
    // the agent assembled prompts from third-party bytes on a path of its own.
    const request = guardRequest({
      messages: args.messages,
      ...(args.toolSpecs.length > 0 && { tools: args.toolSpecs }),
      ...(args.system !== undefined && { system: args.system }),
      ...(args.signal !== undefined && { signal: args.signal }),
    });

    if (this.config.reasoning !== undefined) {
      const decide = async <T>(id: string, decider: () => T | Promise<T>): Promise<T> => {
        const choice = await decider();
        ctx.emit("DECISION_RECORDED", { decisionId: id, choice, source: "agent" });
        return choice;
      };
      const res = await this.config.reasoning.reason(
        { ...request, strategy: "agent" },
        { decide, decisionKey: `agent:turn:${iteration}` }
      );
      return {
        content: res.content,
        stopReason: res.stopReason,
        ...(res.toolCalls !== undefined && { toolCalls: res.toolCalls }),
      };
    }

    // Guarded by the constructor: provider is defined when reasoning is not.
    const res = await (this.config.provider as LlmProvider).complete(request);
    return {
      content: res.content,
      stopReason: res.stopReason,
      ...(res.toolCalls !== undefined && { toolCalls: res.toolCalls }),
    };
  }

  asEffect(): LlmEffect<AgentInput, AgentOutput> {
    return new LlmEffect<AgentInput, AgentOutput>((input: AgentInput, ctx: EffectContext) =>
      this.run(input, ctx)
    );
  }
}
