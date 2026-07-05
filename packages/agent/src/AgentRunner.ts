import type { AgentDefinition, ToolDefinition } from "@loom/core";
import { loadInstructions } from "@loom/core";
import type { EffectContext, EffectRuntime } from "@loom/effect-runtime";
import { LlmEffect } from "@loom/effect-runtime";
import type { LlmMessage, LlmProvider, LlmToolSpec } from "@loom/llm";
import type { MemoryRuntime } from "@loom/memory";
import { parallelLimit, throwIfAborted } from "@loom/scheduler";
import type { SkillRegistry } from "./SkillRegistry";
import { type SkillSelector, deterministicSkillSelector } from "./SkillSelector";
import type { AgentInput, AgentOutput, AgentStep } from "./types";

export interface AgentConfig {
  definition: AgentDefinition;
  provider: LlmProvider;
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

export class AgentRunner {
  private readonly maxIterations: number;
  private readonly parallelTools: boolean | number;

  constructor(private readonly config: AgentConfig) {
    this.maxIterations = config.maxIterations ?? 10;
    this.parallelTools = config.parallelTools ?? false;
  }

  async run(input: AgentInput, ctx: EffectContext): Promise<AgentOutput> {
    const { definition, provider, effectRuntime, systemPrompt, memory, skills } = this.config;

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
    const toolSpecs: LlmToolSpec[] = toolDefs.map((t) => ({
      name: t.id,
      description: t.description,
      inputSchema: {},
    }));

    const memoryId = definition.memoryId;
    const memoryScope = input.memoryScope ?? ctx.executionId;

    const messages: LlmMessage[] = [];

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

      const response = await provider.complete({
        messages,
        ...(toolSpecs.length > 0 && { tools: toolSpecs }),
        ...(effectiveSystem !== undefined && { system: effectiveSystem }),
        ...(ctx.signal !== undefined && { signal: ctx.signal }),
      });

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

        messages.push({
          role: "user",
          content: JSON.stringify({ tool: toolCall.name, result: toolOutput }),
        });
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

  asEffect(): LlmEffect<AgentInput, AgentOutput> {
    return new LlmEffect<AgentInput, AgentOutput>((input: AgentInput, ctx: EffectContext) =>
      this.run(input, ctx)
    );
  }
}
