# @loom/conversation — a durable dialogue as one chained execution

A chat is not a request; it is a long-lived thing that is answered turn by turn, interrupted, resumed after a restart and rotated so it never grows without bound. `@loom/conversation` assembles that from parts the kernel already has — the inbox (ADR 0110), `agentLoop$` (ADR 0121) and `continueAsNew` (ADR 0109) — and adds nothing to the kernel (ADR 0122).

```ts
import { agent$ } from "@loom/core";
import { createAgentModelEffect } from "@loom/agent";
import {
  ConversationHub, conversation$, createConversations, inboxBargeIn,
} from "@loom/conversation";

const hub = new ConversationHub();
effects.register("model", createAgentModelEffect(hub.wrapProvider(provider), {
  stream: true,
  onDelta: hub.deltaSink(),          // live tokens, attributed to the conversation turn running the call
}));

const chat = conversation$({
  key: process.env.CONVERSATION_KEY!,   // signs every inbox envelope: the body acts only on what the host's client signed
  agent: { definition: agent$({ id: "assistant", name: "Assistant", tools: [] }), modelToolId: "model" },
  budget: { contextWindow: 200_000, summarizerToolId: "summarize" },   // token-aware; evicted turns are summarized
  bargeIn: inboxBargeIn(eventStore),                                   // a new message interrupts the running turn
  hub,
});
runtime.registerFlow(chat.definition, chat.runner);   // runtime needs kernel.features.inbox + continueAsNew

const conversations = createConversations({ runtime, eventStore, flow: chat, policy });   // policy: the owner-scoped executionAccessPolicy the runtime uses
const { conversationId } = await conversations.start({ principal });
await conversations.sendTurn(conversationId, "Plan my trip", { principal });   // a retry with the same messageId is delivered once
await conversations.sendTurn(conversationId, "Actually, make it two days", { principal });  // barges in
const page = await conversations.history(conversationId, { principal, direction: "backward", limit: 20 });
```

## Writing a summarizer (`budget.summarizerToolId`)

The effect receives `{ messages: { role, content }[] }` and returns `{ summary: string }`. Like `agentLoop$` `compaction.toolId` (whose input also carries wrappers: failed tool calls, MCP results and origin-bearing history are tainted, in text parts and `tool_result` content), the user's words (and the previous summary) arrive with `content` as a **tainted wrapper** `{ __loomTainted: { origin }, value }` - untrusted data, neither a string nor parts; assistant replies are plain strings. `textOf(m.content)` on a wrapper throws `TaintedContentError` (it used to be an obscure `TypeError` that failed the step and killed the conversation at its first rotation). Read messages with `summarizerText`, which unwraps every level (top level, text parts, `tool_result` content) and so serves both effects:

```ts
import { summarizerText } from "@loom/conversation";
const transcript = input.messages.map((m) => `${m.role}: ${summarizerText(m.content)}`).join("\n");
```

The text is **untrusted data**: summarize or quote it, never put it in a system prompt or assistant message (if the summarizer calls an LLM with this text, re-wrap it with `tainted(text, origin)` and put it in a user message, never the system prompt: `guardRequest` can no longer refuse it after unwrapping). The returned summary is clipped to `maxSummaryTokens` and re-injected as a fenced `user` message with origin `conversation:summary`, never the system prompt.

## What it is

