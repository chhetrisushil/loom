# @loomwork/agent

The agent loop for Loom. `agentLoop$` is the canonical reason-then-act loop: it runs inside a flow
runner, makes one durable frame per turn (a crash costs one turn), resolves the model call through
the `EffectRuntime` so authorization, metering, retry and delivery fencing apply to it, and can
suspend mid-flight for human approval. The package also has tool search (`search_tools`), skill
selection and activation, media tool results, and memory write-back. `AgentRunner` and `agentStep$`
are deprecated but still work.

## When to use it

When a flow needs a model to choose and call tools. Define the agent with `agent$` and its tools with
`tool$` from [`@loomwork/core`](../core/README.md), register the model and tool effects, then call
`agentLoop$(ctx, { definition, modelToolId }, { prompt })` from the runner.

## Install

`npm install @loomwork/agent` (or pnpm / yarn). Pre-1.0: every `@loomwork/*` package shares one version, so keep
them on the same release. Inside this repo use `workspace:*`; a sibling checkout links it with a `link:` override
(see [AGENTS.md](../../AGENTS.md)). You also need an LLM provider from
[`@loomwork/llm`](../llm/README.md).

## Entry points

`@loomwork/agent` (single entry): `agentLoop$`, `createAgentModelEffect`, `agentStep$` and `AgentRunner`
(deprecated), `registerReasoningRoutes`, `memoryWriteBackEffect`, `createSummarizerEffect` (compaction),
`createDistillerEffect` (distilled `writeBack`, ADR 0149), `mediaResult`, `toolSearchDocs`,
`Bm25ToolRanker`, `deterministicSkillSelector`, `llmSkillSelector`, and their config types
(`AgentLoopConfig`, `ToolSearchConfig`, `SkillActivationConfig`, ...).

## Example

```ts
import { z } from "zod";
import { agent$, tool$ } from "@loomwork/core";
import { agentLoop$, createAgentModelEffect } from "@loomwork/agent";
import type { LlmProvider } from "@loomwork/llm";
import { defineConfig } from "@loomwork/app";
import type { FlowRunner } from "@loomwork/workflow-runtime";

declare const provider: LlmProvider;

const queryTool = tool$({
  id: "query-db",
  name: "Query DB",
  description: "Run a read-only query",
  inputSchema: z.object({ sql: z.string() }),
  outputSchema: z.object({ rows: z.array(z.unknown()) }),
});
const dba = agent$({ id: "dba", name: "DBA", description: "Owns the database", tools: [queryTool] });

export const askRunner: FlowRunner<{ question: string }, unknown> = async (ctx, input) =>
  agentLoop$(ctx, { definition: dba, modelToolId: "model" }, { prompt: input.question });

defineConfig({
  storage: { kind: "memory" },
  flows: [],
  execution: {
    registerEffects: (effects) => {
      effects.register("model", createAgentModelEffect(provider)); // the id passed as modelToolId
      // ...and each tool's runnable effect under the id the tool definition names
    },
  },
});
```

## Key concepts

- **One frame per turn** costs log growth with conversation length; the mitigations (window budget,
  rolling summary) and the migration off `AgentRunner` are in
  [ADR 0121](../../docs/adr/0121-one-canonical-agent-loop.md).
- **`idempotent: false` tools** are refused by the deprecated runner unless `acceptAtLeastOnce`;
  `agentLoop$` gets K9 in-doubt protection
  ([ADR 0021](../../docs/adr/0021-k9-effect-delivery-contract-idempotency-fencing.md)).
- **`input.context` must not hold tainted values.** It is flattened into plain text in the user message, where the
  prompt boundary could not see a mark, so `agentLoop$`, `AgentRunner` and the skill selectors throw
  `UntrustedContextError` before any model call. Pass untrusted text as `prompt` with `promptOrigin`, or in `history`.
- **Memory: facts, not transcripts.** `writeBack.distill` stores model-extracted facts consolidated against the
  scope's existing ones instead of each run's raw prompt and answer, so recall stays about the size of what is
  known; `createDistillerEffect(provider)` is the built-in distiller. Opt-in; the tier must not summarize
  ([ADR 0149](../../docs/adr/0149-distilled-memory-writeback.md)).
- **Token cost**: compaction, claim-check, the lean log and distilled memory side by side in
  [Reducing token cost](../../docs/reducing-token-cost.md).
- **Large tool menus**: `toolSearch` keeps them out of the prompt
  ([ADR 0125](../../docs/adr/0125-tool-search.md)).
- Tool and MCP results can be untrusted content and are guarded before they reach a prompt.

## See also

- [API reference: `@loomwork/agent`](../../docs/api-reference.org) (ReAct loop).
- [User guide, section 7: Agents, tools and A2A](../../docs/user-guide.md#7-agents-tools--a2a).
- [`@loomwork/effect-runtime`](../effect-runtime/README.md), [`@loomwork/llm`](../llm/README.md),
  [`@loomwork/reasoning`](../reasoning/README.md).
