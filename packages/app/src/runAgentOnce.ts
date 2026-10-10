import {
  type AgentInput,
  type AgentLoopConfig,
  type AgentOutput,
  agentLoop$,
  createAgentModelEffect,
} from "@loom/agent";
import type { AgentDefinition, EventEnvelope, FlowDefinition } from "@loom/core";
import type { ExecutionStatus } from "@loom/core";
import type { EffectRuntime, PrincipalChain } from "@loom/effect-runtime";
import { z } from "zod";
import { type LoomConfig, defineConfig } from "./defineConfig";

/**
 * `runAgentOnce` builds a fresh `defineConfig` app per call, so the permissive-defaults notice would print on
 * every call of a script that loops. After the first print (to the default console sink) later calls
 * acknowledge it (`security.strict: false`, which only silences the notice). A caller's own `strict` or
 * `observability.onWarn` is never overridden, and a real app's `defineConfig` is unaffected.
 */
let permissiveNoticeShown = false;

/** The model provider `createAgentModelEffect` takes (derived, so `@loom/app` need not depend on `@loom/llm`). */
type Provider = Parameters<typeof createAgentModelEffect>[0];

export interface RunAgentOnceOptions {
  /** The agent to run. Its `tools` are the menu; register their effects with {@link registerEffects}. */
  agent: AgentDefinition;
  /**
   * The model. Registered as the effect `loop.modelToolId` (default `"model"`) through
   * `createAgentModelEffect`, so the model call goes through the same ring (authorization, metering,
   * kill switch, journaling) as in a production flow. Omit it only when `registerEffects` registers that effect.
   */
  provider?: Provider;
  /** Register the agent's tool effects (and anything else the loop calls) on the app's `EffectRuntime`. */
  registerEffects?: (effects: EffectRuntime) => void | Promise<void>;
  /** The prompt, or the full {@link AgentInput}. */
  input: string | AgentInput;
  /** `agentLoop$` options (system prompt, skills, `needsApproval`, `maxIterations`, ...). Validated by `agentLoop$` itself. */
  loop?: Omit<AgentLoopConfig, "definition">;
  /**
   * `defineConfig` options (security, observability, durability, ...). Storage is in-memory and the one-off flow is
   * the only flow. Nothing is relaxed: a strict profile, an authorizer or a kill switch given here applies.
   */
  config?: Omit<LoomConfig, "storage" | "flows" | "flowModules">;
  /** The execution id (default: minted). */
  executionId?: string;
  /**
   * The principal the execution runs as (passed to `runtime.start`), so a script can exercise its grants:
   * an authorizer in `config.security` sees it on every effect. Omit to run with none.
   */
  principal?: PrincipalChain;
}

export interface RunAgentOnceResult {
  /** The loop's result. Absent when the run did not complete (it suspended, for example on an approval). */
  output?: AgentOutput;
  /** `"completed"`, or `"suspended"` when the loop is waiting (this helper does not resume it). */
  status: ExecutionStatus;
  executionId: string;
  /** The execution's full event log. Feed it to `selectedSkillsOf`, or assert on it. */
  events: EventEnvelope[];
}

/**
 * Run `agentLoop$` once, to completion, in a throwaway in-memory app, and hand back the result and the
 * recorded events.
 *
 * **For scripts and tests only.** It exists because `agentLoop$` needs an `ExecutionContext`, which only a
 * flow has, so a one-off script otherwise builds a flow plus a `defineConfig` app by hand. Nothing it
 * records survives the call (the app is closed and its in-memory store dropped). Production code puts
 * `agentLoop$` in a registered flow, on durable storage, and resumes it.
 *
 * It takes no shortcut around a protection: it goes through `defineConfig`, so a `config.security`
 * profile, authorizer or kill switch applies as in any app, the model call is an effect in the ring, and
 * `agentLoop$` validates `loop` exactly as it would in a flow (for example `requireEffectRing`). A
 * configuration `agentLoop$` refuses rejects here with the same error, not a wrapped or swallowed one.
 */
export async function runAgentOnce(options: RunAgentOnceOptions): Promise<RunAgentOnceResult> {
  const loop = options.loop ?? {};
  const modelToolId = loop.modelToolId ?? "model";
  if (
    options.provider === undefined &&
    options.registerEffects === undefined &&
    loop.reasoning === undefined
  ) {
    throw new TypeError(
      "runAgentOnce: supply a `provider`, or `registerEffects` that registers the model effect, or `loop.reasoning`"
    );
  }
  const prompt: AgentInput =
    typeof options.input === "string" ? { prompt: options.input } : options.input;
  const definition: FlowDefinition = {
    _tag: "FlowDefinition",
    id: `run-agent-once:${options.agent.id}`,
    name: "run-agent-once",
    version: "1.0.0",
    inputSchema: z.object({}),
    outputSchema: z.object({}).passthrough(),
    steps: [],
  };
  let output: AgentOutput | undefined;
  let thrown: { error: unknown } | undefined;
  const cfg = options.config;
  let security = cfg?.security;
  if (security?.strict === undefined && cfg?.observability?.onWarn === undefined) {
    if (permissiveNoticeShown) security = { ...security, strict: false };
    else permissiveNoticeShown = true;
  }
  const app = defineConfig({
    ...cfg,
    ...(security !== undefined && { security }),
    storage: { kind: "memory" },
    flows: [
      {
        definition,
        runner: (async (ctx: Parameters<typeof agentLoop$>[0]) => {
          try {
            output = await agentLoop$(
              ctx,
              { ...loop, definition: options.agent, modelToolId },
              prompt
            );
            return { ...output };
          } catch (error) {
            // A park (approval, in-flight suspend) is control flow the runtime must see; keep every throw
            // for the caller, and rethrow so the runtime treats it exactly as it would in a flow.
            thrown = { error };
            throw error;
          }
        }) as never,
      },
    ],
  });
  try {
    await options.registerEffects?.(app.effectRuntime);
    if (options.provider !== undefined) {
      // Two sources for one effect id would silently let the later registration win: refuse instead.
      if (app.effectRuntime.has(modelToolId)) {
        throw new TypeError(
          `runAgentOnce: both \`provider\` and \`registerEffects\` register the model effect "${modelToolId}"; supply only one`
        );
      }
      app.effectRuntime.register(modelToolId, createAgentModelEffect(options.provider));
    }
    const handle = await app.runtime.start(
      app.runtime.getFlow(definition.id) as never,
      {},
      options.executionId !== undefined || options.principal !== undefined
        ? {
            ...(options.executionId !== undefined && { executionId: options.executionId }),
            ...(options.principal !== undefined && { principal: options.principal }),
          }
        : undefined
    );
    let state: Awaited<ReturnType<typeof handle.waitForCompletion>>;
    try {
      state = await Promise.race([handle.waitForCompletion(), handle.waitForSuspend()]);
    } catch (error) {
      throw thrown !== undefined ? thrown.error : error;
    }
    const events = (await app.stores.eventStore.read(handle.executionId)) as EventEnvelope[];
    if (state.status === "completed" || state.status === "suspended") {
      return {
        ...(output !== undefined && { output }),
        status: state.status,
        executionId: handle.executionId,
        events,
      };
    }
    if (thrown !== undefined) throw thrown.error;
    throw new Error(`runAgentOnce: the run ended ${state.status}`);
  } finally {
    await app.close();
  }
}
