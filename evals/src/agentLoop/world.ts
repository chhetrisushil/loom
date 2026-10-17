import { type AgentLoopConfig, agentLoop$, createAgentModelEffect } from "@loom/agent";
import { isTainted, unwrapTainted } from "@loom/classify";
import { type FlowDefinition, type ToolDefinition, agent$, tool$ } from "@loom/core";
import { EffectRuntime, GrantTable, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";
import { QuotaExceededError } from "@loom/middleware";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime, answerApproval } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { z } from "zod";

// ── The world a scripted task runs in ─────────────────────────────────────────
//
// Real `agentLoop$` in a real `WorkflowRuntime` (in-memory stores), with a handful of synthetic tools whose
// behaviour is fixed (one is flaky, one is quota-limited, one needs a human). The only thing scripted is the
// MODEL: it arrives through the `LlmProvider` handed to {@link runTask} (a `CassetteProvider` on replay).
// Everything the loop does with the model's answer (dispatch, parallel scope, isError feedback, approval park,
// resume in a fresh runtime, budgets, tool search) is the real code.

const mk = (id: string, description: string): ToolDefinition =>
  tool$({
    id,
    name: id,
    description,
    kind: "tool",
    inputSchema: z.object({}).passthrough(),
    outputSchema: z.object({}).passthrough(),
  });

export const AGENT_TOOLS: readonly ToolDefinition[] = [
  mk("lookup_customer", "Find the customer record"),
  mk("lookup_order", "Find an order"),
  mk("carrier_status", "Ask the carrier's tracking API (flaky)"),
  mk("check_refund_budget", "Check today's refund budget"),
  mk("issue_refund", "Refund an order (destructive: needs a human)"),
  mk("delete_account", "Delete a customer account (never granted to this agent)"),
];

/** The host catalogue for the tool-search tasks: three the tasks need, the rest unrelated filler. */
export const CATALOG: readonly ToolDefinition[] = [
  mk("db_slow_queries", "List the slowest queries on the database"),
  mk("db_kill_session", "Terminate a runaway database session"),
  mk("db_vacuum_table", "Vacuum and analyze a table to reclaim space"),
  mk("send_invoice_reminder", "Email the customer a reminder that an invoice is overdue"),
  mk("create_invoice", "Create a new draft invoice for a customer"),
  mk("rotate_api_key", "Rotate an API key and revoke the old one"),
  mk("list_deployments", "List recent deployments of a service"),
  mk("post_chat_message", "Post a message to a chat channel"),
  mk("resize_image", "Resize an image to a given width and height"),
  mk("translate_text", "Translate a block of text into another language"),
];

export const FLOW: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "triage",
  name: "triage",
  version: "1.0.0",
  inputSchema: z.object({}),
  outputSchema: z.object({}).passthrough(),
  steps: [],
};

/** State that outlives a "process" (the downstream systems), plus what the harness observes. */
export class World {
  readonly store = new InMemoryAsyncEventStore();
  /** Live executions of each tool, across every process. */
  readonly runs: Record<string, number> = {};
  /** Every live tool execution in order, `!` suffixed when it threw. */
  readonly executed: string[] = [];
  readonly refunds: unknown[] = [];
  /** The carrier API throws this many more times, then recovers. */
  carrierFailures = 1;
  inflight = 0;
  peakInflight = 0;
}

export interface BootOptions {
  world: World;
  provider: LlmProvider;
  prompt: string;
  /** Overrides on the loop config (a degraded run turns these). */
  config?: Partial<AgentLoopConfig>;
  /** Searchable catalogue; when set the agent's own tools are empty and it must search. */
  search?: boolean;
  /** Tool ids the flow may run; default all except `delete_account`. */
  grants?: readonly string[];
}

const DEFAULT_GRANTS = AGENT_TOOLS.filter((t) => t.id !== "delete_account")
  .concat(CATALOG)
  .map((t) => t.id);

/** One "process": a fresh runtime and effect registry over the shared world. */
export function boot(o: BootOptions): { runtime: WorkflowRuntime; warnings: string[] } {
  const w = o.world;
  const warnings: string[] = [];
  const effects = new EffectRuntime([], {
    authorizer: new GrantTable({ [FLOW.id]: [...(o.grants ?? DEFAULT_GRANTS), "model"] }),
  });
  effects.register("model", createAgentModelEffect(o.provider));
  const impl: Record<string, (input: unknown) => Promise<unknown>> = {
    lookup_customer: async () => ({ id: "cus_ada", name: "Ada", plan: "pro" }),
    lookup_order: async () => ({ order: 1042, item: "desk lamp", price: 49, status: "delivered" }),
    carrier_status: async () => {
      if (w.carrierFailures > 0) {
        w.carrierFailures--;
        throw new Error("503 from the carrier tracking API");
      }
      return { order: 1042, scan: "delivered, box crushed" };
    },
    check_refund_budget: async () => {
      throw new QuotaExceededError("daily refund budget exhausted (50 requested, 10 left)");
    },
    issue_refund: async (input) => {
      w.refunds.push(input);
      return { refunded: true, ...(input as object) };
    },
    delete_account: async () => ({ deleted: true }),
    db_slow_queries: async () => ({ slow: ["select * from orders", "select * from events"] }),
    db_kill_session: async () => ({ killed: 4412 }),
    db_vacuum_table: async () => ({ vacuumed: "orders" }),
  };
  for (const t of [...AGENT_TOOLS, ...CATALOG]) {
    effects.register(
      t.id,
      new ToolEffect(async (input) => {
        w.runs[t.id] = (w.runs[t.id] ?? 0) + 1;
        w.inflight++;
        w.peakInflight = Math.max(w.peakInflight, w.inflight);
        try {
          // One macrotask turn: a sibling started in the same scope is in flight by now; a serial loop's is not.
          await new Promise<void>((r) => setImmediate(r));
          const out = await (impl[t.id] ?? (async () => ({ ok: true })))(input);
          w.executed.push(t.id);
          return out;
        } catch (e) {
          w.executed.push(`${t.id}!`);
          throw e;
        } finally {
          w.inflight--;
        }
      })
    );
  }
  const runtime = new WorkflowRuntime({
    eventStore: w.store,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    divergence: "fail", // a resume that re-asks anything it should have served is a loud error
    onWarn: (m) => warnings.push(m),
    scopes: true, // parallelTools runs in a ctx.parallel scope
  });
  const config: AgentLoopConfig = {
    definition: agent$({
      id: "triage-agent",
      name: "Triage",
      tools: o.search === true ? [] : [...AGENT_TOOLS],
    }),
    modelToolId: "model",
    systemPrompt: "You triage support tickets. Look the order up before you refund it.",
    maxIterations: 6,
    parallelTools: true,
    // `needsApproval` answers "does this call need a human?": `true` PARKS it for approval.
    needsApproval: (c) => c.name === "issue_refund",
    ...(o.search === true && { toolSearch: { catalog: CATALOG } }),
    ...o.config,
  };
  const runner: FlowRunner<unknown, unknown> = async (ctx) =>
    agentLoop$(ctx, config, { prompt: o.prompt });
  runtime.registerFlow(FLOW, runner);
  return { runtime, warnings };
}

/** Did a logged tool output come from a failed tool (the loop feeds those back as `{ error }`)? */
export function isErrorOutput(output: unknown): boolean {
  const v = isTainted(output) ? unwrapTainted(output) : output;
  return v !== null && typeof v === "object" && "error" in (v as object);
}

export { answerApproval };
export type { LlmRequest, LlmResponse };
