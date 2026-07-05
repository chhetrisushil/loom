# A2A Mesh — using ADK / LangGraph / CrewAI with Loom

Loom interoperates with external agent frameworks over the open **A2A protocol**,
as **bidirectional peers**: Loom can call an external agent, and an external
framework can call a Loom agent. Neither side imports the other — they exchange
tasks over three HTTP routes:

```
GET  /.well-known/agent.json   # discovery — the AgentCard
POST /tasks/send               # submit a task, get { id }
GET  /tasks/:id                # poll for the result
```

Because A2A is the contract, the same Loom code works against **Google ADK**
(which speaks A2A natively), **LangGraph**, **CrewAI**, or another Loom service.

## Run the demo

```bash
pnpm --filter @loom/a2a-mesh start
```

It runs fully offline against a mock external agent (`src/mockExternalAgent.ts`,
standing in for ADK/LangGraph) and shows both directions:

- **Outbound** — `A2APeerClient` discovers the remote agent's card and registers
  it as a Loom tool; a Loom `agent$` then calls it mid-reasoning.
- **Inbound** — `createA2AServer` exposes a Loom flow over A2A; a client effect
  drives it (standing in for an external framework calling Loom).

## The reusable recipe

**Call an external agent from Loom** (outbound):

```ts
import { A2APeerClient } from "@loom/a2a";

const peer = new A2APeerClient({ url: "http://localhost:9999" }); // remote A2A agent
const tool = await peer.registerInto(effectRuntime, registry);    // now a Loom tool

const myAgent = agent$({ id: "orchestrator", name: "Orchestrator", tools: [tool] });
// myAgent can now call the external agent by tool id, mid-ReAct-loop.
```

**Expose a Loom agent to the outside world** (inbound):

```ts
import { createA2AServer, toAgentCard } from "@loom/a2a";

const server = createA2AServer(workflowRuntime, myFlow, toAgentCard(myAgent), { port: 8080 });
await server.start(); // ADK/LangGraph/etc. can now discover and call it
```

## Pointing at a real framework

The Loom side never changes — only the URL you hand `A2APeerClient` (and the
server your external agent points at).

### Google ADK (native A2A)

```python
from google.adk.a2a import to_a2a
a2a_app = to_a2a(root_agent)   # serve with uvicorn; exposes the 3 A2A routes
```

Then on the Loom side: `new A2APeerClient({ url: "http://localhost:8001" })`.
For the reverse direction, ADK consumes Loom's `createA2AServer` endpoint as a
remote A2A agent — no shim needed.

### LangGraph / CrewAI (A2A via a thin wrapper)

These don't emit A2A themselves. Wrap the compiled graph/crew in a small A2A
HTTP server (implement the three routes, or use the Python `a2a` SDK) whose
`/tasks/send` calls `graph.invoke(...)` and returns the result as an artifact.
Point `A2APeerClient` at that server — identical Loom-side code.

### Model-only alternative

If you only want ADK/LangChain for their **LLM** (not the agent loop), skip A2A
and implement Loom's `LlmProvider` (`packages/llm/src/types.ts`) instead, then
pass it to `agentStep$` / `AgentRunner`. Cheaper when you just need model access.
