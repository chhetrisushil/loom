# @loom/plugin-a2a — talk to other agents over the A2A protocol

Both directions of Google's Agent-to-Agent protocol. Outbound, `A2APeerClient` discovers a remote
agent's card and registers it as a Loom tool that agents, steps and the planner can call. Inbound,
`createA2AServer` exposes one Loom flow as an A2A agent over `node:http`. Use it to mesh Loom agents
with each other or with agents built on other frameworks. A peer agent is only as trustworthy as
whoever operates it, so read the notes on taint and descriptions below.

```ts
import { EffectRuntime } from "@loom/effect-runtime";
import { A2APeerClient, createA2AServer } from "@loom/plugin-a2a";
import type { RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";

declare const runtime: WorkflowRuntime;
declare const triageFlow: RegisteredFlow;

// Outbound: a remote agent becomes a tool. `taintResults` marks its text as untrusted.
const effects = new EffectRuntime();
const peer = new A2APeerClient({
  url: "https://peer.example.com",
  headers: { authorization: `Bearer ${process.env.PEER_TOKEN}` },
  taintResults: true,
});
const peerTool = await peer.registerInto(effects); // fetches /.well-known/agent.json
// Call it with { prompt, context? }; the result is { content, raw }.

// Inbound: serve a flow. The server refuses to start with no authentication.
const server = createA2AServer(
  runtime,
  triageFlow,
  { name: "triage", description: "Triage tickets", version: "1.0.0", capabilities: {}, skills: [] },
  {
    port: 3001,
    authenticate: (req) =>
      req.headers.authorization === `Bearer ${process.env.A2A_TOKEN}` ? { actor: "partner-a" } : undefined,
  }
);
await server.start();
```

## Surface

- **Client.** `A2APeerClient` (`discover`, `map`, `registerInto`), `fetchAgentCard`, and
  `createA2AClientEffect(url, { headers, timeoutMs, pollIntervalMs })`. A task answered as finished in
  the `/tasks/send` reply is returned as is; otherwise the client polls `/tasks/:id` (default 500 ms,
  60 s timeout).
- **Server.** `createA2AServer(runtime, flow, card, options)` serves `/.well-known/agent.json`,
  `POST /tasks/send` and `GET /tasks/:id`. `LoomAgentExecutor` is the underlying submit and get logic.
- **Cards.** `toAgentCard(agent, options?)` derives a card from an `agent$` definition. It is also
  available from the browser-safe subpath `@loom/plugin-a2a/cards`, which pulls in no `node:http`.

## Behaviour that surprises people

- **`taintResults` marks the peer's text, not its task state.** `content`, `raw.artifacts` and `raw.error`
  become tainted values the prompt boundary refuses in instruction positions, so `unwrapTainted()` them to
  compute with. `raw.id` and `raw.status` stay plain for control flow. If you put those into a prompt, nothing marks them
  ([docs/data-classification.md](../../docs/data-classification.md)). It is off by default.
- **A peer's description is withheld from the model.** An agent loop shows a neutral placeholder for the
  peer unless you set `trustDescriptions: true`, because the card is written by the peer's operator.
  Set it only for a peer you operate or trust; its card text then reaches the model as instructions
  (ADR 0125 D14).
- **The server is closed by default.** It listens on `127.0.0.1`, throws at creation with neither
  `authenticate` nor `authorize` unless you pass `insecure: true`, and under `security.strict` it
  requires `authenticate` or `resolvePrincipal`. The principal needs a non-empty string `actor`, which
  scopes task ownership. `authorize` alone gives every caller one shared task namespace.
- **Set `publicUrl` behind a proxy.** Otherwise the card advertises the bind address.
- **A task id becomes the execution id.** It must be non-empty, at most 200 characters, and not start
  with `__loom_`. The client derives its ids from the execution and step, so replays are stable.

## Status / See also

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override
(see [AGENTS.md](../../AGENTS.md)).

- [ADR 0125](../../docs/adr/0125-tool-search.md) (D14): card text and `trustDescriptions`;
  [ADR 0085](../../docs/adr/0085-untrusted-content-integrity-axis.md): the taint model.
- API reference: section "`@loom/plugin-a2a` — Agent-to-Agent" in
  [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [docs/data-classification.md](../../docs/data-classification.md),
  [docs/user-guide.md](../../docs/user-guide.md), and the `a2a-mesh` and `agent-network` examples in
  `loom-examples`.
