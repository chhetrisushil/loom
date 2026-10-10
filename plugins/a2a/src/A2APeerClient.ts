import type { TaintedValue } from "@loom/classify";
import { tainted } from "@loom/classify";
import { tool$ } from "@loom/core";
import type { AgentDefinition, ToolDefinition } from "@loom/core";
import { agent$ } from "@loom/core";
import type { Effect, EffectContext, EffectRuntime } from "@loom/effect-runtime";
import { z } from "zod";
import { createA2AClientEffect } from "./A2AClientEffect";
import type { A2AClientOptions } from "./A2AClientEffect";
import { A2AEffect } from "./A2AEffect";
import type { A2ATask, A2ATaskResult, AgentCard } from "./types";

/**
 * Turns a remote A2A agent (Google ADK, a LangGraph/CrewAI A2A shim, or another
 * Loom `createA2AServer`) into a callable Loom tool. This is the outbound half
 * of the bidirectional mesh — the A2A analogue of `McpClient.registerInto`.
 *
 * The remote agent is discovered via its AgentCard (`/.well-known/agent.json`)
 * and registered into an `EffectRuntime` so Loom agents, steps and the planner
 * can invoke it like any other tool.
 */
export interface A2APeerConfig<TTaint extends boolean = false> {
  /** Base URL of the remote A2A agent (no trailing path). */
  url: string;
  /** Extra headers (auth etc.) sent on discovery and every task call. */
  headers?: Record<string, string>;
  /** Overall per-call timeout, forwarded to the underlying client effect. */
  timeoutMs?: number;
  /** Poll interval while waiting for the remote task to reach a terminal state. */
  pollIntervalMs?: number;
  /** Override the registered tool id. Defaults to a slug of the card name. */
  toolId?: string;
  /**
   * Mark the peer's `content` as untrusted (ADR 0085), stamped `a2a:<toolId>`.
   * The prompt boundary in `@loom/llm` then REFUSES it in any instruction
   * position — system prompt, assistant turn, tool description — and fences it
   * in a `user` message.
   *
   * A peer agent writes its own artifact text, and a peer is exactly as
   * trustworthy as whoever operates it. This is the switch that makes that fact
   * travel with the value.
   *
   * Only `content` is tainted, not the whole output — unlike `mcpInvoke$`,
   * whose result is opaque. `raw` carries task state and artifact metadata that
   * feeds control flow, and forcing an `unwrapTainted()` on code that never
   * touches a prompt would be friction in the wrong place. `content` is the
   * flattened text, so `peer.content` drops straight into an `LlmMessage` slot
   * where the guard sees it.
   *
   * Typed, not just documented: the flag's literal type selects the output
   * type, so a caller that does not opt in sees `A2APeerOutput` exactly as
   * before and compiles unchanged.
   */
  taintResults?: TTaint;
  /**
   * Vouch for the peer's AgentCard text (ADR 0125 D14; the equivalent of MCP's `trustDescriptions`).
   * Default false: an agent loop shows the model only a neutral placeholder for this peer's
   * description, because the card is written by whoever operates the peer. Set it only for a peer you
   * operate or trust; its card text then reaches the model as instructions, unguarded (a one-time
   * `LOOM_AGENT_TRUSTED_TOOL_TEXT` warning says so).
   */
  trustDescriptions?: boolean;
}

/** Friendly input accepted by a peer tool — a plain prompt plus optional context. */
export interface A2APeerInput {
  prompt: string;
  context?: unknown;
}

/** Peer tool output — flattened artifact text plus the raw A2A result. */
export interface A2APeerOutput {
  content: string;
  raw: A2ATaskResult;
}

/** {@link A2APeerOutput} under `taintResults` — the text carries its provenance. */
export interface TaintedA2APeerOutput {
  content: TaintedValue<string>;
  raw: A2ATaskResult;
}

/**
 * The output shape implied by the `taintResults` flag. A `boolean` (rather than
 * a literal) distributes to the union, which is the honest answer when the flag
 * is only known at runtime.
 */
export type A2APeerOutputFor<TTaint extends boolean> = TTaint extends true
  ? TaintedA2APeerOutput
  : A2APeerOutput;

/** The trio produced when mapping a remote agent: card, tool definition, effect. */
export interface MappedA2APeer<TTaint extends boolean = false> {
  card: AgentCard;
  definition: ToolDefinition<A2APeerInput, A2APeerOutputFor<TTaint>>;
  effect: Effect<A2APeerInput, A2APeerOutputFor<TTaint>>;
}

/**
 * Structural view of `@loom/registry`'s `AgentRegistry.register`. Declared here
 * so `@loom/plugin-a2a` stays dependency-light and does not import the registry package
 * (which itself avoids depending on a2a for the same reason).
 */
export interface PeerAgentRegistrar {
  register(definition: AgentDefinition, card?: RegisteredPeerCard): unknown;
}

interface RegisteredPeerCard {
  name: string;
  description?: string;
  url?: string;
  version: string;
  capabilities?: { streaming?: boolean };
  skills?: Array<{ id: string; name: string; description?: string }>;
}

const peerInputSchema = z.object({
  prompt: z.string(),
  context: z.unknown().optional(),
}) as z.ZodType<A2APeerInput>;

// `content` validates BOTH shapes because one schema backs both flag settings.
// It is the runtime contract; the conditional type is what narrows it per caller.
const peerOutputSchema = z.object({
  content: z.union([
    z.string(),
    z.object({ __loomTainted: z.object({ origin: z.string() }), value: z.string() }),
  ]),
  raw: z.unknown(),
});

