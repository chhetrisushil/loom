import type { ZodSchema } from "zod";

export type EffectKind = "tool" | "llm" | "human" | "a2a";

// ── Handler types (used by handler$() and the compiler) ──────────────────────

export interface StepHandlerContext {
  executionId: string;
  stepId: string;
  workflowId: string;
  attempt: number;
  emit(eventType: string, payload: unknown): void;
}

export type HandlerFn<TIn = unknown, TOut = unknown> = (
  input: TIn,
  ctx: StepHandlerContext
) => Promise<TOut>;

export type HandlerLoader<TIn = unknown, TOut = unknown> = () => Promise<{
  default: HandlerFn<TIn, TOut>;
}>;

export interface HandlerRef<TIn = unknown, TOut = unknown> {
  readonly _loomHandlerRef: true;
  readonly fn: HandlerFn<TIn, TOut>;
}

export type HandlerSpec<TIn = unknown, TOut = unknown> =
  | HandlerRef<TIn, TOut>
  | HandlerLoader<TIn, TOut>;

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs?: number;
  backoffMultiplier?: number;
}

export interface PolicyDefinition {
  readonly _tag: "PolicyDefinition";
  id: string;
  name: string;
  rules: Record<string, unknown>;
}

export interface MemoryDefinition {
  readonly _tag: "MemoryDefinition";
  id: string;
  name: string;
  ttlMs?: number;
  maxEntries?: number;
}

export interface ToolDefinition<TIn = unknown, TOut = unknown> {
  readonly _tag: "ToolDefinition";
  id: string;
  name: string;
  description: string;
  kind: EffectKind;
  inputSchema: ZodSchema<TIn>;
  outputSchema: ZodSchema<TOut>;
  /**
   * K9 — the tool's declared delivery semantic. Effects are at-least-once (a
   * crash between the effect and its STEP_COMPLETED append re-runs it on
   * recovery). `idempotent: true` asserts a re-run is safe (dedupe at the
   * provider with `EffectContext.idempotencyKey`). `idempotent: false` marks a
   * mutating, non-idempotent tool: recovery refuses to silently re-run an
   * attempt in an unknown state and parks the execution at EFFECT_INDOUBT for
   * an operator verdict. Undeclared keeps the legacy at-least-once re-run.
   */
  idempotent?: boolean;
}

export interface StepDefinition<TIn = unknown, TOut = unknown> {
  readonly _tag: "StepDefinition";
  id: string;
  name: string;
  toolId?: string;
  handler?: HandlerSpec<TIn, TOut>;
  inputSchema: ZodSchema<TIn>;
  outputSchema: ZodSchema<TOut>;
  retry?: RetryPolicy;
  timeoutMs?: number;
}

// ── Tasks (ctx.execute) — the generalized unit of durable work (Loom 2.0) ─────
//
// A "task" generalizes a step. Every durable unit an execution runs — a step
// today, and later an llm/agent/tool/ui/memory/human/plan call — is a task. A
// StepDefinition IS the canonical 'step' task, so `ctx.run(step)` is exactly
// `ctx.execute(step)` with zero behaviour change. All kinds still resolve through
// the EffectRuntime by toolId; `kind` is advisory metadata for scheduling,
// reasoning and observability. Additive by design: the wire events stay STEP_*.
export type TaskKind = "step" | "llm" | "agent" | "tool" | "ui" | "memory" | "human" | "plan";

export interface TaskDefinition<TIn = unknown, TOut = unknown> {
  readonly _tag: "TaskDefinition";
  kind: TaskKind;
  id: string;
  name?: string;
  // Effect to resolve for this task; defaults to `id` when omitted (same rule as steps).
  toolId?: string;
  inputSchema?: ZodSchema<TIn>;
  outputSchema?: ZodSchema<TOut>;
  retry?: RetryPolicy;
  timeoutMs?: number;
}

// The argument accepted by ctx.execute: a StepDefinition (the 'step' kind,
// unchanged) or a generalized TaskDefinition. Both expose the `id` + optional
// `toolId` the runtime needs, so execute treats them uniformly.
export type ExecutableTask<TIn = unknown, TOut = unknown> =
  | StepDefinition<TIn, TOut>
  | TaskDefinition<TIn, TOut>;

