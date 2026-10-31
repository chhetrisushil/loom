# ADR 0140 — Agent claim-check opt-in: `execution.claimCheck`

- Status: **Proposed** (2026-10-31) — implemented in the PR that carries it; accepted on merge
- Date: 2026-10-31
- Found by: GitHub issue #731 (step 1 of the snapshot-size plan in #730). Owner ruling: default behaviour
  is unchanged; this is OPT-IN only.
- Builds on: [ADR 0054](0054-claim-check-middleware.md) (claim-check middleware),
  [ADR 0087](0087-durable-agent-loop.md) (the contract toward the model, amendment 2026-09-27),
  [ADR 0137](0137-agent-state-growth-warning-and-builtin-summarizer.md) (the state-growth warning),
  [ADR 0138](0138-compaction-archives-what-it-removes.md) (what the sweep scans),
  [ADR 0083](0083-second-consumer-rule.md).
- Placement: **1P, `@loom/app` + `@loom/middleware`.** Kernel, KERNEL_ABI, EVENT_SCHEMA, every SPI unchanged.
  No new event, no new log field.

## Context

Tool outputs are about 80% of a mid-run `agentLoop$` state (#730: frames' tool outputs 80%, per-frame
metadata 11%, turn outputs 4%, `_decisions` 4%). `claimCheckMiddleware` already offloads a result over a cap
to a content store and records `{ __loomClaimCheck, ref, size, digest? }` instead (ADR 0054). Measured on
the #730 harness (1 kB cap): 4x less raw state, 8.7x under zstd. But wiring it for an agent took five
decisions the caller had to get right: build the middleware, hand it a store, choose a cap, choose WHICH
effects it touches (it runs on every effect, the model call included), and declare a digest per tool (ADR
0087 says the model sees only the envelope). Nothing said an agent should.

## Decisions

