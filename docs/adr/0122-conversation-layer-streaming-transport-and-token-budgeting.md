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
  **`chat-agent` example** in `loom-examples` (specified in the PR; this repo does not edit that one); shared mode: an
  AI-mode incident surface whose chat several responders share.
- Revision: fix round 3 (replay-set floor, signed-only queue count, annotate policed, domain-separated envelopes, key rotation). Fix round 2 (shared-mode review, not approved) — host-signed bound envelopes in both modes (D8), owner-scoped
  runtime policy required (D8), service-owned coordinator, unguessable verified turn ids, delegation, per-asker memory,
  classified questions, strict clearance (D10). Fix round 1 (Opus review of PR #518, not approved) — owner-only default (D8), shared mode (D10), bounded
  backward reads (D3), edge hardening (D6), summary/identity/peek fixes (D2, D5).
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
  (the conversation OWNS that authority, ADR 0111), `sendTurn` / `close` are `runtime.send`, `history` / `status` are a
  `query` (`followToHead`). Who may call is decided first by the client against the recorded owner (D8; owner-only by
  default) and the runtime's own policy still applies underneath.
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
  message whose key is known. The key is the **kernel's own dedupe identity**, `sha256([tenant, actor, onBehalfOf,
  messageId])` of the sender the runtime recorded (`senderKey`), and the watcher honours a payload `id` only when it equals
  that key for THIS stored message: a different sender replaying someone's id is a new message and interrupts (P3-8). A
  foreign sender that bypasses the client carries no key, so its duplicate does interrupt: documented, and the reason to send
  through the client.
- **The peek is not a fixed lookback.** `pendingInbox` finds the owner's consumed cursor by reading the owner's log
  BACKWARDS in blocks (up to 8 192 events) until it finds a `MESSAGE_CONSUMED`, so a turn with any amount of tool traffic,
  or a recovery re-running one, is compared against the right cursor (the first cut looked at the last 64 events and could
  miss a barge-in, P3-7).
- **Roles alternate.** A turn with no reply text (interrupted before any, failed) is given a placeholder assistant message
  (`(interrupted)`, `(no reply: the request failed)`) and the summary a short acknowledgement, so a provider that rejects
  consecutive same-role messages is never sent two (P3-9).
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
  **A cursor is untrusted input, clamped to what exists** (P1-a): a generation past the head means "from the end" (found by
  the same O(log G) probe), a sequence past a generation's tip is clamped to the tip, and **every generation hop counts
  against `maxScan`**, so one call is O(`maxScan`) store operations whatever the cursor says (`?direction=backward&cursor=
  999999999.0` was ~2e9 store calls before). A read also takes a `signal`: the gateway aborts it when the client goes away.
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
  contract as `agentLoop$` `compaction.toolId`, so one summarizer effect serves both**. *(Note: both inputs may carry `tainted()` wrappers - here the user's words and the previous summary, in `compaction.toolId` failed tool calls, MCP results and origin-bearing history, nested in text parts and `tool_result` content; `textOf` on one throws `TaintedContentError`, and `summarizerText` from `@loom/conversation` is the sanctioned reader. It returns untrusted data that must stay out of instruction positions; the summary is re-injected fenced with origin `conversation:summary`.)* The summary is model output over
  untrusted text, so it rides in a *fenced* `user` message (origin `conversation:summary`), never the system prompt.
  `maxWindowTurns` (default 64) bounds the carried window whether or not a budget is configured. **The summary can never
  wedge the conversation** (P3-1): it is cut to `maxSummaryTokens` (default a quarter of the window) by a recorded decision
  that counts with the counter, and a fit that fails only because the summary is too big retries without it
  (`dropSummary`) rather than rejecting every later turn. The start input is read as untrusted JSON (`carryOf`: shape,
  counts, text sizes and bytes all bounded, P3-10).
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
- **Authorization is `@loom/conversation`'s**, per conversation and **owner-only by default** (D8), or the explicit
  participant set of a shared conversation (D10); the gateway holds no second ACL, it maps the client's refusal to the one
  404. The runtime's own policy still applies underneath in owner-only mode.
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
- **Edge hardening (fix round 1).** `strict` defaults from the runtime (`requiresPrincipal`) as the A2A server does; the
  server refuses to front a runtime with no fail-closed execution authorizer unless `allowNoRuntimeAuthz`; an unauthenticated
  (`insecure`) server answers only loopback `Host` names (DNS rebinding), and `allowedHosts` does the same for an
  authenticated one; **`Host` never proves same-origin**: a request with an `Origin` must name one of `allowedOrigins`
  exactly; CORS headers ride error responses too (a browser cannot read a 4xx without them) and
  `access-control-allow-credentials` is sent to listed origins only when `allowCredentials` is set; `requestTimeout` /
  `headersTimeout` / `maxConnections` are set on the HTTP server; POSTs are rate-limited per principal (default 120 per
  minute); a connection dropped during authorization releases its slot at once (P2-1).

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

**D8 — Trust and authority: OWNER-ONLY by default.**

- **The default is the owner and nobody else.** Only the identity that started a conversation may send to it, close it,
  read its history or status, or stream it. *Identity* is the bounded subset of ADR 0111: `{ tenant?, actor, onBehalfOf? }`,
  equal iff **all three** fields are equal (an absent field equals only an absent field). A delegate acting `onBehalfOf` the
  owner is a different identity and is NOT the owner: delegation narrows authority, it never widens who owns. A credential
  (a delegation token) is not part of identity. A principal with no `actor` cannot own or join anything.
- **Why this is the default, stated as an escalation.** The first cut left authorization to the runtime's reference policy,
  whose default `send` / `query` scope is *the owner's tenant*. In a conversation that is an escalation, not a read: a
  `send` is a prompt to an agent that runs with the **owner's authority** (tools, memory, quotas, approvals), so any
  same-tenant principal could drive the owner's agent as the owner and read the transcript (review finding P1-b). Owner-only
  closes that. Sharing is the explicit shared mode (D10), which does not run anyone's prompt with anyone else's authority.
- **How it is enforced, and why it is not the kernel's job.** `createConversations` reads the recorded owner once per
  conversation from sequence 0 of generation 0 (immutable and start-once): the identity the client stamped into the start
  input, **cross-checked** against the identity the kernel recorded for the starting principal when that is stored verbatim; a
  disagreement is an UNKNOWN owner and nobody matches. Every operation is judged here first, and every refusal is the same
  `ConversationNotFoundError` as for a conversation that does not exist (the gateway maps it to the one 404). The runtime's
  own policy still applies underneath. No kernel change: the owner is data the client writes at the one moment only the
  starter can write it.
- **`close` is owner-only** (a manager, in shared mode): it falls out of the above.
- **Every message is a host-signed envelope, in BOTH modes (fix round 2).** The inbox is writable by whatever the
  runtime's policy admits, and what arrives is data, not authority. The client signs (HMAC-SHA-256 under `config.key`,
  required) a body of `{ conversationId, kind, id, iat, text, asker }`; the conversation body acts on a message only if the
  signature verifies, `conversationId` is THIS conversation, the voice (`asker`) is the recorded owner (owner-only) or a
  named participant (shared), the `id` has not been consumed before, and `iat` is within `maxEnvelopeAgeMs` of the clock
  (read once, in a recorded decision, so replay never re-reads it). Anything else is recorded as `rejected`
  (`unauthenticated` / `malformed` / `replayed` / `stale`) up to `maxInvalidRecords`, then only counted (a recorded counter
  every 100). The `id` is the sender-bound idempotency key, which is also the kernel `messageId` in shared mode; the replay
  set is the last 1 024 ids, carried across rotations. The reviewer's first-cut hole (a peer copied another participant's
  signed envelope with a new `messageId` and the turn ran as them) is closed by the replay set plus the freshness window;
  an unsigned or foreign message in an owner-only conversation (a same-tenant colleague raw-`send`ing "speaking as the
  owner") is rejected, not obeyed.
- **Raw runtime access is a second door, and the policy must close it (fix round 2).** The conversation's log holds the
  unfiltered transcript and every signed envelope; the runtime's `query`, `send`, `cancel`, `resume` and `fork` are the
  doors around everything above. `createConversations` therefore REFUSES, at construction, a runtime whose execution policy
  is not `owner`-scoped (or `deny`) for `query`, `send`, `cancel`, `resume` and `actAsOwner`: pass the
  `executionAccessPolicy({ rules: { query: "owner", send: "owner", cancel: "owner", resume: "owner" } })` object you built the
  runtime with (`policy`; the reference policy now exposes its resolved `scopes`, read-only, 1P), or acknowledge a policy it
  cannot inspect with `runtimePolicyIsOwnerScoped: true`. The gateway inherits the check. **Residual, stated plainly:** an
  acknowledged-but-looser policy (or one that is changed after construction) lets a tenant peer read the coordinator's log
  around every filter; the signed-envelope rules above still keep a peer from DRIVING the conversation, but nothing in this
  layer can stop a peer the runtime lets `query` from reading it.
- A turn runs as the conversation owner in owner-only mode: the execution's recorded principal, inherited by every
  generation. The sender is the owner, so the sender's authority and the turn's are the same.
- A user turn is untrusted data. It enters the transcript tainted with origin `conversation:user` (`AgentInput.promptOrigin`
  and `AgentHistoryMessage.origin`), fenced at the prompt boundary, refused in any instruction position. The system prompt
  is the operator's. A tainted `assistant` history message is refused by the boundary (tested), so a user cannot forge the
  model's earlier turns. The summarizer is handed the user's words tainted too, and the previous summary tainted
  `conversation:summary` (it is model output over untrusted text); only the model's own words go in plain.
- The transcript stores the raw text; the taint is applied where it enters a prompt, as for every inbox payload.
- **A failed turn tells the user nothing about the failure.** The record carries a fixed `reason` (`model-error`,
  `denied`, `turn-failed`, `cancelled`) and an `errorId`; the real error goes only to the host's `onError(errorId, err,
  { conversationId, turn })`, once (it runs in the record's live decider, so a wake's replay does not report it again).
  A provider error can carry hostnames, request ids or credentials; the first cut recorded `${name}: ${message}` into a
  transcript every viewer reads (P2-2).

**D9 — Three additive seams on `@loom/agent`.** `AgentLoopConfig.loopId` (the id prefix of a loop's frames, decisions and
gates; default the definition id; two loops in one execution must not share it, and the test pins what happens when they
do), `AgentInput.history` (earlier messages before the prompt, oldest first, caller-sized) and `AgentInput.promptOrigin`
(the prompt is third-party content). All default to today's behaviour byte for byte; `agentHistory.test.ts` pins both
the new behaviour and the unchanged request.

**D10 — Shared mode: participants, each turn run as its ASKER, classified, filtered per viewer.**

Motivating workload: an incident surface whose AI chat is shared by several responders. `conversation$({ shared })` +
`createConversations({ effects })`; owner-only (D8) stays the default and is unchanged.

1. **Participants, not tenant.** The set is explicit and managed by the owner or a host-supplied `manageParticipants(manager,
   conversationId)`; the owner is always a participant and cannot be removed; at most 100. Changes are events: the standard
   `ParticipantDirectory` (`logParticipants(eventStore)`) is an append-only side stream `conversation-participants:<id>`
   (one `PARTICIPANT_CHANGED` per change, with who made it), never the conversation's own log (a sender must not append to
   the owner's log, ADR 0110 D1). It is read on EVERY request, so a removal takes effect on the next one; an open SSE stream
   re-authorizes every `reauthMs` and ends. A non-participant gets the uniform 404 for send / history / status / stream /
   close / participants. Because participants are not the owner, the client performs the runtime calls with the runtime's
   system grant after its own check (it is the one place that knows the set). **The coordinating execution is owned by a
   HOST-SUPPLIED SERVICE PRINCIPAL** (`shared.servicePrincipal`, required) and is started under it; the human owner is only the
   stamp. No end-user identity may equal the service identity (refused at start, as a participant and as a viewer), and a
   coordinator started under anyone else, claiming an owner, matches nobody (a conflicting owner record is its own state and
   refuses everyone, the anonymous caller included). With the owner-scoped policy above, no participant, the human owner
   included, can `query` the coordinator's unfiltered log: the service's grants are `conversation.turn` and the summarizer.
   Turn executions are owned by their asker.
2. **Each turn runs as the ASKER.** The conversation execution (the owner's authority) only COORDINATES: it dequeues a turn,
   runs one effect (`conversation.turn`, granted to the owner) and records the transcript. The effect starts a SEPARATE turn
   execution with the asker's principal (ADR 0111) under a deterministic, UNGUESSABLE id `turn:<conversation>:o<ord>:<HMAC(key, conversation|ord)[:24]>`
   (start-once; a cancel of the coordinator cancels it) and waits for its output. A crashed run finds the execution and
   continues it ONLY after verifying that it is ours: the turn flow, started as THIS asker (the principal the kernel
   recorded), on this conversation, ordinal, turn, message id and text. Anything else is refused, never adopted: the turn
   fails with the fixed reason `turn-failed` and the host's `onError` gets the cause (the first cut adopted whatever lived
   at the predictable id: a forged answer, or a refusal to run). **Delegation is not dropped silently:** the turn's
   principal is rebuilt from the signed identity, which carries NO delegation token, so a sender presenting one is REFUSED
   unless the host supplies `principalFor(asker)` to map the identity to the narrowed principal (re-issuing the grant from its
   own table, ADR 0111 D4); a token is never written to the log.
   Every tool call, memory write-back, quota and capability check inside it is the asker's: a participant with fewer grants
   cannot reach a tool the owner can, and the denial is raised inside THEIR turn and recorded as `failed / denied` for them.
   The asker's principal is rebuilt from the signed identity (`principalFor` lets a host mint a delegation instead);
   `agent.writeBack` must go through an effect (`toolId`) in shared mode, never a direct write. Tested with per-asker K2 grants.
   **Memory is per asker:** when the agent has a `memory`, `shared.memoryScope(asker)` is REQUIRED, a constant
   `agent.memoryScope` or `writeBack.scope` is refused at construction, `writeBack` must go through an effect, and the scope
   is also a data class of the answer (`memory:<scope>`), so an answer that drew on someone's memory is filtered like any
   other (defence in depth for the recall, which is a recorded decision the classification cannot otherwise see).
3. **Each answer is classified by what it touched.** `classes` = the declared class of every tool the turn called
   (`shared.classOf(toolName)`; a tool it does not know is the label `unclassified`) UNION the classes of every entry that
   fed its context. The record carries them; the decision is recorded, so replay never re-asks the host. (The core has no
   per-tool class declaration, so the host supplies the map; `@loom/classify`'s `DataClass` is a handling class for fields
   and is not reused as the label vocabulary, which is open and the host's.)
4. **Per-viewer filtering.** `shared.cleared(viewer, classes)` (REQUIRED) is called with a non-empty class list and must
   clear EVERY class; fail closed, so a host returns `false` for a label it does not recognise. An entry the viewer is not
   cleared for becomes a bare `{ turn, role, status: "restricted", cursor, ..., asker }` placeholder: never its text, the
   tool names, the class labels, the turn execution id or the reason. Attribution stays (the asker is on the unrestricted
   user message beside it anyway; decided fail-closed on everything else). The asker always sees their own answer.
   A QUESTION is classified like its answer: the user record is stamped with the classes of the context the turn was
   built on (known before it runs), so a question that quotes restricted content is filtered the same way. `cleared` must
   return exactly `true` (a truthy non-boolean is NOT clearance), in the history, stream and context paths alike.
   Applied in `history`, in the SSE stream (resume included, and membership is re-checked for every delivered entry, not
   only at the periodic re-authorization), and to live deltas: **a turn's class is not known until it
   ends (it depends on the tools called), so its deltas and the `partial` catch-up go to the ASKER alone**; everyone else
   gets the durable entry (or the placeholder) on completion.
5. **Per-asker model context.** The history fed to a turn contains only the entries the ASKER is cleared for, decided in a
   recorded verdict (`conv#o<ord>:visible`); a turn is excluded WHOLE (question and answer) when its answer is restricted.
   **The rolling summary is built only from unrestricted turns** (a summary reaches every participant's prompt, so it must
   carry nothing any participant cannot see): a restricted turn that is evicted is dropped, not summarized. In shared mode
   the window is evicted by age only (`maxWindowTurns`); the token budget fits each asker's own slice, and a summary too big
   for ONE asker's slice is left out of THAT turn only (it is everyone's, so it is not dropped for all).
