import type { AgentLoopConfig } from "@loom/agent";
import { CassetteMissError, type CassetteProvider, type Subject } from "@loom/eval";
import type { LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";
import { FLOW, World, answerApproval, boot, isErrorOutput } from "./world";

/** What one scripted task asks of the loop (the model's side is the cassette). */
export interface TaskInput {
  readonly id: string;
  readonly prompt: string;
  /** Run with `toolSearch` over the host catalogue and no tools of the agent's own. */
  readonly search?: boolean;
  /** The task parks on an approval; `approve` answers it in a FRESH runtime over the same store. */
  readonly approval?: { readonly approve: boolean };
  /** Tool ids the flow is granted (default: all but `delete_account`). */
  readonly grants?: readonly string[];
  /** Config the TASK needs (a step budget); a degraded run layers its own over this. */
  readonly config?: Partial<AgentLoopConfig>;
}

/** What a grader sees. Every field is a deterministic function of the loop's behaviour over the cassette. */
export interface TaskOutput {
  /** `completed`, `failed` (the run threw), or `suspended` (parked and never resumed). */
  readonly status: "completed" | "failed" | "suspended";
  /** The final answer (`""` unless completed). */
  readonly answer: string;
  /** The loop's own record of the calls it dispatched, in order (`search_tools` included); completed runs only. */
  readonly dispatched: readonly string[];
  /** Live tool executions in order, `!` suffixed when the tool threw (the loop's isError feedback path). */
  readonly executed: readonly string[];
  /** Model calls that reached the provider (a resume serves the log, so it asks only what is new). */
  readonly steps: number;
  /** Tool calls the model asked for across those calls. */
  readonly toolCalls: number;
  /** Tool results the loop fed back marked as errors (completed runs: counted from the log). */
  readonly feedbackErrors: number;
  readonly parked: boolean;
  readonly refunds: number;
  /** Most tool executions in flight at once. */
  readonly peakConcurrency: number;
  /** The failure text when `status` is `failed`. */
  readonly error?: string;
}

const MAX_ERR = 300;

/** Count what the loop asks of the model: a `LlmProvider` wrapper, not a change to the request. */
function counting(inner: LlmProvider): {
  provider: LlmProvider;
  calls: () => { steps: number; toolCalls: number };
} {
  let steps = 0;
  let toolCalls = 0;
  return {
    provider: {
      async complete(req: LlmRequest): Promise<LlmResponse> {
        const res = await inner.complete(req);
        steps++;
        toolCalls += res.toolCalls?.length ?? 0;
        return res;
      },
    },
    calls: () => ({ steps, toolCalls }),
  };
}

/** Run one task end to end against `inner` (a cassette on replay) and report what the loop did. */
export async function runTask(
  task: TaskInput,
  inner: LlmProvider,
  degrade: Partial<AgentLoopConfig> = {}
): Promise<TaskOutput> {
  const world = new World();
  const { provider, calls } = counting(inner);
  const base = {
    world,
    provider,
    prompt: task.prompt,
    config: { ...task.config, ...degrade },
    ...(task.search === true && { search: true }),
    ...(task.grants !== undefined && { grants: task.grants }),
  };
  const first = boot(base);
  const handle = await first.runtime.start(FLOW, {}, { executionId: task.id });
  let runtime = first.runtime;
  let parked = false;
  let failure: string | undefined;
  let state: Awaited<ReturnType<typeof handle.waitForCompletion>> | undefined;

  try {
    if (task.approval !== undefined) {
      await handle.waitForSuspend();
      const parkedState = await runtime.loadState(task.id);
      parked = parkedState?.status === "suspended";
      if (parked && parkedState !== null) {
        // "Restart": a brand-new runtime and effect registry over the SAME event store.
        const second = boot(base);
        runtime = second.runtime;
        const resumed = await runtime.resume(
          task.id,
          answerApproval(parkedState, { approved: task.approval.approve })
        );
        state = await resumed.waitForCompletion();
      }
    } else {
      state = await handle.waitForCompletion();
    }
  } catch (e) {
    failure = String((e as Error)?.message ?? e);
  }

  const final = await runtime.loadState(task.id);
  const events = await world.store.read(task.id);
  const failedEvent = events.find((x) => x.eventType === "EXECUTION_FAILED");
  const status: TaskOutput["status"] =
    final?.status === "completed" && state !== undefined
      ? "completed"
      : final?.status === "suspended"
        ? "suspended"
        : "failed";
  if (status === "failed") {
    failure ??= (failedEvent?.payload as { error?: string } | undefined)?.error ?? "failed";
  }
  const out = (final?.variables._output ?? undefined) as
    | { content?: string; toolCallLog?: { toolName: string; toolOutput: unknown }[] }
    | undefined;
  const log = status === "completed" ? (out?.toolCallLog ?? []) : [];
  const c = calls();
  return {
    status,
    answer: status === "completed" ? (out?.content ?? "") : "",
    dispatched: log.map((l) => l.toolName),
    executed: [...world.executed],
    steps: c.steps,
    toolCalls: c.toolCalls,
    feedbackErrors: log.filter((l) => isErrorOutput(l.toolOutput)).length,
    parked,
    refunds: world.refunds.length,
    peakConcurrency: world.peakInflight,
    ...(failure !== undefined && status === "failed" && { error: failure.slice(0, MAX_ERR) }),
  };
}

/**
 * The `@loom/eval` Subject: `runTask` over a cassette. A cassette MISS never reads as a loop failure (the model
 * effect would swallow it into `status: "failed"`): it is rethrown, so the case is `errored` and the report names
 * `CassetteMissError`, and no live call is ever made.
 */
export function agentLoopSubject(
  cassette: (task: TaskInput) => CassetteProvider,
  degrade: Partial<AgentLoopConfig> = {}
): Subject<TaskInput, TaskOutput> {
  return async (input) => {
    const provider = cassette(input);
    const out = await runTask(input, provider, degrade);
    const miss = provider.misses[0];
    if (miss !== undefined) throw new CassetteMissError(miss);
    return out;
  };
}
