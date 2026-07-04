import { flow$, step$, handler$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";

// ── Schemas ───────────────────────────────────────────────────────────────────

const taskInput = z.object({ taskId: z.string(), label: z.string() });
const taskOutput = z.object({ taskId: z.string(), summary: z.string(), applied: z.boolean() });

export type TaskInput = z.infer<typeof taskInput>;
export type TaskOutput = z.infer<typeof taskOutput>;

// ── Steps ─────────────────────────────────────────────────────────────────────
// Each step uses handler$() — modify the implementations below to experiment.

export const FetchDataStep = step$({
  id: "fetch-data",
  inputSchema: z.object({ taskId: z.string() }),
  outputSchema: z.object({ items: z.number(), source: z.string() }),
  handler: handler$(async (input: { taskId: string }) => {
    // Simulate a slight delay so you can see the "running" state
    await new Promise((r) => setTimeout(r, 600));
    return { items: Math.floor(Math.random() * 50) + 10, source: `api/tasks/${input.taskId}` };
  }),
});

export const ProcessDataStep = step$({
  id: "process-data",
  inputSchema: z.object({ taskId: z.string(), items: z.number() }),
  outputSchema: z.object({ processed: z.number(), score: z.number() }),
  handler: handler$(async (input: { taskId: string; items: number }) => {
    await new Promise((r) => setTimeout(r, 400));
    return { processed: input.items, score: Math.round(input.items * 1.8) };
  }),
});

export const ApplyResultStep = step$({
  id: "apply-result",
  inputSchema: z.object({ taskId: z.string(), score: z.number() }),
  outputSchema: z.object({ summary: z.string(), applied: z.boolean() }),
  handler: handler$(async (input: { taskId: string; score: number }) => {
    await new Promise((r) => setTimeout(r, 300));
    return {
      summary: `Task ${input.taskId} applied with score ${input.score}`,
      applied: true,
    };
  }),
});

// ── Flow definition ───────────────────────────────────────────────────────────

export const TaskFlow = flow$({
  id: "task-analysis",
  name: "Task Analysis",
  version: "1.0.0",
  inputSchema: taskInput,
  outputSchema: taskOutput,
  steps: [FetchDataStep, ProcessDataStep, ApplyResultStep],
});

// ── Runner ────────────────────────────────────────────────────────────────────

const runner: FlowRunner<TaskInput, TaskOutput> = async (ctx, input) => {
  ctx.emit("TASK_STARTED", { taskId: input.taskId, label: input.label });

  // Fetch raw data
  const data = await ctx.run(FetchDataStep, { taskId: input.taskId });
  ctx.emit("DATA_FETCHED", { items: data.items, source: data.source });

  // Process in parallel with a second fetch (comment out to try sequential)
  const result = await ctx.run(ProcessDataStep, { taskId: input.taskId, items: data.items });
  ctx.emit("DATA_PROCESSED", { processed: result.processed, score: result.score });

  // Suspend and wait for human approval — resume via the Approve button
  ctx.emit("APPROVAL_REQUESTED", { taskId: input.taskId, score: result.score });
  await ctx.suspend({ on: "TaskApproved", correlationKey: input.taskId });

  // Apply after approval
  const applied = await ctx.run(ApplyResultStep, { taskId: input.taskId, score: result.score });
  ctx.emit("TASK_COMPLETED", { taskId: input.taskId, summary: applied.summary });

  return { taskId: input.taskId, summary: applied.summary, applied: applied.applied };
};

export const RegisteredTaskFlow: RegisteredFlow<TaskInput, TaskOutput> = {
  definition: TaskFlow,
  runner,
};