6. **Queued turns, no cross-user barge-in.** Turns are served FIFO from the inbox, each attributed. A participant's follow-up
   interrupts only THEIR OWN running turn (the effect's watcher accepts only a message signed for the same asker); owner-only
   mode keeps its barge-in. A participant removed while their message was queued is rejected when it is dequeued
   (`not-a-participant`, a recorded verdict). **Fairness is a cap, not a scheduler:** the global order is the inbox's FIFO
   (the kernel delivers one topic in order; a round-robin would need a topic per asker and a dynamic `select`), and each
   asker may have at most `maxQueuedPerAsker` (default 8) turns waiting, counted from the inbox past the owner's consumed
   cursor, so no participant can queue more than that ahead of the others. The count is best effort across processes (a
   small overshoot is possible).
7. **Attribution.** Every record carries the asking principal's identity; history, the stream and the placeholders expose it.
8. **Approvals stay refused.** `requireApproval` throws at construction. The future rule, so nobody has to rediscover it:
   an approval is a gate the APPROVER must be authorized for and that is bound to what they saw (ADR 0117 `viewDigest`); in a
   shared conversation the approver is a participant cleared for the call's class, the gate lives in the asker's turn
   execution (never the coordinator), and no participant can answer another's.

*Envelope integrity.* See D8: both modes accept only host-signed, conversation-bound, fresh, never-replayed envelopes. In
shared mode the sender the kernel records is the host (the client uses the system grant), so the asker is named inside the
signed envelope.

*Known limits.*
- **The kernel `messageId` is not part of the check.** The body sees the payload, not the delivered message's `messageId`
  (`ctx.receive` returns the payload only), so "the signed `messageId` equals the delivered one" cannot be enforced there. What
  closes the replay door instead is the signed `id` (which IS the `messageId` the client sends in shared mode) consumed at
  most once within the replay window, plus the conversation binding and the freshness window. The replay set is bounded (the last 1 024 ids), so an id can be evicted; what keeps an evicted envelope dead is a
  **high-water mark of evicted issue times** carried with the set (and across rotations): an envelope issued at or before the
  newest evicted one is refused as `stale`. Flooding the set (non-participant voices enter it before the membership check)
  can therefore only RAISE the floor, never reopen a captured envelope; a legitimate envelope issued before the floor and
  still queued is refused too, which is the price of the bound. The floor is also what covers the unenforced
  delivered-`messageId` equality above.
- **The `policy` argument is a self-attestation.** `createConversations({ policy })` reads the resolved scopes of the object
  you pass; nothing proves it is the object the runtime was built with, and `runtimePolicyIsOwnerScoped: true` is an
  unverified assertion by construction. The check catches the honest mistake, not a host that lies. Two properties of the
  reference policy matter to what it protects: owner scope compares **tenant and actor, not `onBehalfOf`**, and the service
  principal's actor must be **unmintable by `authenticate()`** (no end-user token may resolve to the service identity, or
  that user owns every coordinator). `annotate` is policed with the other ops; `start` is `any` by design (an asker starts
  their own turn execution), so a coordinator or participant-log id cannot be pre-empted by policy and relies on the
  verification above.
