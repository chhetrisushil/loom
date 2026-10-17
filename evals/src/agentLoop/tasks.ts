import type { LlmRequest, LlmResponse, LlmToolCall } from "@loom/llm";
import type { TaskInput } from "./subject";

// ── The scripted tasks ────────────────────────────────────────────────────────
//
// Each task is a user prompt, a SCRIPTED model (what a sensible model would say at each turn, hand-written;
// see PROVENANCE.md), and what a correct loop must do with it. The script is the source of truth for the
// committed cassette: `pnpm eval:author` runs the real loop over the script and records every request/response
// pair, so replay is the same loop over the same exchange. Shapes follow the loom-examples `agent-loop-triage`
// example (ADR 0121); the behaviours asserted are the ones that ADR documents, not invented ones.

/** The model's answer at a turn (`turn` = assistant messages so far). */
export type Script = (turn: number, request: LlmRequest) => LlmResponse;

export interface Expected {
  readonly status: "completed" | "failed";
  /** Regex SOURCE the final answer (completed) or the failure text (failed) must match. */
  readonly answer: string;
  /** The loop's dispatched calls in order (`search_tools` included). Empty for a failed run. */
  readonly dispatched: readonly string[];
  /** Live tool executions in order; `!` marks a tool that threw. */
  readonly executed: readonly string[];
  readonly parked: boolean;
  readonly refunds: number;
  /** Tool results fed back to the model as errors. */
  readonly feedbackErrors: number;
  /** The task needs tools to run at once (a parallel turn): peak in-flight must be at least this. */
  readonly minConcurrency: number;
  /** Exact model calls, only where the task IS a budget (a stop at `maxIterations`). */
  readonly exactSteps?: number;
}

export interface Task extends TaskInput {
  readonly tags: readonly string[];
  readonly script: Script;
  readonly expected: Expected;
}

const call = (id: string, name: string, input: unknown = {}): LlmToolCall => ({ id, name, input });
const use = (content: string, ...toolCalls: LlmToolCall[]): LlmResponse => ({
  content,
  toolCalls,
  stopReason: "tool_use",
});
const say = (content: string): LlmResponse => ({ content, stopReason: "end_turn" });
/** A script of fixed turns; past the end it repeats the last (a model that never stops). */
const turns =
  (...rs: LlmResponse[]): Script =>
  (turn) =>
    rs[Math.min(turn, rs.length - 1)] as LlmResponse;

const NONE = {
  dispatched: [],
  executed: [],
  parked: false,
  refunds: 0,
  feedbackErrors: 0,
  minConcurrency: 0,
};
const REFUND_PROMPT = "Order 1042 arrived broken. Please refund it.";

