import type { ZodSchema, ZodTypeAny } from "zod";
import type { EventEnvelope } from "./event";

/**
 * ADR 0115 — the effect kinds first-party code gives a name. The kernel gives exactly ONE of
 * them meaning: an effect declaring `kind: "human"` PARKS the execution for an external answer
 * (the answer is a resume). Every other value, known or custom, is advisory metadata
 * (placement compatibility, analytics, authorization displays). `"a2a"` names a protocol that
 * lives in `@loom/plugin-a2a`; the kernel attaches no behaviour to it.
 */
export type KnownEffectKind = "tool" | "llm" | "human" | "a2a";

/**
 * An effect's kind: a {@link KnownEffectKind} or any custom name matching
 * {@link VOCABULARY_NAME_PATTERN} (`"sensor"`, `"robot"`, `"payment"`). `string & {}` keeps the
 * known values in autocomplete. Pinned: `"human"` is the one value with kernel semantics.
 */
export type EffectKind = KnownEffectKind | (string & {});

/**
 * ADR 0115 — the shape of a custom kind or metering-dimension name: lower-case start, then
 * lower-case letters, digits, `.`, `_`, `-`; at most 64 characters. A name is safe as a map key
 * and as a metrics label. (`__proto__` cannot match: it starts with `_`.)
 */
export const VOCABULARY_NAME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

/**
 * ADR 0115 — the built-in metering dimension names. A `custom` entry may never alias one (the
 * fold reads these as top-level `_resources` fields). `replay-vm` keeps its own copy for kernel
 * independence; a `workflow-runtime` agreement test pins that the copies are identical.
 */
export const BUILTIN_METER_DIMENSIONS: ReadonlySet<string> = new Set([
  "tokens",
  "costUsd",
  "ms",
  "memBytes",
  "wallMs",
  "netBytes",
]);

/** Whether `name` is a well-formed custom kind / dimension name ({@link VOCABULARY_NAME_PATTERN}). */
export function isVocabularyName(name: unknown): name is string {
  return typeof name === "string" && VOCABULARY_NAME_PATTERN.test(name);
}

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
   * R4b — the tool's input as a JSON Schema object, for tools whose schema is
   * already JSON Schema (an MCP server's `inputSchema`) and so has no Zod form.
   * Agent loops send it to the model (bounded and sanitised: depth/size caps, no
   * remote `$ref`, unknown keywords dropped) in place of the schema derived from
   * `inputSchema`, and check a call's input against its structure (object root,
   * `required`, top-level property types). Third-party bytes: see
   * {@link ToolDefinition.trustJsonSchemaText}.
   */
  jsonInputSchema?: Readonly<Record<string, unknown>>;
  /**
   * R4b — when `true`, the operator vouches for the free text (`description`,
   * `title`) of `jsonInputSchema` AND of this definition's `description`, so
   * agent loops send it to the model. Default (absent): a tool that carries a
   * `jsonInputSchema` is third-party, its description is replaced by its id and
   * the schema's `description`/`title` strings are stripped — they are read as
   * instructions by every provider (ADR 0085).
   */
  trustJsonSchemaText?: boolean;
  /**
   * R5 (ADR 0120) — the operator declares that this tool may return a media result
   * (`mediaResult(parts)` from `@loom/agent`), which agent loops then hand the model as image /
   * audio / file parts. Absent: a result shaped like a media result is just data. Only the
   * operator can set it (a tool's output cannot), and a TAINTED result is never interpreted as
   * media whatever the tool declares — so third-party output cannot choose which stored blob
   * enters the prompt.
   */
  returnsMedia?: boolean;
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
  /** R22 (ADR 0125) — declared tags for tool search; see {@link ToolDefinition.aliases} for trust. */
  tags?: readonly string[];
  /**
   * R22 (ADR 0125) — words a USER might say for this tool that its id and description do not
   * ("bill the customer", "charge"), ranked by tool search above the description. Author-declared,
   * so trusted for a first-party tool. For a tool that carries a `jsonInputSchema` (a remote MCP /
   * A2A manifest) these are the server's own claims and are NEVER indexed as trusted: they count only
   * as description-level text and only when `trustJsonSchemaText` is set. Map a remote tool's
   * vocabulary host-side with `toolSearch.annotations` instead. Bounded and normalized (NFKC,
   * case-folded, deduplicated) at index time.
   */
  aliases?: readonly string[];
}

/**
 * A capability a step can invoke at run time WITHOUT declaring it as a step of its
 * own — the menu behind a single declared unit.
 *
 * The motivating case is an agent: `agentStep$` is one step whose loop may call any
 * tool in `AgentDefinition.tools`, chosen by a model at run time. `@loom/verify` had
 * no way to see that menu, so a flow hosting an agent contributed an empty effect
 * set and every static check over it passed vacuously.
 *
 * Deliberately not agent-shaped. An A2A peer's `AgentCard.skills` is the same
 * thing — a declared capability menu reachable through one step — so this stays a
 * plain list of ids that any such producer can populate.
 */