- **Key rotation.** Deploy `key: new, previousKeys: [old]` (verification accepts both, signing uses the new one), wait out
  `maxEnvelopeAgeMs`, then drop `previousKeys`. Envelopes are signed under a domain (`loom/conversation/envelope/v1`), so a
  MAC the same key made for another purpose is not an envelope. Turn execution ids are derived from `key` alone and keep their
  original input (so ids of in-flight turns did not move when envelopes gained a domain): a turn that is MID-FLIGHT when the
  key changes is started afresh under its new id, so rotate while conversations are quiet.
- **Placeholder metadata.** A restricted entry still tells a viewer that an entry EXISTS, its position (`turn`, `cursor`),
  its role, its timestamp and who asked (the asker is on the unrestricted user message beside it anyway, unless the question
  is itself restricted, in which case it is a placeholder too). It does not tell them the text, the tools, the class labels,
  the reason or the turn execution; a visible entry carries `turnExecutionId` only for its own asker. A host that must hide even the existence of an answer needs per-viewer cursors, which this
  does not offer.
- **Clock.** Freshness reads the clock once, in a recorded decision; a host with badly skewed clocks across client and
  coordinator nodes will see `stale` rejections (a 60 s forward skew is tolerated).
- **A looser policy** breaks the per-viewer filtering (D8); the construction check and the acknowledgement option are the
  guard, not a proof.