export const TASKS: readonly Task[] = [
  {
    id: "single-lookup",
    tags: ["lookup"],
    prompt: "What is the status of order 1042?",
    script: turns(
      use("looking the order up", call("c0", "lookup_order", { order: 1042 })),
      say("Order 1042 (a desk lamp, $49) is delivered.")
    ),
    expected: {
      ...NONE,
      status: "completed",
      answer: "desk lamp.*delivered",
      dispatched: ["lookup_order"],
      executed: ["lookup_order"],
    },
  },
  {
    id: "two-parallel",
    tags: ["parallel"],
    prompt: "Who is the customer on order 1042 and what did they buy?",
    script: turns(
      use(
        "fetching both at once",
        call("c0", "lookup_customer", { name: "Ada" }),
        call("c1", "lookup_order", { order: 1042 })
      ),
      say("The customer is Ada (pro plan) and she bought a desk lamp.")
    ),
    expected: {
      ...NONE,
      status: "completed",
      answer: "Ada.*desk lamp",
      dispatched: ["lookup_customer", "lookup_order"],
      executed: ["lookup_customer", "lookup_order"],
      minConcurrency: 2,
    },
  },
  {
    id: "sequential-dependent",
    tags: ["sequential"],
    prompt: "Summarise Ada's order.",
    script: turns(
      use("finding the customer first", call("c0", "lookup_customer", { name: "Ada" })),
      use("now her order", call("c1", "lookup_order", { customer: "cus_ada" })),
      say("Ada's order 1042 is a desk lamp and it was delivered.")
    ),
    expected: {
      ...NONE,
      status: "completed",
      answer: "order 1042.*desk lamp",
      dispatched: ["lookup_customer", "lookup_order"],
      executed: ["lookup_customer", "lookup_order"],
    },
  },
  {
    id: "flaky-recover",
    tags: ["feedback"],
    prompt: "Has order 1042 been scanned by the carrier?",
    script: turns(
      use("asking the carrier", call("c0", "carrier_status", { order: 1042 })),
      use("the carrier errored; trying once more", call("c1", "carrier_status", { order: 1042 })),
      say("Yes: the carrier scanned order 1042 as delivered, with a crushed box.")
    ),
    expected: {
      ...NONE,
      status: "completed",
      answer: "scanned.*delivered",
      dispatched: ["carrier_status", "carrier_status"],
      executed: ["carrier_status!", "carrier_status"],
      feedbackErrors: 1,
    },
  },
  {
    id: "flaky-explain",
    tags: ["feedback"],
    prompt: "Has order 1042 been scanned by the carrier?",
    script: turns(
      use("asking the carrier", call("c0", "carrier_status", { order: 1042 })),
      say("The carrier tracking service is unavailable, so I could not verify delivery.")
    ),
    expected: {
      ...NONE,
      status: "completed",
      answer: "unavailable.*could not verify",
      dispatched: ["carrier_status"],
      executed: ["carrier_status!"],
      feedbackErrors: 1,
    },
  },
  {
    id: "refund-approved",
    tags: ["approval"],
    prompt: REFUND_PROMPT,
    approval: { approve: true },
    script: turns(
      use("checking the order", call("c0", "lookup_order", { order: 1042 })),
      use("refunding", call("c1", "issue_refund", { order: 1042, amount: 49 })),
      say("Refunded order 1042 ($49).")
    ),
    expected: {
      ...NONE,
      status: "completed",
      answer: "Refunded order 1042",
      dispatched: ["lookup_order", "issue_refund"],
      executed: ["lookup_order", "issue_refund"],
      parked: true,
      refunds: 1,
    },
  },
  {
    id: "refund-declined",
    tags: ["approval"],
    prompt: REFUND_PROMPT,
    approval: { approve: false },
    script: turns(
      use("checking the order", call("c0", "lookup_order", { order: 1042 })),
      use("refunding", call("c1", "issue_refund", { order: 1042, amount: 49 })),
      say("The refund for order 1042 was declined by a reviewer, so no money moved.")
    ),
    expected: {
      ...NONE,
      status: "completed",
      answer: "declined.*no money moved",
      dispatched: ["lookup_order", "issue_refund"],
      executed: ["lookup_order"],
      parked: true,
      refunds: 0,
      feedbackErrors: 0,
    },
  },
  {
    id: "no-tool-answer",
    tags: ["no-tool"],
    prompt: "Thanks, that is all I needed.",
    script: turns(say("You are welcome. Reach out any time.")),
    expected: { ...NONE, status: "completed", answer: "welcome" },
  },
  {
    id: "search-first",
    tags: ["tool-search"],
    prompt: "Find the slowest database queries.",
    search: true,
    script: turns(
      use(
        "I need a tool for this",
        call("c0", "search_tools", { query: "slowest database queries" })
      ),
      use("loaded; calling it", call("c1", "db_slow_queries")),
      say("The slowest queries are select * from orders and select * from events.")
    ),
    expected: {
      ...NONE,
      status: "completed",
      answer: "select \\* from orders",
      dispatched: ["search_tools", "db_slow_queries"],
      executed: ["db_slow_queries"],
    },
  },
  {
    id: "search-then-parallel",
    tags: ["tool-search", "parallel"],
    prompt: "Kill the runaway session and vacuum the orders table.",
    search: true,
    script: turns(
      use(
        "find a session tool",
        call("c0", "search_tools", { query: "terminate runaway database session" })
      ),
      use("and a vacuum tool", call("c1", "search_tools", { query: "vacuum table" })),
      use(
        "both loaded; running together",
        call("c2", "db_kill_session"),
        call("c3", "db_vacuum_table")
      ),
      say("Killed session 4412 and vacuumed the orders table.")
    ),
    expected: {
      ...NONE,
      status: "completed",
      answer: "4412.*vacuumed",
      dispatched: ["search_tools", "search_tools", "db_kill_session", "db_vacuum_table"],
      executed: ["db_kill_session", "db_vacuum_table"],
      minConcurrency: 2,
    },
  },
  {
    id: "quota-stop",
    tags: ["terminal"],
    prompt: "Refund all fifty of my orders.",
    script: turns(
      use("checking the refund budget", call("c0", "check_refund_budget", { orders: 50 })),
      say("unreachable: a quota stop is never fed back to the model")
    ),
    expected: {
      ...NONE,
      status: "failed",
      answer: "budget exhausted",
      executed: ["check_refund_budget!"],
    },
  },
  {
    id: "denied-tool",
    tags: ["terminal"],
    prompt: "Delete my account.",
    script: turns(
      use("deleting the account", call("c0", "delete_account", { id: "cus_ada" })),
      say("unreachable: an authority denial is never fed back to the model")
    ),
    expected: { ...NONE, status: "failed", answer: "delete_account" },
  },
  {
    id: "step-budget",
    tags: ["budget"],
    prompt: "Keep checking order 1042 until it ships.",
    config: { maxIterations: 3 },
    // A model that never stops: a fresh call id every turn, the same tool, the same words.
    script: (turn) => use("still checking", call(`c${turn}`, "lookup_order", { order: 1042 })),
    expected: {
      ...NONE,
      status: "completed",
      answer: "still checking",
      dispatched: ["lookup_order", "lookup_order", "lookup_order"],
      executed: ["lookup_order", "lookup_order", "lookup_order"],
      exactSteps: 3,
    },
  },
];
