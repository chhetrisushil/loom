export { MemoryRuntime } from "./MemoryRuntime";
export { InMemoryMemoryStore } from "./InMemoryMemoryStore";
export type { MemoryEntry, MemoryStore } from "./types";
export { TieredMemory, DEFAULT_TIERS } from "./TieredMemory";
// Note: `DecideFn` is intentionally not re-exported — it is the same structural type
// as `@loom/reasoning`'s (both mirror `ctx.decide`), and re-exporting both collides in
// the @loom/sdk barrel. Pass `ctx.decide` to `recall({ decide })` directly.
export type {
  RecallOptions,
  Summarizer,
  TieredMemoryConfig,
  TierPolicy,
} from "./TieredMemory";
