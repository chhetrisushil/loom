import type {
  AgentDefinition,
  MemoryDefinition,
  ScheduleDefinition,
  SkillDefinition,
  ToolDefinition,
} from "@loom/core";
import type { RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";

/** A statically-imported module namespace holding definitions (flows / agents / tools / …). */
export type FlowModule = Record<string, unknown>;
export type AgentModule = Record<string, unknown>;
export type ToolModule = Record<string, unknown>;
export type SkillModule = Record<string, unknown>;
export type ScheduleModule = Record<string, unknown>;
export type MemoryModule = Record<string, unknown>;

function isAgentDefinition(value: unknown): value is AgentDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { _tag?: unknown })._tag === "AgentDefinition"
  );
}
function isToolDefinition(value: unknown): value is ToolDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { _tag?: unknown })._tag === "ToolDefinition"
  );
}
function isSkillDefinition(value: unknown): value is SkillDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { _tag?: unknown })._tag === "SkillDefinition"
  );
}
function isScheduleDefinition(value: unknown): value is ScheduleDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { _tag?: unknown })._tag === "ScheduleDefinition"
  );
}
function isMemoryDefinition(value: unknown): value is MemoryDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { _tag?: unknown })._tag === "MemoryDefinition"
  );
}

/**
 * Collect every `agent$` definition exported by the given modules — by VALUE SHAPE (`_tag`),
 * so it's robust to how the agent is declared/exported (unlike AST parsing). Deterministic
 * order (module order, then declaration order). Used to feed `defineConfig`'s agent auto-wiring
 * from `loom gen`'s `agentModules`.
 */
export function agentDefinitionsFrom(...modules: AgentModule[]): AgentDefinition[] {
  const out: AgentDefinition[] = [];
  for (const mod of modules) {
    for (const value of Object.values(mod)) if (isAgentDefinition(value)) out.push(value);
  }
  return out;
}

/** Collect every `tool$` definition exported by the given modules (value-shape). */
export function toolDefinitionsFrom(...modules: ToolModule[]): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  for (const mod of modules) {
    for (const value of Object.values(mod)) if (isToolDefinition(value)) out.push(value);
  }
  return out;
}

/** Collect every `skill$` definition exported by the given modules (value-shape). */
export function skillDefinitionsFrom(...modules: SkillModule[]): SkillDefinition[] {
  const out: SkillDefinition[] = [];
  for (const mod of modules) {
    for (const value of Object.values(mod)) if (isSkillDefinition(value)) out.push(value);
  }
  return out;
}

/** Collect every `schedule$` definition exported by the given modules (value-shape). */
export function scheduleDefinitionsFrom(...modules: ScheduleModule[]): ScheduleDefinition[] {
  const out: ScheduleDefinition[] = [];
  for (const mod of modules) {
    for (const value of Object.values(mod)) if (isScheduleDefinition(value)) out.push(value);
  }
  return out;
}

/** Collect every `memory$` definition exported by the given modules (value-shape). */
export function memoryDefinitionsFrom(...modules: MemoryModule[]): MemoryDefinition[] {
  const out: MemoryDefinition[] = [];
  for (const mod of modules) {
    for (const value of Object.values(mod)) if (isMemoryDefinition(value)) out.push(value);
  }
  return out;
}

function isRegisteredFlow(value: unknown): value is RegisteredFlow {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { definition?: { id?: unknown }; runner?: unknown };
  return (
    typeof v.definition === "object" &&
    v.definition !== null &&
    typeof v.definition.id === "string" &&
    typeof v.runner === "function"
  );
}

/**
 * Register every `RegisteredFlow`-shaped export found in the given modules.
 *
 * This is the replay-safe alternative to "auto-wire from a manifest by dynamic
 * import": the app imports its flow modules **statically** (so the set of flows
 * is fixed at build time and identical on every resume / remote worker), then
 * hands the namespace objects here. Discovery is by shape, so it also captures
 * flows built via helpers (whose ids the compiler can't read statically).
 *
 * Idempotent: a flow whose id is already registered is skipped. Returns the ids
 * newly registered.
 */
export function registerFlowsFrom(runtime: WorkflowRuntime, ...modules: FlowModule[]): string[] {
  const registered: string[] = [];
  for (const mod of modules) {
    for (const value of Object.values(mod)) {
      if (!isRegisteredFlow(value)) continue;
      const id = value.definition.id;
      if (runtime.getFlow(id) !== undefined) continue;
      runtime.registerFlow(value.definition, value.runner);
      registered.push(id);
    }
  }
  return registered;
}

/**
 * Collect every `RegisteredFlow`-shaped export from the given modules WITHOUT
 * registering it — for boot-time reads that need the flow definitions (e.g.
 * building a policy authorizer from each flow's `policies`) before the runtime
 * exists. Discovery is by the same shape scan as {@link registerFlowsFrom}.
 */
export function registeredFlowsFrom(...modules: FlowModule[]): RegisteredFlow[] {
  const out: RegisteredFlow[] = [];
  for (const mod of modules) {
    for (const value of Object.values(mod)) if (isRegisteredFlow(value)) out.push(value);
  }
  return out;
}

/** Minimal view of the compiler manifest needed for the cross-check. */
export interface ManifestView {
  flows: Record<string, { warnings?: string[] }>;
}

/**
 * Cross-check the compiler manifest against what actually got registered, so a
 * flow the compiler saw but nobody wired shows up loudly at boot instead of as a
 * "No flow registered" error at dispatch time. Also surfaces the compiler's own
 * per-flow warnings. Pure — returns the messages; the caller decides how to log.
 */
export function manifestWarnings(
  manifest: ManifestView,
  isRegistered: (flowId: string) => boolean
): string[] {
  const out: string[] = [];
  for (const [flowId, flow] of Object.entries(manifest.flows)) {
    if (!isRegistered(flowId)) {
      out.push(`flow "${flowId}" is in the manifest but was not registered at boot`);
    }
    for (const w of flow.warnings ?? []) {
      out.push(`flow "${flowId}": ${w}`);
    }
  }
  return out;
}