export interface FlowDefinition<TIn = unknown, TOut = unknown> {
  readonly _tag: "FlowDefinition";
  id: string;
  name: string;
  version: string;
  description?: string;
  inputSchema: ZodSchema<TIn>;
  outputSchema: ZodSchema<TOut>;
  // biome-ignore lint/suspicious/noExplicitAny: a flow's steps are heterogeneous — each step has its own input/output types, so the array element type must erase them
  steps: StepDefinition<any, any>[];
  policies?: PolicyDefinition[];
  /**
   * K8.3 — declarative wall-clock deadline for a live run, anchored to the
   * logged EXECUTION_STARTED timestamp (never reset by recovery); breach is a
   * kernel-driven EXECUTION_CANCELLED. See `FlowConfig.deadlineMs` (flow$).
   */
  deadlineMs?: number;
}

// ── Schedules (schedule$) — durable cron-style executions (T1.2) ─────────────
//
// A schedule statically binds a cron expression to a flow (P5 — wiring is
// static and replay-safe). The TimerService fires each occurrence with a
// DETERMINISTIC executionId derived from `scheduleId + occurrenceTime`, so a
// fired occurrence that already started is never double-started (the store's
// uniqueness backstop settles cross-node races). Cron fields are evaluated in
// UTC so every node computes identical occurrences.
export interface ScheduleDefinition<TIn = unknown> {
  readonly _tag: "ScheduleDefinition";
  id: string;
  /** 5-field cron (min hour dom mon dow), UTC. Supports wildcards, steps, lists, ranges. */
  cron: string;
  /** The registered flow id each occurrence starts. */
  flowId: string;
  /** Input passed to every occurrence. */
  input?: TIn;
}

export interface ProjectionDefinition<TState = unknown> {
  readonly _tag: "ProjectionDefinition";
  id: string;
  name: string;
  sourceFlowId?: string;
  initialState: TState;
  handlers: Record<string, (state: TState, payload: unknown) => TState>;
}

// A2A skill descriptor carried on an agent. Defined structurally here (rather
// than importing from @loom/plugin-a2a) so @loom/core stays dependency-light; @loom/plugin-a2a
// maps this to its own AgentSkill when deriving an AgentCard.
//
// NOTE: this is A2A agent-card *metadata* — distinct from the runtime
// SkillDefinition below (skill$). AgentSkillDef advertises a capability on the
// discoverable card; SkillDefinition is a progressively-disclosed bundle of
// authored instructions injected into an agent's prompt at runtime.
export interface AgentSkillDef {
  id: string;
  name: string;
  description?: string;
  inputModes?: string[];
  outputModes?: string[];
}

// ── Skills (skill$) — progressively-disclosed agent expertise ────────────────
//
// A Skill packages authored instructions (and an optional tool subset) that an
// agent loads on demand when a task matches its description. The description is
// cheap metadata always available for selection; the instructions body is
// lazy-loadable so only selected skills are ever pulled into context — the
// compiler extracts it into its own chunk exactly as it does for handler$.

export interface InstructionsRef {
  readonly _loomInstructionsRef: true;
  readonly text: string;
}

export type InstructionsLoader = () => Promise<{ default: string }>;

export type InstructionsSpec = InstructionsRef | InstructionsLoader;

export interface SkillDefinition {
  readonly _tag: "SkillDefinition";
  id: string;
  name: string;
  description: string; // cheap metadata — always available for selection
  tags?: string[];
  instructions: InstructionsSpec; // lazy-loaded body (progressive disclosure)
  tools?: ToolDefinition[]; // optional tool subset the skill brings
}

export interface AgentDefinition {
  readonly _tag: "AgentDefinition";
  id: string;
  name: string;
  description?: string;
  tools: ToolDefinition[];
  policies?: PolicyDefinition[];
  memoryId?: string;
  // ── A2A AgentCard metadata (optional) ──
  version?: string;
  capabilities?: { streaming?: boolean };
  skills?: AgentSkillDef[];
}
