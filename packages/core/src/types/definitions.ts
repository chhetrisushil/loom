import type { ZodSchema, ZodTypeAny } from "zod";
import type { EventEnvelope } from "./event";

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

/**
 * Which side of the determinism boundary a tool may be invoked from (ADR 0073).
 *
 * - `"journaled"` — the tool participates in an execution. It runs through
 *   `ctx.execute`, its result is recorded (STEP_COMPLETED) and substituted on
 *   replay. Invoking it transiently is refused: the caller wanted a durable
 *   fact and would silently get none.
 * - `"ambient"` — the tool is a read/enrichment call that must NEVER append to
 *   the log: pagination, drill-down, a surface refetch. It runs only through
 *   `EffectRuntime.invokeTransient` (ADR 0066 — zero durable footprint by
 *   construction). Invoking it inside an execution is refused, because a call
 *   whose count and order are driven by a user poisons replay.
 *
 * Undeclared (`undefined`) keeps today's behaviour on both paths, byte-identical
 * (G2) — the marker is a true no-op until an author opts in.
 *
 * This is a DECLARATION plus a boundary check at the execute seam, **not** a
 * journaling mode: there is still exactly one replay model, and an `ambient`
 * tool is not "an effect that skips its journal" (that would be the rejected
 * DE-2 durability class — a second semantic model inside one execution). The
 * enforced copy lives on the registered effect, the same split as
 * {@link ToolDefinition.idempotent} and `egress`.
 */
export type EffectMode = "journaled" | "ambient";

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
  /**
   * DE-4 (ADR 0060) — declared failure channels: channel name → payload schema.
   * A `TypedFailure` thrown on a declared channel is a first-class domain
   * outcome: logged as STEP_FAILED `{ channel, payload }` (payload validated)
   * and substituted on replay instead of re-invoking the effect. Undeclared
   * channels keep the legacy untyped at-least-once failure semantics.
   */
  errors?: Record<string, ZodSchema>;
  /**
   * Which invocation seam this tool belongs to — see {@link EffectMode}.
   * Declaration metadata, like `idempotent`/`errors`: pass the same value to the
   * registered effect (`new ToolEffect(fn, { mode })`), which is where the
   * boundary check reads it.
   */
  mode?: EffectMode;
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
  /** DE-4 — declared failure channels (see {@link ToolDefinition.errors}). Step declaration wins over the registered effect's. */
  errors?: Record<string, ZodSchema>;
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
  /** DE-4 — declared failure channels (see {@link ToolDefinition.errors}). */
  errors?: Record<string, ZodSchema>;
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
  /**
   * TR (ADR 0077) — per-gate resume payload contracts, keyed by the resume event
   * type a `ctx.suspend({ on })` gate waits for. Declaring one makes `resume()`
   * (and `resumeAs()`) parse the payload against it BEFORE anything is appended,
   * so a malformed payload is refused rather than becoming a permanent part of
   * the log. The PARSED value (Zod defaults/transforms applied) is what is
   * recorded, matching `validateInput`'s stated principle at the other entry
   * point.
   *
   * Presence IS the opt-in: an absent map, or an event type with no entry, is
   * today's behaviour byte-identically (G2). Declared per FLOW rather than at the
   * `ctx.suspend` call site so the schema resolves from the registered definition
   * without executing the flow body — which is what makes refuse-before-append
   * possible at all.
   */
  resumeSchemas?: Readonly<Record<string, ZodTypeAny>>;
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

/** An event-fold map: for each handled event type, a pure reducer over the projection state. */
export type ProjectionHandlers<TState = unknown> = Record<
  string,
  (state: TState, event: EventEnvelope) => TState
>;

/**
 * The compiler-emitted lazy form of a projection's handlers (analogous to a step's
 * `HandlerLoader` / a skill's instructions loader). The fold map lives in its own
 * `import()` chunk; `eventTypes` carries the handled event-type KEYS so the runtime
 * can gate loading on a matching event WITHOUT importing the chunk. Both forms are
 * resolved by {@link loadProjectionHandlers}.
 */
export interface ProjectionHandlersRef<TState = unknown> {
  readonly _loomProjectionHandlersRef: true;
  /** The event types this projection folds — readable without loading the chunk. */
  eventTypes: string[];
  load: () => Promise<{ default: ProjectionHandlers<TState> }>;
}

export type ProjectionHandlersSpec<TState = unknown> =
  | ProjectionHandlers<TState>
  | ProjectionHandlersRef<TState>;

export interface ProjectionDefinition<TState = unknown> {
  readonly _tag: "ProjectionDefinition";
  id: string;
  name: string;
  sourceFlowId?: string;
  initialState: TState;
  /**
   * Inline fold map (dev / no compiler), or the compiler-emitted lazy ref
   * (`_loomProjectionHandlersRef`) whose fold code loads on demand. See
   * {@link ProjectionHandlersSpec}.
   */
  handlers: ProjectionHandlersSpec<TState>;
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
