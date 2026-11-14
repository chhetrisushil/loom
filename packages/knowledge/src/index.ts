export { KnowledgeBase, openKnowledgeBase } from "./KnowledgeBase";
// Note: `DecideFn` is deliberately NOT re-exported — it is the same structural type as
// `@loomwork/memory`'s and `@loomwork/reasoning`'s (all three mirror `ctx.decide`), and exporting
// more than one of them collides in the `@loomwork/sdk` barrel. Pass `ctx.decide` directly.
export type {
  KnowledgeBaseConfig,
  RetrieveOptions,
  SourceOptions,
  SyncResult,
} from "./KnowledgeBase";
export { packParagraphs } from "./chunk";
export { checkCitations, assertGrounded, UngroundedCitationError } from "./citations";
export type { CitationCheck } from "./citations";
export { groundedRequest, passageMessages } from "./prompt";
export type { GroundedRequestOptions } from "./prompt";
export type { Chunker, DocRecord, KnowledgeDoc, Passage } from "./types";
