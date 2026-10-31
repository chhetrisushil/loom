// The walker moved down to @loom/agent so the built-in compaction summarizer can use it
// (ADR 0137); this re-export keeps `@loom/conversation`'s public surface and imports unchanged.
export { SUMMARIZER_TEXT_TRUNCATED, summarizerText } from "@loom/agent";
