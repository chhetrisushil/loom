import type { LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";

// A local, on-device LlmProvider backed by a small Gemma model via node-llama-cpp.
//
// node-llama-cpp is an OPTIONAL, native dependency and a multi-GB model download — so it
// is imported LAZILY. The package builds, installs, and runs its deterministic/offline
// paths without it; only actually calling `complete()` requires it, and a clear error
// points the user at `--offline` if it's missing.
//
// Footprint discipline (the whole reason to go local): the model is loaded and disposed
// PER invocation so its memory is transient, not resident; context is kept small; and
// output is constrained to the ChangeSpec JSON schema so a compact model stays reliable.

export interface GemmaProviderConfig {
  /** Path to a local .gguf model file (e.g. a 4-bit QAT Gemma E4B). */
  modelPath: string;
  /** JSON schema to constrain decoding to (the ChangeSpec schema). */
  jsonSchema?: Record<string, unknown>;
  /** Context window in tokens — keep small for footprint (default 4096). */
  contextSize?: number;
  temperature?: number;
  maxTokens?: number;
}

// biome-ignore lint/suspicious/noExplicitAny: node-llama-cpp is optional; typed at the boundary only.
type LlamaModule = any;

async function loadNodeLlamaCpp(): Promise<LlamaModule> {
  try {
    // Indirect specifier so tsc doesn't statically resolve (and hard-require) the
    // optional native module; it's only needed when actually running a local model.
    const specifier = "node-llama-cpp";
    return (await import(specifier)) as LlamaModule;
  } catch {
    throw new Error(
      "GemmaProvider needs the optional dependency 'node-llama-cpp' and a local .gguf model. " +
        "Install it (`pnpm add node-llama-cpp`) and pass --model <path>, or run `loom appgen` " +
        "with --offline to use the deterministic parser."
    );
  }
}

export class GemmaProvider implements LlmProvider {
  constructor(private readonly config: GemmaProviderConfig) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const nlc = await loadNodeLlamaCpp();
    const llama = await nlc.getLlama();
    const model = await llama.loadModel({ modelPath: this.config.modelPath });
    try {
      const context = await model.createContext({ contextSize: this.config.contextSize ?? 4096 });
      const session = new nlc.LlamaChatSession({
        contextSequence: context.getSequence(),
        ...(request.system !== undefined && { systemPrompt: request.system }),
      });
      const grammar =
        this.config.jsonSchema !== undefined
          ? new nlc.LlamaJsonSchemaGrammar(llama, this.config.jsonSchema)
          : undefined;
      const prompt = request.messages.map((m) => m.content).join("\n\n");
      const content: string = await session.prompt(prompt, {
        temperature: request.temperature ?? this.config.temperature ?? 0,
        ...(grammar !== undefined && { grammar }),
        ...(request.maxTokens !== undefined && { maxTokens: request.maxTokens }),
      });
      await context.dispose?.();
      return { content, stopReason: "end_turn" };
    } finally {
      // Load/unload per invocation → the footprint is transient, not resident.
      await model.dispose?.();
      await llama.dispose?.();
    }
  }
}
