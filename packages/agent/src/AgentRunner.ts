import { isTainted, taintOf, tainted, unwrapTainted } from "@loom/classify";
import type { AgentDefinition, ToolDefinition } from "@loom/core";
import { TypedFailure, fail, loadInstructions } from "@loom/core";
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
import { LLM_INTERRUPTED, collectStream, guardRequest } from "@loom/llm";
import type { MemoryRuntime } from "@loom/memory";
import type { ReasoningRuntime } from "@loom/reasoning";
import { parallelLimit, throwIfAborted } from "@loom/scheduler";
import type { SkillRegistry } from "./SkillRegistry";
import { type SkillSelector, deterministicSkillSelector } from "./SkillSelector";
import { toolResultContent } from "./toolResultContent";
import { buildToolMenu, toolInputJsonSchema } from "./toolSchema";
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
  /**
   * Consume the provider's `stream` for each turn instead of `complete` (R9).
   * Opt-in: the outcome is identical by the R8 parity contract, but the wire call
   * is not. Falls back to `complete` when the provider cannot stream.
   *
   * Beyond live output, this is what gives an INTERRUPTED turn a partial to keep
   * (R6): on the `complete` path an abort throws with the response body unread,
   * so there is nothing to hand back.
   */
  stream?: boolean;
  /**
   * Transient sink for deltas. Never journaled — routing a token stream through
   * `ctx.stream` is durable per delta, and is a granularity choice the author
   * makes deliberately (R7).
   */
  onDelta?: (delta: string) => void;
}

/** The channel an interrupted agent run fails on (ADR 0060). */
export const AGENT_INTERRUPTED = "agentInterrupted";

/**
 * What the turn had produced when the stop landed. The tool calls are the point:
 * they are the expensive, already-paid-for half of the work, and re-running the
 * agent from nothing repeats every one of them.
 */
export interface InterruptedAgentRun {
  /** Partial text from the interrupted generation. Empty unless `stream` is on. */
  content: string;
  /** Turns begun before the interruption. */
  iterations: number;
  /** Tool calls that completed, in the model's order. */
  toolCallLog: AgentStep[];
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
      inputSchema: toolInputJsonSchema(t.inputSchema),
    }));
    // R4 — only the menu the model was shown may run; see `buildToolMenu`.
    const menu = buildToolMenu(toolDefs);

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

    // R6 — everything the turn produced, carried out on an ADR 0060 channel if a
    // stop lands. The interruption can arrive from three places (the checkpoint
    // below, a tool that took too long, or mid-generation), and the work already
    // done is worth the same in all three, so the capture wraps the whole loop
    // rather than each site.
    const interrupted = (err: unknown): never => {
      const partial =
        err instanceof TypedFailure && err.channel === LLM_INTERRUPTED
          ? ((err.payload as { content?: string }).content ?? "")
          : "";
      fail(
        AGENT_INTERRUPTED,
        { content: partial, iterations, toolCallLog } satisfies InterruptedAgentRun,
        "agent run interrupted"
      );
    };

    try {
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
          // R4 — refusal is a result fed back to the model, never an execution.
          const refusal = menu.check(toolCall.name, toolCall.input);
          if (refusal !== undefined) return refusal;
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
    } catch (err) {
      // Only a STOP is an interruption. An authority denial (R4) and an ordinary
      // failure both propagate untouched: the first is terminal by design, the
      // second is not lost work but a broken run.
      if (ctx.signal?.aborted === true) interrupted(err);
      throw err;
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
      // A HAND-EMITTED decision, and knowingly so: a step handler has `emit` and
      // nothing else, so this records the route as a fact but cannot have it
      // SERVED on replay — a re-run re-routes, and if routing improves
      // run-to-run the replayed run can take a different route than the one
      // whose answer is recorded. `agentLoop$` passes the real `ctx.decide` and
      // does not have this limitation; it is the reason to prefer it for any
      // agent whose routing matters.
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
    const provider = this.config.provider as LlmProvider;
    // R9/R6 — the streamed turn. Same outcome by the R8 parity contract, so the
    // loop below branches on exactly what it always did; what changes is that
    // deltas reach the sink live, and an abort mid-generation surfaces the text
    // produced so far instead of discarding it. Falls back when the provider
    // cannot stream, so opting in is never a runtime failure.
    const res =
      this.config.stream === true && provider.stream !== undefined
        ? await collectStream(provider.stream(request), {
            ...(args.signal !== undefined && { signal: args.signal }),
            ...(this.config.onDelta !== undefined && { onDelta: this.config.onDelta }),
          })
        : await provider.complete(request);
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
