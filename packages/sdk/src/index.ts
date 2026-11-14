export * from "@loomwork/core";
export * from "@loomwork/workflow-runtime";
export * from "@loomwork/orchestration";
export * from "@loomwork/blueprint-runtime";
export * from "@loomwork/projection-runtime";
export type { EventStore } from "@loomwork/event-runtime";
export { InMemoryAsyncEventStore } from "@loomwork/event-runtime";
export type { BranchRef, BranchRegistry, LineageRecord } from "@loomwork/event-runtime";
export { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
export type { SnapshotStore, Snapshot } from "@loomwork/snapshot-runtime";
// Native-dep 1P store plugins (SQLite → better-sqlite3, Postgres → pg) are re-exported
// via subpaths — `@loomwork/sdk/sqlite`, `@loomwork/sdk/postgres` — so a bare `@loomwork/sdk` import
// stays lean and browser-safe (ADR 0043). The QuickJS sandbox (WASM engine) likewise
// rides `@loomwork/sdk/sandbox` (ADR 0064).

// ── Agentic capabilities ─────────────────────────────────────────────────────
export * from "@loomwork/llm";
export * from "@loomwork/reasoning";
export * from "@loomwork/agent";
export * from "@loomwork/plugin-mcp";
export * from "@loomwork/plugin-a2a";
export * from "@loomwork/agent-surface";
export { AgentRegistry, globalAgentRegistry } from "@loomwork/registry";
export type { RegisteredAgent, RegisteredAgentCard } from "@loomwork/registry";

// ── Intelligence pipeline: Intent → Planner → Capabilities → Memory ───────────
export * from "@loomwork/capability";
export * from "@loomwork/intent";
export * from "@loomwork/planner";
export * from "@loomwork/memory";
export * from "@loomwork/knowledge";
export * from "@loomwork/plugin-renderer-terminal";