export interface ReachableTool {
  id: string;
  /** The tool's `EffectKind`, when the producer knows it (placement compatibility). */
  kind?: EffectKind;
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
  /** EF — the class of side effect this step's tool performs (app-supplied vocabulary). */
  effectClass?: string;
  /**
   * Capabilities reachable THROUGH this step (see {@link ReachableTool}). Read by
   * `@loom/verify` via `resolveVerifyInput`; never read by the runtime, which
   * authorizes each call by `toolId` at the K2 floor regardless. Absent ⇒ nothing
   * added to the effect set, so every existing flow verifies identically (G2).
   */
  reachableTools?: readonly ReachableTool[];
}

// ── Tasks (ctx.execute) — the generalized unit of durable work (Loom 2.0) ─────
//
// A "task" generalizes a step. Every durable unit an execution runs — a step
// today, and later an llm/agent/tool/ui/memory/human/plan call — is a task. A
// StepDefinition IS the canonical 'step' task, so `ctx.run(step)` is exactly
// `ctx.execute(step)` with zero behaviour change. All kinds still resolve through
// the EffectRuntime by toolId; `kind` is advisory metadata for scheduling,
// reasoning and observability. Additive by design: the wire events stay STEP_*.
export type KnownTaskKind = "step" | "llm" | "agent" | "tool" | "memory" | "human" | "plan";

/** ADR 0115 — open like {@link EffectKind}: a known kind or any custom name (advisory metadata). */
export type TaskKind = KnownTaskKind | (string & {});

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
   * today's behaviour byte-identically (G2). Note that a strict `z.object` STRIPS unknown
   * keys, so declaring a contract also decides what is persisted — see `FlowConfig`. Declared per FLOW rather than at the
   * `ctx.suspend` call site so the schema resolves from the registered definition
   * without executing the flow body — which is what makes refuse-before-append
   * possible at all.
   */
  resumeSchemas?: Readonly<Record<string, ZodTypeAny>>;
  /** EF-1 — the flow's declared effect-class ceiling (app-supplied vocabulary). */
  effectClass?: string;
  /**
   * ADR 0113 D2 — a content hash of the flow BODY as built, supplied by the toolchain
   * (`@loom/compiler`'s bundler plugin, a build step) or by the author. Recorded on
   * `EXECUTION_STARTED.codeHash`; on resume/recovery a different value is a
   * `FlowCodeMismatchError` unless {@link compatibleWith} lists the recorded one. The kernel
   * never computes it (`Function.prototype.toString` is not stable across bundlers); absent on
   * either side means "no fingerprint" and nothing changes.
   */
  codeFingerprint?: string;
  /**
   * ADR 0113 D2 — fingerprints of earlier builds the author asserts are REPLAY-COMPATIBLE with
   * this one (the analogue of Temporal's `patched()`), reviewed in the diff that adds it. An
   * execution recorded under a listed value resumes on this code.
   */
  compatibleWith?: readonly string[];
  /**
   * ADR 0113 D4 — step-id families for `resumeAs(…, "replay-check")`. A recorded frame id
   * `base#suffix` already belongs to family `base`; list a string (an exact family) or a RegExp
   * here for ids that do not follow the `#` convention.
   */
  stepFamilies?: readonly (string | RegExp)[];
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

/**
 * A projection definition of *some* state — what a registry holds when its entries fold
 * different state types.
 *
 * `ProjectionDefinition<unknown>` cannot serve that role: a fold's state appears in both
 * parameter and return position (`(state: TState, event) => TState`), so the type is
 * INVARIANT in `TState` and `ProjectionDefinition<CpuState>` is assignable to no other
 * instantiation. Without this alias `defineConfig({ projections: [...] })` cannot be called
 * with typed projections at all — which is how the gap survived: nothing passed the field.
 */
// biome-ignore lint/suspicious/noExplicitAny: the standard escape for an invariant generic — every consumer reads id/name/version/initialState/handlers and never the state type
export type AnyProjectionDefinition = ProjectionDefinition<any>;

export interface ProjectionDefinition<TState = unknown> {
  readonly _tag: "ProjectionDefinition";
  id: string;
  name: string;
  sourceFlowId?: string;
  /**
   * ADR 0095 — the declared semantics of this fold. An artifact that binds to `id` records
   * this string; `checkVersionPins` compares the recorded one against the registered one, so
   * a changed query/filter/aggregation/window is a finding rather than a silently different
   * number. Bump it when the fold's MEANING changes; a refactor that produces the same state
   * is not a new version. Declared, not derived — a fold closure has no stable fingerprint.
   */
  version?: string;
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
  /** R22 (ADR 0125) — user phrasings for this skill, applied to its tools by tool search. */
  aliases?: string[];
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
