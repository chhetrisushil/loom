export * from "@loom/core";
export * from "@loom/workflow-runtime";
export * from "@loom/orchestration";
export * from "@loom/blueprint-runtime";
export * from "@loom/projection-runtime";
export type { EventStore } from "@loom/event-runtime";
export { InMemoryAsyncEventStore } from "@loom/event-runtime";
export type { BranchRef, BranchRegistry, LineageRecord } from "@loom/event-runtime";
export { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
export type { SnapshotStore, Snapshot } from "@loom/snapshot-runtime";
// Native-dep 1P store plugins (SQLite → better-sqlite3, Postgres → pg) are re-exported
// via subpaths — `@loom/sdk/sqlite`, `@loom/sdk/postgres` — so a bare `@loom/sdk` import
// stays lean and browser-safe (ADR 0043). The QuickJS sandbox (WASM engine) likewise
// rides `@loom/sdk/sandbox` (ADR 0064).

// ── Agentic capabilities ─────────────────────────────────────────────────────
export * from "@loom/llm";
export * from "@loom/reasoning";
export * from "@loom/agent";
export * from "@loom/plugin-mcp";
export * from "@loom/plugin-a2a";
export * from "@loom/agent-surface";
export { AgentRegistry, globalAgentRegistry } from "@loom/registry";
export type { RegisteredAgent, RegisteredAgentCard } from "@loom/registry";

// ── Intelligence pipeline: Intent → Planner → Capabilities → Memory ───────────
export * from "@loom/capability";
export * from "@loom/intent";
export * from "@loom/planner";
export * from "@loom/memory";
export * from "@loom/knowledge";
export * from "@loom/plugin-renderer-terminal";
