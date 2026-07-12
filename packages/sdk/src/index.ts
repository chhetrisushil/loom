export * from "@loom/core";
export * from "@loom/workflow-runtime";
export * from "@loom/blueprint-runtime";
export * from "@loom/projection-runtime";
export type { EventStore } from "@loom/event-runtime";
export { InMemoryAsyncEventStore } from "@loom/event-runtime";
export type { BranchRef, BranchRegistry, LineageRecord } from "@loom/event-runtime";
export { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
export type { SnapshotStore, Snapshot } from "@loom/snapshot-runtime";
// SQLite stores are an adapter — re-exported from the plugin (ADR 0043).
export {
  SqliteEventStore,
  SqliteBranchRegistry,
  SqliteSnapshotStore,
} from "@loom/plugin-sqlite";

// ── Agentic capabilities ─────────────────────────────────────────────────────
export * from "@loom/llm";
export * from "@loom/reasoning";
export * from "@loom/agent";
export * from "@loom/mcp";
export * from "@loom/a2a";
export * from "@loom/a2ui";
export { AgentRegistry, globalAgentRegistry } from "@loom/registry";
export type { RegisteredAgent, RegisteredAgentCard } from "@loom/registry";

// ── Intelligence pipeline: Intent → Planner → Capabilities → Memory ───────────
export * from "@loom/capability";
export * from "@loom/intent";
export * from "@loom/planner";
export * from "@loom/memory";
export * from "@loom/renderer-terminal";
