import { tool$ } from "@loom/core";
import type { AgentDefinition, ToolDefinition } from "@loom/core";
import { A2AEffect } from "@loom/effect-runtime";
import type { Effect, EffectContext, EffectRuntime } from "@loom/effect-runtime";
import { z } from "zod";
import { agent$ } from "@loom/core";
import { createA2AClientEffect } from "./A2AClientEffect";
import type { A2AClientOptions } from "./A2AClientEffect";
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
export interface A2APeerConfig {
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

/** The trio produced when mapping a remote agent: card, tool definition, effect. */
export interface MappedA2APeer {
  card: AgentCard;
  definition: ToolDefinition<A2APeerInput, A2APeerOutput>;
  effect: Effect<A2APeerInput, A2APeerOutput>;
}

/**
 * Structural view of `@loom/registry`'s `AgentRegistry.register`. Declared here
 * so `@loom/a2a` stays dependency-light and does not import the registry package
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

const peerOutputSchema = z.object({
  content: z.string(),
  raw: z.unknown(),
}) as z.ZodType<A2APeerOutput>;

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

export class A2APeerClient {
  private card: AgentCard | undefined;

  constructor(private readonly config: A2APeerConfig) {}

  /** Fetch and cache the remote AgentCard. */
  async discover(): Promise<AgentCard> {
    if (this.card === undefined) {
      this.card = await fetchAgentCard(this.config.url, this.config.headers);
    }
    return this.card;
  }

  /** Discover the peer and build its Loom tool definition + effect (no registration). */
  async map(): Promise<MappedA2APeer> {
    const card = await this.discover();
    const toolId = this.config.toolId ?? slug(card.name);
    const effect = this.buildEffect();

    const definition = tool$<A2APeerInput, A2APeerOutput>({
      id: toolId,
      name: card.name,
      description: describe(card),
      kind: "a2a",
      inputSchema: peerInputSchema,
      outputSchema: peerOutputSchema,
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
  ): Promise<ToolDefinition<A2APeerInput, A2APeerOutput>> {
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
  private buildEffect(): Effect<A2APeerInput, A2APeerOutput> {
    const clientOptions: A2AClientOptions = {
      ...(this.config.headers !== undefined && { headers: this.config.headers }),
      ...(this.config.timeoutMs !== undefined && { timeoutMs: this.config.timeoutMs }),
      ...(this.config.pollIntervalMs !== undefined && { pollIntervalMs: this.config.pollIntervalMs }),
    };
    const client = createA2AClientEffect(this.config.url, clientOptions);

    return new A2AEffect<A2APeerInput, A2APeerOutput>(
      async (input: A2APeerInput, ctx: EffectContext): Promise<A2APeerOutput> => {
        const task: A2ATask = {
          // Deterministic id derived from the execution so replays stay stable.
          id: `${ctx.executionId}:${ctx.stepId}`,
          message: { role: "user", parts: [{ type: "text", text: input.prompt }] },
          ...(input.context !== undefined && { metadata: { context: input.context } }),
        };

        const result = await client.execute(task, ctx);
        return { content: artifactText(result), raw: result };
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
