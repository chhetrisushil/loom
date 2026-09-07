export { MemoryRuntime } from "./MemoryRuntime";
export { InMemoryMemoryStore } from "./InMemoryMemoryStore";
export type { MemoryEntry, MemorySearchOptions, MemoryStore } from "./types";
export {
  MEMORY_STORE_SPI_VERSION,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  clampSearchLimit,
} from "./types";
export { searchableText, tokenize } from "./searchText";
export { TieredMemory, DEFAULT_TIERS } from "./TieredMemory";
// Note: `DecideFn` is intentionally not re-exported — it is the same structural type
// as `@loom/reasoning`'s (both mirror `ctx.decide`), and re-exporting both collides in
// the @loom/sdk barrel. Pass `ctx.decide` to `recall({ decide })` directly.
export type {
  RecallOptions,
  RecallRelevantOptions,
  Summarizer,
  TieredMemoryConfig,
  TierPolicy,
} from "./TieredMemory";