- **One chained execution per conversation.** The id is the chain id. Idle, it is parked on the inbox; a user turn wakes it. Every `rotateEveryTurns` (default 100) it `continueAsNew`s, carrying the rolling summary and a bounded window, so any one generation's fold and log stay small. The inbox cursors and dedupe window cross the rotation (kernel).
- **Barge-in without killing the execution.** The turn runs with an `AbortSignal`; `inboxBargeIn` fires it when a message lands. `agentLoop$` reads it only through *recorded* checkpoints, so the interruption is replayed identically after a restart. The partial reply is kept (`status: "interrupted"`) and is part of the context of the next turn. Without a `bargeIn` source the conversation queues instead.
- **A transcript with no second store.** Every message is a decision (`source: "conversation-record"`) recorded exactly once; `history` / `followConversation` read them back with bounded `readRange` reads across all generations. Cursors are `<generation>.<sequence>`. Every record carries a unique, increasing `ord` (kept across rotations; absent on records written before R17b); a rejected message is no turn (`turn: 0`) so it never shares a number with the next accepted turn.
- **Editing an earlier turn.** `sendTurn(id, text, { editOf: <ord of your earlier user turn> })`. `editOf` is signed inside the host envelope and validated by the conversation: it must be an accepted user turn of the same asker still in the prompt window, else the message is recorded as rejected (`edit-invalid`) and not obeyed. An edit is still a NEW turn (append-only) that records `editOf` (and `editOfTurn`, the edited turn's number, for display); the model is told, inside the fenced user text, which earlier message it replaces.
- **Token budgeting.** `fitToWindow` keeps the newest turns that fit beside the system prompt, the summary and the new message, with a pluggable `TokenCounter` (a conservative heuristic by default, a provider's exact counter if you have one). The verdict is a recorded decision, so a replay never re-decides it, and a prompt that cannot fit even alone is rejected without a model call. `agent.compaction` keeps bounding the transcript *inside* a run; the two compose.
- **Trust.** A turn runs as the conversation owner, and **only the owner may talk to it**: the identity that started it (tenant, actor and `onBehalfOf` all equal) may send, close, read and stream; anyone else, a same-tenant colleague included, gets the same not-found as for a conversation that does not exist. A user's words are untrusted data: tainted `conversation:user`, fenced at the prompt boundary, never in the system prompt. A failed turn records a fixed reason and an `errorId`; the real error goes to `onError`.
- **Shared mode** (`conversation$({ shared })`, ADR 0122 D10) for a chat several people use: an explicit participant set (not a tenant), each turn run as its **asker** in its own execution (their grants, their quotas), each answer classified by the tools it touched and filtered per viewer (a bare placeholder for whoever is not cleared, in history, on the stream and in the model's context), a summary built only from unrestricted turns, FIFO queueing, and a participant may interrupt only their own turn.

## Signing an inbox envelope yourself (`signInboxEnvelope`)

`sendTurn` builds and signs the envelope for you. A test, or a trusted server-side bridge that writes to the inbox itself, can sign one with the conversation's key:

```ts
import { CONVERSATION_TOPIC, signInboxEnvelope } from "@loom/conversation";

await runtime.send(conversationId, {
  topic: CONVERSATION_TOPIC,
  payload: signInboxEnvelope(process.env.CONVERSATION_KEY!, {
    conversationId, kind: "user", text: "hello", id: crypto.randomUUID(), iat: Date.now(),
    asker: { actor: "alice", tenant: "t1" },
  }),
});
```

- It needs the conversation's envelope key (`key`). **The key is the authority of a trusted bridge**: keep it server-side, never in a browser, and rotate it with `previousKeys`. The body is validated up front with the conversation's own shape rules; a malformed body (including a `user` envelope with blank `text`) throws `InvalidEnvelopeError` instead of being signed. `maxTurnChars` is a check the conversation applies to the body, not one the signer can make (it does not know the flow's limit).
- A key holder CAN: speak as ANY participant in shared mode (the body checks only that the named `asker` is a participant); edit that asker's earlier turns (`editOf` is checked against the signed `asker`, so it is only as strong as that); bypass the client-only checks (the per-asker `maxQueuedPerAsker` cap, and "a delegated sender needs `principalFor`"); write to every conversation the runtime's `send` policy admits (the key is per flow, not per tenant, so that policy alone decides which conversations a bridge can reach); and, in owner mode, nothing beyond what the runtime access policy lets it `send` (the `asker` = owner comparison is a consistency check, not authentication).
- A key holder can NOT: sign for another conversation, replay an `id`, use an `iat` at or before the staleness floor or outside the age window, speak as anyone but the owner in owner mode, name a non-participant in shared mode, close a shared conversation unless the named closer is the owner, the service principal or a `manageParticipants` manager, send a turn over `maxTurnChars` (the body rejects it), or send a malformed envelope.
- A future `iat` up to +60 s is accepted. Once that id is evicted from the replay set the staleness floor moves forward, so a key holder can make legitimate envelopes issued in the following ~60 s `stale`.
- Use it in tests and trusted bridges. Applications call `sendTurn`.

## Read these before relying on it

- **The runtime policy must be owner-scoped** for `query`, `send`, `cancel` and `resume` (`executionAccessPolicy({ rules: { query: "owner", send: "owner", cancel: "owner", resume: "owner" } })`): the conversation's log holds the unfiltered transcript. `createConversations` refuses anything looser unless you acknowledge it. Every inbox message is also a host-signed, conversation-bound, single-use, fresh envelope, so what the policy lets through is still not obeyed unless the host signed it.

- A registered `ctx.receive` is **not** woken while a step is in flight (ADR 0110): barge-in cannot be built from the inbox primitives, which is why the signal comes from a store subscription outside the flow body (ADR 0122 D2).
- A tool call already in flight when a barge-in lands completes; the loop stops before issuing the next call. Wrap the provider with `hub.wrapProvider` to cut the *generation* itself.
- `needsApproval` (and its deprecated alias `requireApproval`) is refused (a parked approval gate and the barge-in model do not compose).
- Live deltas are transient and per-process. Only the durable messages are resumable.

## Security: the raw inbox path

Anything holding the host's system grant can bypass the client API and write straight into a conversation's inbox:

```ts
runtime.send(conversationId, { topic: CONVERSATION_TOPIC, payload }, runtime.systemOptions());
```

`conversations.send` is the intended door; this raw path skips it. What still defends the conversation is the envelope check in the body, not the caller's good manners: the payload must be a host-signed, conversation-bound, single-use envelope (a forged or unsigned one is dropped), it must be above the replay floor (an old or replayed envelope is dropped), and in shared mode its author must pass the participant check. **A host must never expose this path** to users, to a route handler that forwards a client-supplied `executionId` or payload, or to a plugin it does not trust, and must keep `CONVERSATION_KEY` out of anything that can send. Expose conversations only through `createConversations` (or `@loom/plugin-conversation-sse`, which does) ([ADR 0122](../../docs/adr/0122-conversation-layer-streaming-transport-and-token-budgeting.md) D10).

See [ADR 0122](../../docs/adr/0122-conversation-layer-streaming-transport-and-token-budgeting.md) and, for the browser, [`@loom/plugin-conversation-sse`](../../plugins/conversation-sse/README.md).
