export { foldEvents, normalizeSnapshotState } from "./foldEvents";
export { ReplayVM } from "./ReplayVM";
export {
  EVENT_SCHEMA_VERSION,
  FAILED_WHILE_PARKED,
  FLOW_DIVERGED_GATE,
  FLOW_EMIT_DIGEST,
  INBOX_DEDUPE_CAP,
  QUARANTINE_FOLD_CAP,
  KERNEL_STAMPED_EVENT_TYPES,
  BUILTIN_DIMENSION_NAMES,
  CUSTOM_DIMENSION_CEILING,
  CUSTOM_DIMENSION_MAX,
  CUSTOM_DIMENSION_PATTERN,
  flowEmitCount,
  knownEventTypes,
} from "./eventHandlers";
export type { FlowEmitCounts, FlowEmitLeaf } from "./eventHandlers";
export {
  SEEN_ORIGINS_DEFAULTS,
  SEEN_ORIGINS_KEY,
  SEEN_ORIGINS_OVERFLOW,
  SEEN_ORIGIN_MAX_CHARS,
  carrySeenOrigins,
} from "./seenOrigins";
export type { SeenOriginsKey, SeenOriginsLimits } from "./seenOrigins";
