# ADR 0122 — A conversation layer, a streaming transport and token-aware context budgeting

- Status: **Accepted** (on merge)
- Date: 2026-10-08
- Closes: R17 (agentic-readiness audit §1 "Multi-turn", recommendations 5 and 8)
- Builds on: [ADR 0110](0110-durable-inbox-and-receive-select.md) (`send` / `ctx.receive`, the chain-keyed inbox, cursors
  and the dedupe window), [ADR 0109](0109-bounded-history-and-continue-as-new.md) (a long dialogue rotates),
  [ADR 0121](0121-one-canonical-agent-loop.md) (`agentLoop$`: `signal`, recorded abort checkpoints, `AGENT_INTERRUPTED`),
  [ADR 0120](0120-llm-content-parts-and-tool-threading.md) (the transcript shape), [ADR 0119](0119-decide-scope-streaming-deltas.md)
  (live deltas are transient), [ADR 0111](0111-durable-principal.md) (whose authority a turn runs under),
  [ADR 0085](0085-untrusted-content-integrity-axis.md) (a user's words are untrusted data), [ADR 0083](0083-second-consumer-rule.md)
  (relaxed for Part R, but the consumers are still named below), R12 (the authenticated-ingress pattern).
- Consumers: **loom-ui U8** (the chat / input vocabulary: turn list, streaming deltas, status, interrupt) and the
  **`chat-agent` example** in `loom-examples` (specified in the PR; this repo does not edit that one).
- Placement: **two 1P packages, kernel untouched.** `@loom/conversation` (new) and `@loom/plugin-conversation-sse` (new
  plugin), plus three additive seams on `@loom/agent`. `KERNEL_ABI`, `EVENT_SCHEMA` and every SPI are unchanged; no
  syscall, no event kind, no payload field. Every behaviour is built from `runtime.start`, `runtime.send`,
  `ctx.receive`, `ctx.decide`, `ctx.execute`, `ctx.continueAsNew` and `EventStore.readRange / subscribe` as they exist.

## Context

The audit's multi-turn verdict was PARTIAL: "the durable single-run agent turn is solid; 'a conversation' is
unassembled". Re-measured on `main` at `e4a1519c`:

| Gap | State | Here |
| --- | --- | --- |
| No session / conversation abstraction (create, append a user turn, history, close) | open | D1, D3 |
| A user turn while the agent is running has nowhere to go | the inbox (R2) exists; nothing uses it for dialogue | D2 |
| Interruption: `cancel` is terminal, so barge-in is "kill the conversation" | `agentLoop$` has `signal` + `AGENT_INTERRUPTED` (R10); nothing wires a user to it | D2 |
| A long conversation grows the fold and the log without bound | `continueAsNew` (R1b) exists; no dialogue uses it | D4 |
| No token budgeting: compaction triggers on messages and bytes, never tokens, and folds ONE run | open | D5 |
| Streaming is an in-process callback; no transport to an end user, no SSE anywhere | open | D6, D7 |
| No reference example | open | in-repo end-to-end test here; `chat-agent` is a companion change |

### What the inbox does and does not give a barge-in (the finding that shaped D2)

The obvious design is a dialogue loop that, while a turn runs, keeps a second `ctx.receive("user-turn")` registered and
aborts the turn when it resolves. **It does not work, and the reason is in ADR 0110 D5, not a bug.** A registered wait is
satisfied at the owner's *quiescence commit* ("every live branch blocked on a registered wait, nothing in flight"), and a
model call is an in-flight step. A message that lands while the model is generating is appended to the inbox stream and
nobody looks at it until the step settles; `send` only wakes an owner that is PARKED. The first implementation here did
exactly that and the barge-in never fired (the second message was consumed after the first turn finished, as a queued
turn). Making the kernel deliver mid-step would be a new wake path in the replay-critical core for one consumer, so it is
not proposed: the signal has to come from outside the flow body (D2), which `agentLoop$` was already designed to accept.

## Decision

**D1 — A conversation is one chained execution; its id is the chain id.**

- `conversation$(config, { id?, version? })` returns a `RegisteredFlow` whose body is the dialogue loop:
  `receive("conversation:turn")` → a turn → record → repeat. Register it on a runtime with `kernel.features.inbox` and
  `kernel.features.continueAsNew`.
- `createConversations({ runtime, eventStore, flow })` is the client: `start({ principal })`, `sendTurn(id, text,
  { messageId?, principal })`, `close`, `history(id, { limit, cursor, direction, maxScan, principal })`, `status`,
  `authorizeRead`. Each is an existing authorized runtime call: `start` is `runtime.start` under the caller's principal
  (the conversation OWNS that authority, ADR 0111), `sendTurn` / `close` are `runtime.send` (the `send` op, judged against
  the chain head's owner), `history` / `status` are a `query` (`followToHead`). There is no ACL in this package to drift
  from the runtime's.
- The inbox topic carries `{ kind: "user", text, id }` or `{ kind: "close", id }`. `sendTurn` stamps `id` with the
  `messageId`, so a retry (same `messageId`) is **delivered once** by the kernel's dedupe, within the kernel's window.
  Malformed, empty or oversized (`maxTurnChars`, default 32 000) envelopes sent by anything that bypasses the client are
  recorded as `rejected` and the dialogue continues.
- A caller-chosen conversation id must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` (no `~`: the generation separator; no
  `::`: the child separator; no `__loom_` prefix). `start` is start-once for a chosen id (ADR 0103).

**D2 — Barge-in: the signal comes from outside the body, and is read only through recorded checkpoints.**

- Each turn runs `agentLoop$` with `loopId: conv#o<ord>` (a per-message ordinal, never reused) and a per-turn
  `AbortSignal`. `ord` counts every consumed envelope, accepted or not, so a recorded decision id is never reused by a
  later message.
- `inboxBargeIn(eventStore)` is the standard `BargeInSource`: while a turn runs it subscribes to the conversation's inbox
  stream (`EventStore.subscribe`, the seam `liveQuery` uses) and fires the signal when a message lands; once subscribed it
  looks for a message ALREADY waiting (one sent between the previous turn's consumption and now), so a message is not
  missed by arriving a moment early (`pendingInbox`: the stream past the newest `MESSAGE_CONSUMED` cursor in the owner's
  log tail, a few point reads, conservative when no consumption is in the tail).
- **Replay safety.** The signal is not data and the flow never branches on it. `agentLoop$` reads it only through
  *recorded* checkpoints (ADR 0121 D3: `#abort:<site>` decisions, and `<call>:interrupt` for a signal that lands inside a
  model call), so what an interruption did is in the log and a replay reproduces it with no subscription. The interrupting
  message is consumed by the ordinary `ctx.receive` that follows the interrupted turn. Tested with `divergence: "fail"`:
  a restart replays an interrupted dialogue with no model call for the old turns and no divergence; a crash between the
  interrupting message's arrival and its consumption still interrupts after recovery.
- **The execution is never cancelled.** The interrupted turn's reply is recorded with `status: "interrupted"` and the
  partial text (empty when none was produced), and it is part of the context later turns see.
- **A retry is not a barge-in.** The kernel delivers a duplicate `messageId` once, but a subscription sees every append,
  so the first cut let a client's retry of the turn being answered interrupt it (a test caught it). The flow remembers the
  idempotency keys of the last 256 turns (including the running one, carried across rotations); the source ignores a
  message whose key is known. A foreign sender that bypasses the client carries no key, so its duplicate does interrupt:
  documented, and the reason to send through the client.
- **Cutting the generation.** `ConversationHub.wrapProvider(provider)` merges the turn's signal into every request's
  `signal` and, for a streaming provider, accumulates the text it forwards and raises `LLM_INTERRUPTED` itself, so the
  partial survives whether the provider honoured the signal or kept yielding (the kernel's own capture watches the
  *effect's* signal, which a barge-in does not touch). Without the wrapper a barge-in still lands, but only at the next
  checkpoint after the model call returns.
- **The watch starts when the turn goes live.** Every wake re-runs the whole generation from the top, so subscribing per
  replayed turn would cost O(turns) store operations per message. The subscription is started inside the *user-message
  record's decider* (a decider runs only for a NEW fact) and, for a recovered turn whose model call re-runs, by the
  provider wrapper (which only a live call reaches). A replayed turn subscribes to nothing (tested: three turns, three
  subscriptions across a restart that replays two of them).
- **Without a source the conversation queues.** `bargeIn` is optional; absent, a message sent mid-turn waits for the turn
  to finish (tested).
- Limits, stated plainly: a tool call already in flight completes (the loop checks before issuing the next call); a
  provider that neither honours the signal nor streams is cut at the next checkpoint, not mid-call; the subscription is
  in-process per runtime (Postgres `LISTEN` reaches other nodes, the in-memory store does not); `requireApproval` is
  refused (a parked approval gate cannot coexist with the barge-in model, see the question below).

**D3 — The transcript is a set of decisions, read back with bounded range reads.**

- Every message (a user turn, a reply, a partial, a rejection) and the close is recorded with
  `ctx.decide("conv#o<ord>:user" | ":reply" | "conv#closed", …, { source: "conversation-record" })`. **Not `ctx.emit`.**
  ADR 0102 serves an emit on a re-run only when the log *proves* the replay, and an interrupted turn leaves an unsettled
  step (the aborted model call) that defeats the proof, so the first cut appended the transcript again on every wake
  (a test showed turn 1's interruption and turn 2's user message duplicated after the next send). A decision is served by
  its id, always: exactly once.
- `history` and `followConversation` read them through `EventStore.readRange`, never `read()`. A call scans at most
  `maxScan` events (default 2 000, blocks of 256) and returns `nextCursor` even when the page is short (`done: false`),
  so one request costs O(`maxScan`) however long the conversation or however much model and tool traffic sits between two
  messages. Forward (oldest first) and backward (newest first) are both supported; backward is how a UI loads the latest
  page. A cursor is `<generation>.<sequence>`, a position **inside the conversation's own chain**, so a cursor taken from
  another conversation reads nothing of it. A malformed cursor is `InvalidCursorError`, never "start over".
- The head generation is found by galloping and bisecting over `headOf` (generations are consecutive), O(log G) point
  reads, not a walk. Rotation does not truncate history: every generation's log stays (until retention reclaims it).
- `source: "conversation-record"` and `"conversation-budget"` are added to `@loom/learning`'s `RECORDED_FACT_SOURCES`:
  they are bookkeeping, not a choice among alternatives.

**D4 — Rotation: the rotation point is between consuming a message and starting its turn.**

- Every `rotateEveryTurns` (default 100) turns the flow `continueAsNew`s. `continueAsNew` needs no outstanding wait; the
  only wait this flow ever has is the idle `receive`, and the point just after it returns is clean. The consumed message
  rides the carry (`pending`), so the successor handles it first and the inbox cursor never re-delivers it.
- The carry is `{ v: 1, seq, ord, ids, summary?, turns, pending }`: the rolling summary, the bounded window and the
  recent idempotency keys. It is trimmed oldest-turn-first to `maxCarryBytes` (default 256 KiB, the kernel's cap is
  1 MiB) by a pure function of the carry. A tainted `pending` stays tainted.
- The kernel carries the inbox cursors and the dedupe window, so a retry of a turn from an earlier generation is still
  delivered once (tested with `rotateEveryTurns: 1`). The principal and tenant are inherited, so a stranger is refused at
  the head too (tested).

**D5 — Token-aware context budgeting: a pure fit, a recorded verdict.**

- `fitToWindow({ contextWindow, reserveOutputTokens, system, summary, prompt, turns, counter })` keeps the longest NEWEST
  suffix of whole turns that fits beside the fixed parts; the prompt is never dropped (a prompt that cannot fit even alone
  is `prompt-too-large`: recorded as a `rejected` user message, no model call, the dialogue continues). It walks newest to
  oldest and stops at the first turn that does not fit, so it counts O(kept) turns, and a turn's token cost is **cached**
  on the turn, so a steady-state conversation counts only the newest turn per message.
- `TokenCounter` is pluggable (`count(text): number | Promise<number>`, `perMessage` overhead). The default
  `heuristicTokenCounter` needs no tokenizer: ASCII at a quarter token per character rounded up, every other code point a
  whole token (CJK and emoji tokenize near or above one token per character, so a flat chars/4 would under-count them 4x
  and overflow the window). Over-counting costs some history; under-counting costs the request. A provider supplies its
  exact tokenizer through the same interface. Tool names and descriptions are counted as an estimate of the tools block.
- **Deterministic on replay.** A provider's exact counter can change between a run and its replay, so the verdict
  (`{ ok, keep, counted, tokens }`) is a `ctx.decide` (`conv#fit:<ord>`, `source: "conversation-budget"`); the counts it
  discovered are applied from the *decision*, so a replay applies the same eviction whatever the counter says now.
  Tested with a counter that has changed its mind about every old text: the verdicts win and old turns are never counted
  again.
- **Eviction and summary.** Dropped turns leave the prompt (they stay in `history`). With `budget.summarizerToolId` they
  are folded into a rolling summary through `ctx.execute` against that effect, **using the same `{ messages } → { summary }`
  contract as `agentLoop$` `compaction.toolId`, so one summarizer effect serves both**. The summary is model output over
  untrusted text, so it rides in a *fenced* `user` message (origin `conversation:summary`), never the system prompt.
  `maxWindowTurns` (default 64) bounds the carried window whether or not a budget is configured.
- **Integration with `agentLoop$` compaction, not duplication.** The two answer different questions and compose: the
  conversation budget decides which *turns* enter a run; `config.agent.compaction` (messages / bytes) keeps passing
  through and bounds the transcript *inside* a run, where tool results grow.

**D6 — The streaming transport: `@loom/plugin-conversation-sse`.**

Routes: `POST /conversations` (start; **the server mints the id**), `GET /conversations/:id` (status),
`POST /conversations/:id/turns` (`{ text, messageId? }`), `POST /conversations/:id/close`,
`GET /conversations/:id/history`, `GET /conversations/:id/events` (SSE). The SSE `id` of a durable message is its history
cursor, so the browser's automatic `Last-Event-ID` reconnect resumes **from the log**, across rotations; `?cursor=` is the
equivalent for a manual reconnect. Events: `status` (first frame), `partial` (the reply in progress, caught up on connect),
`message` (durable, with `id`), `delta` and `reset` (live, no `id`), `closed`, `reconnect`, `error`.

The data comes from `followConversation`: bounded reads, with the store's `subscribe` used only as a **wake-up** (go read),
never as a source of events, so there is one ordering and one cursor, a missed notification costs the poll interval and
never a message, and resuming is the same code path as following.

*Security model.* Fail closed at every step and say nothing a caller was not entitled to.

- **Authentication.** Every route needs `authenticate(req)` to return a principal with a non-empty `actor`, derived from
  connection facts only. The server refuses to be created without it unless `insecure: true` (warned; refused under
  `strict`). It binds `127.0.0.1` by default. `OPTIONS` carries no credentials and is answered for allowed origins only.
- **Authorization is the runtime's**, per conversation (`send` and `query` against the recorded owner, ADR 0111); there is
  no second ACL here. The default reference policy admits the owner's tenant; an owner-only policy is one rule
  (`rules: { send: "owner", query: "owner" }`) and is tested.
- **Existence is hidden.** A conversation the caller may not touch and one that does not exist both answer
  `404 {"error":"not found"}`, on every route including the stream. Authorization runs BEFORE any limit that could answer
  429 (a stranger probing a busy conversation learns nothing from the limit; tested).
- **Isolation.** A stream is keyed by one conversation id; the live hub and the log reader are both keyed by it; a cursor
  is a position inside that chain. Tested: two tenants streaming concurrently see only their own messages and deltas; a
  cursor from another conversation reads nothing of it.
- **Browser safety.** An `Origin` outside `allowedOrigins` (and not same-origin) is refused with 403 before anything runs;
  CORS headers go only to allowed origins; POST bodies must be `application/json` (415 otherwise: a cross-site form post
  cannot be a valid request); `x-content-type-options: nosniff`. The user's words travel as JSON string data in an SSE
  `data:` line (one line, newlines escaped), so a message containing `\nevent: error` cannot forge a field. They are
  untrusted: clients must render them as text.
- **Limits.** Concurrent streams (total, default 256, and per principal, default 8), live subscribers per conversation
  (the hub's, default 64), request body (64 KiB, 413 answered before the connection is dropped), stream lifetime
  (15 minutes, then a `reconnect` event), and **per-connection pending bytes** (1 MiB): `res.write` returning false
  queues frames; live deltas are *coalesced* while backed up; past the cap the slow client is closed and recovers from the
  log. Bounded at every queue.
- **Revocation.** An open stream re-runs `authenticate` and the conversation authorization every `reauthMs` (30 s); a
  revoked token, a changed principal or a policy that stops admitting the caller ends the stream (both tested, and the
  second by reverting the guard).
- **Errors.** A 500 is a fixed body plus an `errorId`; the real error goes to `onError`.

**D7 — Live deltas: transient, attributed, caught up.**

`ConversationHub` is the in-process live channel. `createAgentModelEffect(hub.wrapProvider(provider), { stream: true,
onDelta: hub.deltaSink() })` is the wiring. `deltaSink` attributes each delta to the conversation turn running the call
through an `AsyncLocalStorage` scope set by the flow, so ONE shared model effect serves every conversation without
crossing their streams (tested: two conversations mid-stream concurrently; a delta outside any turn scope is dropped,
never broadcast). Deltas are never journaled and are not produced on replay (ADR 0119). A re-run of the same turn by a
different process run emits a `reset`. The hub keeps the in-progress reply per conversation (bounded, 64 K characters) so
a client that attaches or reconnects mid-reply gets a `partial`; the final durable `message` for that turn supersedes any
partial. The hub is per process: a deployment that runs the model effect on another node (a remote worker) delivers no
live deltas on this node and falls back to the durable record.

**D8 — Trust and authority.**

- A turn runs as the conversation owner: the execution's recorded principal, inherited by every generation. The sender's
  authority is only the authority to *send*. Close is a `send` too, so whoever may send may close (see the questions).
- A user turn is untrusted data. It enters the transcript tainted with origin `conversation:user` (`AgentInput.promptOrigin`
  and `AgentHistoryMessage.origin`), fenced at the prompt boundary, refused in any instruction position. The system prompt
  is the operator's. A tainted `assistant` history message is refused by the boundary (tested), so a user cannot forge the
  model's earlier turns.
- The transcript stores the raw text; the taint is applied where it enters a prompt, as for every inbox payload.

**D9 — Three additive seams on `@loom/agent`.** `AgentLoopConfig.loopId` (the id prefix of a loop's frames, decisions and
gates; default the definition id; two loops in one execution must not share it, and the test pins what happens when they
do), `AgentInput.history` (earlier messages before the prompt, oldest first, caller-sized) and `AgentInput.promptOrigin`
(the prompt is third-party content). All default to today's behaviour byte for byte; `agentHistory.test.ts` pins both
the new behaviour and the unchanged request.

## Consequences

- A chat product is: a model effect, `conversation$`, `createConversations`, and (for the web) the SSE gateway. loom-ui
  U8 maps onto it directly: turn list = `history` (backward for the latest page), streaming = `delta` / `partial` /
  `message`, status = `status` + the user-message-without-reply rule, interrupt = just send the next message.
- The log of a conversation is the transcript's source of truth, so there is no second store to keep consistent, and a
  conversation survives a restart at any point (tested).
- Cost model: per message, the body re-runs its generation (R1b's accepted cost), bounded by `rotateEveryTurns`; replayed
  turns do no store I/O of their own; a turn costs one or two decisions for its records, one for the budget verdict, the
  loop's checkpoints and frames.
- **In-flight compatibility.** All new: nothing existing changes shape. `loopId`, `history`, `promptOrigin` are optional.
- Rejected: **a kernel mid-step wake for registered waits** (a new wake path in the replay-critical core for one consumer;
  the outside signal needs nothing from the kernel); **`ctx.emit` for the transcript** (D3); **a second ACL in the
  transport** (it would drift from the runtime's policy); **WebSocket in this change** (the same `followConversation` and
  hub back a WebSocket gateway if a consumer needs bidirectional frames; SSE plus `POST /turns` covers chat, works through
  proxies and resumes with the platform's own `Last-Event-ID`, so a second transport would be speculative); **token
  counting by an embedded tokenizer** (a dependency and a model table for one heuristic's worth of accuracy; the seam takes
  a provider's exact counter).

## Questions for the user

1. **Should `close` be owner-only?** Close is a `send`, judged by the `send` rule (default scope: the owner's tenant), so
   a tenant colleague who may send may also end the conversation. The body cannot see who sent a message (the sender is in
   `MESSAGE_CONSUMED`, not in the `receive` value). The simplest fail-closed alternative is a separate `ExecutionOp`
   (kernel) or an `ownerOnlyClose` check in the transport; neither is done.
2. **Should a conversation support `requireApproval`?** A parked approval gate (`ctx.suspend`) and the barge-in watcher
   do not compose today, so `conversation$` refuses the option and a tool that needs a human must be gated by the effect
   authorizer instead. Supporting it means deciding what a user message means while an approval is pending (answer? queue?
   cancel the approval?), which is a product decision.
3. **Queue vs interrupt as the default.** With a `bargeIn` source the default is interrupt (the spec's reading of a user
   turn while running); without one it queues. Per-message `mode: "queue"` was not built.
4. **WebSocket.** Not built (above). Say if a consumer needs it.

## Verification

`@loom/conversation`: 49 tests in 8 files; `@loom/plugin-conversation-sse`: 33 in 4; `@loom/agent`: 6 new
(`agentHistory.test.ts`). Each key guard was reverted and the test that pins it failed: the retry-vs-barge-in key
(twice), the turn-signal merge, the carry trim, the budget eviction, the prompt taint, the subscription release, the
authorization-before-limit order, the Origin check, the denial mapping and the revocation re-check.