**D1 - one grouped option, no new package.** `defineConfig({ execution: { claimCheck: { store, toolIds,
inlineCapBytes?, digests?, preview?, onOffload?, reclaimable? } } })`, declared in the `execution` group like
`effectMiddleware` (the flat spelling throws like every other grouped option). It builds ordinary
`claimCheckMiddleware`. The app has no content store of its own (the sweep takes one explicitly), so the
store is supplied here - the same object you hand `sweepUnpinnedContent`. UNSET adds no middleware and
changes nothing (tested: the effect runtime's middleware list is empty).

**D2 - `toolIds` is required, and there is no "all".** The middleware runs on EVERY effect and cannot tell a
tool from the model call: offloading an over-cap model response (or the summarizer's) would hand the loop an
envelope where it reads `content` inline and break the run. So the caller names the tools (`agentLoop$` runs
a tool under its own name as the effect id), and an empty, missing or non-string list is refused at boot. An
`agentLoop$`-level option was rejected for the same reason in reverse: the middleware chain is built once at
boot, before any loop exists.

**D3 - what the model sees (the ADR 0087 contract) and the default projection.** Unchanged: the model gets
the recorded envelope as the tool result, never the resolved bytes (resolving would put them in the NEXT
turn's journaled input, undoing the offload). A bare ref is unhelpful, so a tool WITHOUT a `digests[toolId]`
entry gets a default digest `{ preview }`: the first `preview` characters (default **256**) of the result's
JSON text, via the new `previewDigest(maxChars)` in `@loom/middleware`, wired as the new `defaultDigest`
option. A declared digest always wins (it replaces the preview, it is not merged); `preview: false` records
`{ ref, size }` only. The preview is a head, not a summary, and costs about 110 KB at 200 turns (below). It
is pure and deterministic, as a digest must be (ADR 0054 D2). **The model does NOT see an offloaded tool's result: only its digest/preview (ADR 0087).** Opting in changes what the model can read, so list only tools whose output the model does not need in full (a bulk export it only needs the row count of, say); a tool the model reasons over (a search whose hits it must read) stays inline, or declares a `digests` entry that carries what the model needs. The preview says when it is a head: `{ preview, truncated: true }` (absent when the preview is the whole text). **A result that carries an ADR 0085 taint
marker anywhere is never previewed** (a digest is prompt text; previewing untrusted content would launder the
taint). A declared digest is the caller's to keep taint-free; the option's documentation says so.

**D4 - cap.** `inlineCapBytes` defaults to **1 KiB** here (the measured figure), not the middleware's 16 KiB:
the goal is state size, and a result at or under 1 KiB is cheaper inline than as an envelope plus a blob. The
cap is on the UTF-8 length of the JSON text, as ever; exactly 1024 bytes stays inline (tested).

**D5 - order (tested).** The claim-check sits just inside the kill switch and OUTSIDE secret redaction and every
`effectMiddleware` entry: what is stored is what redaction already scrubbed, and a user middleware (a retry,
a safety validator) sees the real result, not an envelope. A stopped effect never reaches it.

**D6 - replay, resume and the sweep: the blob is RETAINED (owner ruling: auditability intact).** The envelope IS
the recorded value: a fresh app resuming a parked run replays every recorded turn with ZERO content-store calls
and no tool or model re-run. But the log no longer holds the tool output, so the blob is the ONLY copy of a fact
the log once held, and nothing may prune it except erasure. The first cut left the envelope on the ADR 0054
telemetry rule (a ref cited only by a live log is TTL-reclaimable), which turned the opt-in into silent pruning.
Now the middleware built from `execution.claimCheck` marks each envelope `retain: true`
(`ClaimCheckEnvelope.retain`), and the content walker (`visitCitedAddresses`) reports a retained envelope's ref
as LOAD-BEARING: `sweepUnpinnedContent` keeps it while any live log, archive segment (ADR 0138) or snapshot
cites it, however old; it becomes reclaimable only once that history is deleted (retention discarded the log,
or erasure removed it). The classic `claimCheckMiddleware` (sentinel telemetry, ADR 0054) is unchanged: no
`retain`, TTL-reclaimable. **`reclaimable`** (`true`, or a list of tool ids) is the explicit, documented audit
trade for genuine telemetry: those envelopes carry no `retain`, their blobs are TTL-reclaimed, and
`resolveClaimCheck` then returns `null`. Replay is unaffected either way.

**D7 - the state-growth warning names it.** The ADR 0137 warning text now also says to opt in to
`execution.claimCheck` (the `warnTranscriptBytes` JSDoc too). It stays report-only, and still fires when
claim-check is on (it counts transcript bytes, which the envelope shrinks but compaction bounds).

**D8 - erasure and encryption FAIL CLOSED (blobs are subject data).** A tool output offloaded to the content
store sits outside the per-subject keys that seal the log, so a key's destruction does not reach it.
(a) **`security.crypto` + `execution.claimCheck` is REFUSED at boot** (`TypeError`, nothing composed) unless the
store declares `sealsContent: true`, meaning it seals each blob under its owning subject's key. No such store
ships: the `ContentStore` SPI has no subject on `put`/`get`, and an address that is the plain content hash leaks
plaintext equality across subjects (defeating erasure and tenant isolation), so a clean
`EncryptingContentStore` needs a subject-aware SPI revision, which is its own ADR; the refusal names the gap
rather than papering over it. (b) **`compliance.erase` over a plaintext store now reaches the blobs.** Boot
requires the store to have `delete()`. `eraseSubject`, BEFORE the shred, collects every envelope ref the
subject's executions cite (live logs, archive segments, snapshots), drops each one another, non-erased
execution still cites (ADR 0120 owner-set semantics: a deduplicated identical blob stays), refuses with
`ContentCopiesRemainError` when blobs are cited and the store is not wired / cannot delete / the event store
cannot be enumerated, and journals `ERASURE_CONTENT_DELETE_INTENDED` (addresses, touch cutoff) first. After the
shred it deletes them (`deleteIfUntouchedSince` when the store has it, so a concurrent identical `put` spares
the blob) and journals `ERASURE_CONTENT_DELETED` `{ deleted, retained }` naming the intent; a crash between is
finished by the retry from the intent, and `EraseSubjectResult.contentDeleted` reports it. Cost: one pass over
the other executions' logs, archive keys and snapshots per erasure that has blobs (rare, bounded by early exit).
`exportSubject` resolves the subject's blobs (`claimChecked: [{ address, size, digest, value | bytesBase64 |
missing }]`), so an Art. 15/20 export is the data, not just refs.

**D9 - scope: agent tool frames only, and three guards.** The middleware touches a listed tool only in an
`agentLoop$` tool frame: `EffectContext.taskKind === "tool"` (new, set by the workflow runtime from the
`TaskDefinition`) and a step id `<loop>#turn:<i>:tool:<j>`. It never applies to `invokeTransient`, a hand-written
flow step or a task of another kind that shares an id. Listing a model (`llm`) effect is refused at boot where
the registry can tell, and `agentLoop$` throws an error naming `execution.claimCheck.toolIds` if the model turn
or the compaction summary comes back as an envelope. A `returnsMedia` tool's media result passes through
un-offloaded (the loop renders its parts; an envelope would blind the model). A result that already looks like
an envelope is DATA (`envelopesAreData`): it is offloaded like any value, so a tool cannot hand the log a
forged `{ __loomClaimCheck, ref }` the sweep or a resolver would trust.

**D10 - taint is carried by the envelope.** An offloaded result with a taint marker, at the top level (an MCP
result) or nested (an A2A `content`), is recorded as `tainted(envelope, origin)`, so `agentLoop$` fences it and
records `sawTaintFrom` (writeBack and compaction stay tainted) even when a declared digest is present; the
sweep's walker still finds the inner envelope. This applies to the classic middleware too.

**D11 - a retained envelope is trusted by POSITION, not by its flag (forgery, review round 2).** `retain: true`
is plain JSON, so a tool (listed or not) could return `{ __loomClaimCheck, ref: { __loomContent: H }, retain: true }`
nested in its result and pin any blob H forever, or make `eraseSubject` count H as "still cited" by another
execution. Three rules, no new field and no secret: (1) under `envelopesAreData`, a listed tool's result that
NESTS anything envelope-shaped (the text `"__loomClaimCheck"` in its JSON, a conservative test) is force-offloaded
whole, so the lookalike is data inside the blob and the log records only the preset's own envelope; (2) the
content walker (`visitCitedAddresses`, with `retainRootsOf`) honours `retain: true` as load-bearing only on the
object at the top level of a recorded `STEP_COMPLETED` output (through a taint wrapper), exactly where the preset
writes it; a nested lookalike (an UNLISTED tool's output, which the middleware never sees) stays TTL-reclaimable
as before. Archive segments and snapshots keep pinning everything they cite (ADR 0138 conservatism: over-retain,
never lose), so a lookalike that was archived before this fix stays pinned; (3) `eraseSubject` counts another
execution as citing a blob only at that same top-level position (`trustedClaimCheckRefsOf`); that execution's
snapshot counts only when it has no recorded `STEP_COMPLETED` left to vouch for it (history gone, the snapshot
is the sole evidence: fail closed). The erased subject's OWN refs still use the broad collection (it deletes more
only of what that subject's own log cites).

**D12 - erasure never deletes a shared-addressable blob unconditionally.** `planContentDeletion` refuses with
`ContentCopiesRemainError`, BEFORE the shred, when the content store lacks `deleteIfUntouchedSince` or
`touchClock` (ContentStore SPI 1.3.0), including when a journaled intent from a prior attempt still has addresses
to delete. The post-shred delete is always the conditional one: a blob re-put (cited by another execution)
between plan and delete is spared and counted `retained`. D8's earlier "when the store has it" is superseded.

**L - hook failures.** `onOffload` runs after the tool; a throw is caught and reported through `onWarn`, never
turning an already-run tool into a failed call.

## What it does not do

- It does not bound the O(turns) model-input growth; that is `compaction` (ADR 0137). Measured below: the log
  stays dominated by re-sent transcripts at 200 turns.
- It does not seal the blob (see D8: that combination is refused, not left open).
- No "claim-check everything" shortcut, no resolve-into-the-transcript hook (ADR 0087 rejected it).

## Measured

`claimCheckOptIn.perf.test.ts` (`pnpm test:perf`), a real `defineConfig` app and `agentLoop$`, 1.5-4 kB tool
output per turn, cloning log, no compaction (folded state is what a resume reads):

| Turns | claim-check | State | Log |
|---|---|---|---|
| 50 | off | 297.8 KB | 4043 KB |
| 50 | on (256-char preview) | 70.8 KB | 953 KB |
| 50 | on, `preview: false` | 43.0 KB | 551 KB |
| 200 | off | 1201.4 KB | 60421 KB |
| 200 | on (256-char preview) | 283.4 KB | 13807 KB |
| 200 | on, `preview: false` | 172.1 KB | 7787 KB |

4.2x (7.0x without the preview) less state at 200 turns, still linear in turns.

## Second consumer (ADR 0083)

The sentinel preset (`@loom/plugin-sentinel`) wires the same middleware for telemetry; an agent app is the
unrelated second. Both use the unchanged `claimCheckMiddleware`.

## Consequences

Additive public API: `@loom/app` `execution.claimCheck`, `ClaimCheckConfig`, `DEFAULT_CLAIM_CHECK_CAP_BYTES`,
`DEFAULT_CLAIM_CHECK_PREVIEW_CHARS`; `@loom/middleware` `ClaimCheckOptions.defaultDigest`/`retain`/`passThrough`/`envelopesAreData`, `ClaimCheckEnvelope.retain`, `previewDigest`,
`PreviewDigest.truncated`; `@loom/effect-runtime` `EffectContext.taskKind`; `@loom/compliance` `ContentCopiesRemainError`, `ErasableContent`, `ClaimCheckedBlob`, `claimCheckRefsOf`, `EraseCoordinatorOptions.content`, `ExportSubjectOptions.content`; control events `ERASURE_CONTENT_DELETE_INTENDED` / `ERASURE_CONTENT_DELETED`. `@loom/app` gains `@loom/plugin-content` as a dev dependency (tests only).