- `cleared` is called per entry per request (cached per class set within one call). Rolling summaries are one per
  conversation: a participant cleared for more than the shared summary contains gets no richer summary (their own recent
  turns carry the detail).
- Who may START a shared conversation is not decided here (any authenticated caller the gateway admits becomes an owner);
  put a policy in front of `start` if that matters.

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

All four are resolved (user decisions, 2026-10-08):

1. **`close`** is owner-only by default (a manager in shared mode): a consequence of D8, no separate rule.
2. **`requireApproval`** stays refused; the rule for a future version is written in D10.8.
3. **Queue vs interrupt** stays a *per-conversation* choice (a `bargeIn` source or none; shared mode queues across
   participants by construction). A per-message `mode` is deliberately never added: a sender must not choose whether their
   message may interrupt someone else's turn.
4. **WebSocket** is not built.

## Amendment R17b: a unique record `ord`, rejected records that are no turn, and a signed `editOf`

Found by the loom-ui U8 review. No kernel change; the recorded facts keep their decision ids (`conv#o<n>:user` /
`:reply`), so a log written before this amendment replays byte-identically under divergence "fail".

- **The bug.** `reject()` recorded `turn: seq + 1` without incrementing `seq`, so every rejected record shared its
  number with the next accepted turn (four rejected and one accepted message were all "turn 1"). A consumer had nothing
  unique to key a record on.