/** Fetch a remote agent's AgentCard from its well-known discovery endpoint. */
export async function fetchAgentCard(
  url: string,
  headers: Record<string, string> = {}
): Promise<AgentCard> {
  const resp = await fetch(`${url}/.well-known/agent.json`, {
    headers: { accept: "application/json", ...headers },
  });
  if (!resp.ok) {
    throw new Error(`A2A discovery failed ${resp.status}: ${await resp.text()}`);
  }
  return (await resp.json()) as AgentCard;
}

export class A2APeerClient<TTaint extends boolean = false> {
  private card: AgentCard | undefined;

  constructor(private readonly config: A2APeerConfig<TTaint>) {}

  /** Fetch and cache the remote AgentCard. */
  async discover(): Promise<AgentCard> {
    if (this.card === undefined) {
      this.card = await fetchAgentCard(this.config.url, this.config.headers);
    }
    return this.card;
  }

  /** Discover the peer and build its Loom tool definition + effect (no registration). */
  async map(): Promise<MappedA2APeer<TTaint>> {
    const card = await this.discover();
    const toolId = this.config.toolId ?? slug(card.name);
    const effect = this.buildEffect(toolId);

    const definition = tool$<A2APeerInput, A2APeerOutputFor<TTaint>>({
      id: toolId,
      name: card.name,
      description: describe(card),
      kind: "a2a",
      // R22 (ADR 0125 D7) — built from a REMOTE agent card: tool search must not rank or show its text.
      origin: "remote",
      ...(this.config.trustDescriptions === true && { trustJsonSchemaText: true }),
      inputSchema: peerInputSchema,
      outputSchema: peerOutputSchema as unknown as z.ZodType<A2APeerOutputFor<TTaint>>,
    });

    return { card, definition, effect };
  }

  /**
   * Discover the peer, register it as an effect, and return the tool definition.
   * Pass a registry to also expose the peer to the planner/intent layer.
   */
  async registerInto(
    effectRuntime: EffectRuntime,
    registry?: PeerAgentRegistrar
  ): Promise<ToolDefinition<A2APeerInput, A2APeerOutputFor<TTaint>>> {
    const { card, definition, effect } = await this.map();
    effectRuntime.register(definition.id, effect);

    if (registry !== undefined) {
      const remoteAgent = agent$({
        id: definition.id,
        name: card.name,
        ...(card.description !== undefined && { description: card.description }),
        tools: [definition],
        version: card.version,
        capabilities: card.capabilities,
        skills: card.skills,
      });
      registry.register(remoteAgent, toRegisteredCard(card));
    }

    return definition;
  }

  /** Adapter effect: friendly input -> A2ATask -> underlying client -> flattened output. */
  private buildEffect(toolId: string): Effect<A2APeerInput, A2APeerOutputFor<TTaint>> {
    const clientOptions: A2AClientOptions = {
      ...(this.config.headers !== undefined && { headers: this.config.headers }),
      ...(this.config.timeoutMs !== undefined && { timeoutMs: this.config.timeoutMs }),
      ...(this.config.pollIntervalMs !== undefined && {
        pollIntervalMs: this.config.pollIntervalMs,
      }),
    };
    const client = createA2AClientEffect(this.config.url, clientOptions);

    return new A2AEffect<A2APeerInput, A2APeerOutputFor<TTaint>>(
      async (input: A2APeerInput, ctx: EffectContext): Promise<A2APeerOutputFor<TTaint>> => {
        const task: A2ATask = {
          // Deterministic id derived from the execution so replays stay stable.
          // A transient call stamped as an execution (ctx.decide's scope) shares
          // (executionId, stepId) with its siblings; callKey keeps their ids distinct.
          id: `${ctx.executionId}:${ctx.stepId}${ctx.callKey !== undefined ? `:${ctx.callKey}` : ""}`,
          message: { role: "user", parts: [{ type: "text", text: input.prompt }] },
          ...(input.context !== undefined && { metadata: { context: input.context } }),
        };

        const result = await client.execute(task, ctx);
        const content = artifactText(result);
        // Taint at INGRESS — the wrapper IS the step output, so it is what
        // STEP_COMPLETED records and what a replay hands back. The cast is the
        // one place the conditional return type cannot be proved structurally.
        return {
          content: this.config.taintResults === true ? tainted(content, `a2a:${toolId}`) : content,
          raw: result,
        } as A2APeerOutputFor<TTaint>;
      }
    );
  }
}

/** Flatten all text parts across all artifacts of a completed/failed A2A result. */
function artifactText(result: A2ATaskResult): string {
  if (result.error !== undefined) {
    return result.error;
  }
  return (result.artifacts ?? [])
    .flatMap((artifact) => artifact.parts.map((part) => part.text))
    .join("\n");
}

/** Build an LLM-facing tool description from the card's summary and skills. */
function describe(card: AgentCard): string {
  const base = card.description ?? card.name;
  if (card.skills.length === 0) {
    return base;
  }
  const skills = card.skills.map((s) => s.name).join(", ");
  return `${base} (skills: ${skills})`;
}

function toRegisteredCard(card: AgentCard): RegisteredPeerCard {
  return {
    name: card.name,
    ...(card.description !== undefined && { description: card.description }),
    url: card.url,
    version: card.version,
    capabilities: card.capabilities,
    skills: card.skills.map((s) => ({
      id: s.id,
      name: s.name,
      ...(s.description !== undefined && { description: s.description }),
    })),
  };
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "a2a-peer"
  );
}
