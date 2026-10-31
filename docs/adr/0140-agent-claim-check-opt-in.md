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
inlineCapBytes?, digests?, preview?, onOffload? } } })`, declared in the `execution` group like
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
is pure and deterministic, as a digest must be (ADR 0054 D2). **A result that carries an ADR 0085 taint
marker anywhere is never previewed** (a digest is prompt text; previewing untrusted content would launder the
taint). A declared digest is the caller's to keep taint-free; the option's documentation says so.

**D4 - cap.** `inlineCapBytes` defaults to **1 KiB** here (the measured figure), not the middleware's 16 KiB:
the goal is state size, and a result at or under 1 KiB is cheaper inline than as an envelope plus a blob. The
cap is on the UTF-8 length of the JSON text, as ever; exactly 1024 bytes stays inline (tested).

**D5 - order.** The claim-check sits just inside the kill switch and OUTSIDE secret redaction and every
`effectMiddleware` entry: what is stored is what redaction already scrubbed, and a user middleware (a retry,
a safety validator) sees the real result, not an envelope. A stopped effect never reaches it.

**D6 - replay, resume and the sweep (verified, no change).** The envelope IS the recorded value: a fresh app
resuming a parked run replays every recorded turn with ZERO content-store calls and no tool or model re-run,
including after the blobs were erased (tested with a counting store). The erasing content sweep treats these
refs by ADR 0054/0055 rules, which are NOT "pinned forever": an envelope's own `ref` cited only by a live log
is TTL-reclaimable telemetry (inside `olderThanMs` it is kept; past it, it is reclaimed, and replay does not
notice). It is retained past the TTL when a `pinnedEventTypes` kind cites it, and **pinned for as long as an
archive holds the event that cites it** (ADR 0138: compaction moves the tool steps into the archive; the
erasing pass refuses without `archiveStores`, and a TTL pass that scans only the log and the archive still
keeps the refs - tested, mutation-checked). **Consequence for audit:** the raw bytes of a tool output the
model never saw are not part of the permanent record unless you pin them. A deployment that must keep them
declares `STEP_COMPLETED` (or its own event kind) in `pinnedEventTypes`, or does not opt in.

**D7 - the state-growth warning names it.** The ADR 0137 warning text now also says to opt in to
`execution.claimCheck` (the `warnTranscriptBytes` JSDoc too). It stays report-only, and still fires when
claim-check is on (it counts transcript bytes, which the envelope shrinks but compaction bounds).

## What it does not do

- It does not bound the O(turns) model-input growth; that is `compaction` (ADR 0137). Measured below: the log
  stays dominated by re-sent transcripts at 200 turns.
- It does not seal the blob. `security.crypto` seals the event payload (the envelope and, if `STEP_STARTED.input`
  is sensitive, the preview that rides in the model input); the content store is the app's (loom ships no encrypting
  content store), so blob encryption and tenant isolation belong to the store you pass. Tested: a sealing event store plus the opt-in seals the envelope and
  replays.
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
`DEFAULT_CLAIM_CHECK_PREVIEW_CHARS`; `@loom/middleware` `ClaimCheckOptions.defaultDigest`, `previewDigest`,
`PreviewDigest`. `@loom/app` gains `@loom/plugin-content` as a dev dependency (tests only).