- **A rejected record is no turn: `turn: 0`.** The fail-safe choice: the field stays a number (no consumer's types
  or `recordOf` validation break), `0` can never equal an accepted turn (1-based), and `status().turns` now reads the
  newest accepted record's number instead of the newest record's (which for a trailing rejection was off by one). Old
  rejected records keep the number they were written with.
- **`ord`.** Every `MessageRecord` carries `ord`: 1-based, unique per conversation, monotonic, from a counter (`rec`)
  that is part of the carry, so it survives rotation exactly like `seq` and `ord` (the message counter, which numbers
  the decision ids and is NOT unique per record: a turn's user message and its reply share it). The counter ticks on
  every record call whether the fact is new or served from the log, and the body is deterministic, so a replay counts
  the same. A restricted placeholder keeps `ord` (an ordinal is not content) and never `editOf`. **Compat:** records written
  before this amendment have no `ord` (the reader omits it; it is not derived); uniqueness holds among records that
  carry one. `dropped` / `closed` facts are not transcript records and carry none.
- **`editOf`.** A `user` envelope may carry `editOf`, a positive integer: the `ord` of an earlier user record. It is part
  of the signed body (the domain-separated signature is unchanged), so adding or changing it after signing is
  `unauthenticated`; a signed non-integer is `malformed`. The body validates it from its own replayed state, with no
  new decision: the referenced record must be an ACCEPTED USER turn (only those are in the carried window, so an
  assistant record, a rejected record and an unknown ord are all absent) and, in shared mode, the ASKER's own
  (`sameIdentity`, i.e. `principalIdentityKey`); owner mode admits only the owner's voice, so every turn is theirs. Any
  failure is one rejected record with the fixed reason `edit-invalid` (it does not say which case, echoes no
  reference, and sends nothing to the model). Limit: the turn must still be in the carried window
  (`maxWindowTurns`, plus the one pending eviction); an older one is refused (fail closed) rather than looked up in the
  log.
- **Semantics.** An edit is still a NEW turn (append-only): the record shows what the user typed, with `editOf` set. The
  model prompt gets the marker as data inside the same tainted, fenced user text:
  `[This message edits the user's earlier message "<quote, 500 chars>".]`. The quote is the same asker's own earlier
  words, so no other participant's content can be pulled in by it. The turn effect (shared mode) receives that same text.
- **Fix round 1.** (a) The edited turn's classes are unioned into the new user record's classes (and so the reply's
  `classes` decision): the quote enters the prompt even when the budget evicted that turn from the visible window, so
  its classification must follow it. (b) A record with `editOf` also carries `editOfTurn` (the edited turn's number,
  display only); `editOf` (the ord) stays canonical. (c) `status().turns` pages backward (at most 50 pages of 100
  records) until a record with `turn > 0` is found, so a long run of rejections cannot zero it. (d) Tested: an edit of a
  turn carried across `continueAsNew`.
- **Wire.** `Conversations.sendTurn(id, text, { editOf })`; `POST /turns { text, messageId?, editOf? }` (a non-integer
  is a 400); history entries and SSE `message` frames carry `ord` and (for an edit) `editOf`.

## Verification

See the PR for the per-suite counts. Fix round 1 added `hardening.test.ts`, `shared.test.ts` (package), `edge.test.ts`,
`shared.test.ts` (plugin) and `compactionTaint.test.ts` (agent). Each key guard was reverted and the test that pins it failed: the retry-vs-barge-in key
(twice), the turn-signal merge, the carry trim, the budget eviction, the prompt taint, the subscription release, the
authorization-before-limit order, the Origin check, the denial mapping and the revocation re-check.
