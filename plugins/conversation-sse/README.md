# @loomwork/plugin-conversation-sse — the end-user gateway for `@loomwork/conversation`

An authenticated HTTP + Server-Sent-Events edge: a browser (or any client) starts a conversation, sends turns, and watches the durable messages and the live reply tokens arrive, resuming after a drop from where it left off.

```ts
import { createConversationSseServer } from "@loomwork/plugin-conversation-sse";

const server = createConversationSseServer({
  conversations, hub, eventStore,
  authenticate: (req) => verifyBearer(req.headers.authorization),   // -> { actor, tenant? } | undefined
  allowedOrigins: ["https://app.example.com"],
});
await server.start();   // 127.0.0.1 by default
```

```
POST /conversations                  -> 201 { conversationId }       (the server mints the id)
POST /conversations/:id/turns        { text, messageId?, editOf? } -> 202  (a barge-in if a turn is running; editOf = ord of your earlier turn)
POST /conversations/:id/close
GET  /conversations/:id              -> status
GET  /conversations/:id/history      ?limit&cursor&direction=forward|backward  (default forward)
GET  /conversations/:id/events       text/event-stream; Last-Event-ID or ?cursor resumes
GET  /conversations/:id/reasoning    ?cursor=<the reply's history cursor>  a reply's durable model reasoning (opt-in, see below)
```

**History direction.** `direction` defaults to `forward`: oldest first, starting at the beginning of the log (or after `cursor`), and `done` is true at the live tip. To load the newest messages first (the usual chat opening), request `?direction=backward&limit=N`: you get the latest N, newest first, and `nextCursor` continues toward older ones (`done` is true at the start). A cursor continues in the direction that produced it; any other value of `direction` is a `400`. A client that renders the page must order it to match (for example loom-ui `ChatFeed.applyHistory` takes a matching direction argument).

SSE events: `status` (first), `partial` (the reply in progress), `message` (durable; its SSE `id` is the history cursor), `delta` / `reset` (live), `closed`, `reconnect`, `error`; with `reasoning` on, also `reasoning` and `reasoning-partial`. Render user text as **text**: it is untrusted.

**Reasoning (opt-in).** `reasoning` is off by default. `reasoning: true` (or `{ live: true }`) streams the `reasoning` / `reasoning-partial` SSE events; `reasoning: { store }` also serves a reply's durable reasoning at `GET /conversations/:id/reasoning?cursor=` from the `ReasoningStore` the model effect captured into. Only the turn's asker and the conversation's owner receive it (in a shared conversation never another participant); anyone else gets the same `404` as a missing conversation. It is model-derived text, so render it as **text** too. See [ADR 0133 D6](../../docs/adr/0133-model-reasoning-audit-capture.md).

## Security model

- Authentication is required to *create* the server (`insecure: true` is the explicit, warned opt-out; refused when the runtime is strict, which is the default derived from it). Loopback by default; an insecure server also answers only loopback `Host` names. A runtime with no fail-closed execution authorizer is refused unless `allowNoRuntimeAuthz`.
- Authorization is `@loomwork/conversation`'s, per conversation: OWNER-ONLY by default, or the participant set of a shared conversation (which also gets per-viewer filtering of history, the stream and live deltas, and `/participants` routes). A conversation the caller may not touch and one that does not exist are the same `404`, on every route, and authorization runs before any limit.
- A stream is keyed by one conversation; a cursor is a position inside that conversation's own log.
- `Origin` must be listed in `allowedOrigins` (`Host` never proves same-origin); CORS headers ride errors too; JSON-only bodies; `nosniff`; POSTs are rate-limited per principal; request/header timeouts are set.
- Limits: connections (total and per principal), subscribers per conversation, body size, stream lifetime, and per-connection pending bytes (a slow client's deltas are coalesced, then the client is closed and resumes from the log). Open streams re-authenticate every `reauthMs`.

See [ADR 0122 D6](../../docs/adr/0122-conversation-layer-streaming-transport-and-token-budgeting.md).
