import { agentLoop$, createAgentModelEffect } from "@loom/agent";
import { agent$, tool$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { ToolEffect } from "@loom/effect-runtime";
import type { EffectMiddleware } from "@loom/effect-runtime";
import { InMemoryArchiveStore, InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmResponse } from "@loom/llm";
import { InMemoryContentStore } from "@loom/plugin-content";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";
import { type ClaimCheckConfig, type LoomConfig, defineConfig } from "../defineConfig";

// Shared harness for the ADR 0140 claim-check opt-in tests and the perf test: a REAL `defineConfig` app
// running a REAL `agentLoop$` against a scripted model, with a log that JSON-clones every payload the way
// a durable store does (so a folded state never aliases live objects) and a content store that counts what
// is asked of it.

/** An in-memory log that JSON-clones on the way in and out, as a durable store does. */
export class CloningEventStore extends InMemoryAsyncEventStore {
  override async append(e: EventEnvelope): Promise<void> {
    return super.append(JSON.parse(JSON.stringify(e)) as EventEnvelope);
  }
  override async read(id: string): Promise<EventEnvelope[]> {
    return JSON.parse(JSON.stringify(await super.read(id))) as EventEnvelope[];
  }
}

/** A content store that counts every call by method name (the zero-read assertions read this). */
export class CountingContentStore extends InMemoryContentStore {
  readonly calls: Record<string, number> = {};
  constructor(now?: () => number) {
    super(now === undefined ? {} : { now });
    const self = this as unknown as Record<string, unknown>;
    for (const name of ["put", "get", "getMany", "has", "touch", "delete", "listPage", "stat"]) {
      const original = self[name];
      if (typeof original !== "function") continue;
      self[name] = (...args: unknown[]) => {
        this.calls[name] = (this.calls[name] ?? 0) + 1;
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      };
    }
  }
  /** Every call that is not a `put` (the write side of an offload). */
  get nonPutCalls(): number {
    return Object.entries(this.calls)
      .filter(([name]) => name !== "put")
      .reduce((n, [, c]) => n + c, 0);
  }
  reset(): void {
    for (const k of Object.keys(this.calls)) delete this.calls[k];
  }
}

const bigTool = tool$({
  id: "big",
  name: "big",
  description: "returns a lot",
  inputSchema: z.object({}).passthrough(),
  outputSchema: z.object({}).passthrough(),
});
const smallTool = tool$({
  id: "small",
  name: "small",
  description: "returns a little",
  inputSchema: z.object({}).passthrough(),
  outputSchema: z.object({}).passthrough(),
});

const flowDef: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "agent",
  name: "agent",
  version: "1.0.0",
  inputSchema: z.any(),
  outputSchema: z.any(),
  steps: [],
};

/** A deterministic ~1-4 kB payload per call (the #730 harness' shape). */
export function payload(n: number, size = 1500 + ((n * 797) % 2500)): { n: number; text: string } {
  const words = [
    "order",
    "customer",
    "shipped",
    "carrier",
    "scan",
    "delivered",
    "damaged",
    "refund",
  ];
  let s = "";
  let i = n;
  while (s.length < size) {
    s += `${words[i % words.length]}${i % 5 === 0 ? i * 7919 : ""} `;
    i += 3;
  }
  return { n, text: s.slice(0, size) };
}

export interface BootOptions {
  /** Agent turns that call a tool before the model answers. */
  turns: number;
  /** Which tool a turn calls (default: `big` every turn). */
  toolFor?: (turn: number) => "big" | "small";
  claimCheck?: ClaimCheckConfig;
  /** Park after the loop (`ctx.suspend({ on: "go" })`) so the run can be resumed in a fresh app. */
  park?: boolean;
  eventStore?: InMemoryAsyncEventStore;
  snapshotStore?: InMemoryAsyncSnapshotStore;
  archiveStore?: InMemoryArchiveStore;
  /** Extra `defineConfig` groups merged over the defaults (e.g. `security.crypto`). */
  extra?: Partial<LoomConfig>;
  /** A tool's output (default `payload(n)`). */
  output?: (tool: "big" | "small", n: number) => unknown;
  /** The model's final text, to exercise a long model response (default "done"). */
  finalText?: string;
  snapshotEvery?: number;
  /** The app's own `execution.effectMiddleware`. */
  effectMiddleware?: EffectMiddleware[];
}

export function boot(o: BootOptions) {
  const counts = { model: 0, big: 0, small: 0 };
  const requests: Array<{ messages: unknown[] }> = [];
  const provider: LlmProvider = {
    async complete(r): Promise<LlmResponse> {
      counts.model++;
      requests.push({ messages: [...r.messages] });
      const n = r.messages.filter((m) => m.role === "assistant").length;
      return n < o.turns
        ? {
            content: `t${n}`,
            toolCalls: [{ id: `c${n}`, name: o.toolFor?.(n) ?? "big", input: { n } }],
            stopReason: "tool_use",
          }
        : { content: o.finalText ?? "done", stopReason: "end_turn" };
    },
  };
  const eventStore = o.eventStore ?? new CloningEventStore();
  const snapshotStore = o.snapshotStore ?? new InMemoryAsyncSnapshotStore();
  const archiveStore = o.archiveStore ?? new InMemoryArchiveStore();
  const runner: FlowRunner<unknown, unknown> = async (ctx) => {
    const out = await agentLoop$(
      ctx,
      {
        definition: agent$({ id: "a", name: "A", tools: [bigTool, smallTool] }),
        modelToolId: "model",
        maxIterations: o.turns + 5,
        onWarn: () => {},
      },
      { prompt: "go" }
    );
    if (o.park === true) await ctx.suspend({ on: "go" });
    return out;
  };
  const flow = { definition: flowDef, runner } as RegisteredFlow;
  const app = defineConfig({
    storage: { kind: "custom", eventStore, snapshotStore, archiveStore },
    flows: [flow],
    autostart: false,
    observability: { onWarn: () => {} },
    ...(o.snapshotEvery !== undefined && { durability: { snapshotEvery: o.snapshotEvery } }),
    execution: {
      now: () => 1_000,
      registerEffects: (fx) => {
        fx.register("model", createAgentModelEffect(provider));
        for (const t of ["big", "small"] as const) {
          fx.register(
            t,
            new ToolEffect(async (input) => {
              counts[t]++;
              const n = (input as { n: number }).n;
              return o.output !== undefined ? o.output(t, n) : t === "big" ? payload(n) : { ok: n };
            })
          );
        }
      },
      ...(o.claimCheck !== undefined && { claimCheck: o.claimCheck }),
      ...(o.effectMiddleware !== undefined && { effectMiddleware: o.effectMiddleware }),
    },
    ...o.extra,
  } as LoomConfig);
  return { app, flow, eventStore, snapshotStore, archiveStore, counts, requests };
}
