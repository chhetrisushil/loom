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

// A genuine dynamic `import()` preserved through the `new Function` boundary. tsc under
// `module: CommonJS` would otherwise down-level `import()` to `require()`, which cannot
// load node-llama-cpp (an ESM-only, top-level-await module → ERR_REQUIRE_ASYNC_MODULE).
// biome-ignore lint/security/noGlobalEval: intentional — the only way to keep a real ESM import from CJS output.
const esmImport = new Function("s", "return import(s)") as (s: string) => Promise<LlamaModule>;

async function loadNodeLlamaCpp(): Promise<LlamaModule> {
  try {
    return await esmImport("node-llama-cpp");
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `GemmaProvider needs the optional dependency 'node-llama-cpp' and a local .gguf model. Install it (\`pnpm add node-llama-cpp\`) and pass --model <path>, or run \`loom appgen\` with --offline to use the deterministic parser. (cause: ${cause})`
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
      const context = await model.createContext({ contextSize: this.config.contextSize ?? 2048 });
      const session = new nlc.LlamaChatSession({
        contextSequence: context.getSequence(),
        ...(request.system !== undefined && { systemPrompt: request.system }),
      });
      // node-llama-cpp v3 builds a JSON-schema grammar via the Llama instance (the
      // `LlamaJsonSchemaGrammar` constructor is not the public entry point).
      const grammar =
        this.config.jsonSchema !== undefined
          ? await llama.createGrammarForJsonSchema(this.config.jsonSchema)
          : undefined;
      const prompt = request.messages.map((m) => m.content).join("\n\n");
      const content: string = await session.prompt(prompt, {
        temperature: request.temperature ?? this.config.temperature ?? 0,
        ...(grammar !== undefined && { grammar }),
        // A ChangeSpec is small; bound generation (footprint + stability). Callers can
        // override, but we never leave it unbounded.
        maxTokens: request.maxTokens ?? this.config.maxTokens ?? 512,
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
