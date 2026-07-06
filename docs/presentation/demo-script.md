# Loom — Live Demo Runbook

A presenter's runbook. Each demo lists the **command**, **what to show**, and **talking points**.
Everything runs **offline** — the examples use mock/scripted LLM providers, so **no API key is required**.

---

## Prerequisites (once)

```bash
# Node ≥ 20, pnpm ≥ 9
pnpm install
pnpm build            # first run only; builds all packages
```

Optional sanity check before you present:

```bash
pnpm test             # all packages green (~180 tests)
```

**Golden rule:** use `vite dev` for the browser apps (the commands below do). Avoid `vite build` — it hits a
known, pre‑existing Rollup CJS interop error unrelated to the framework.

---

## Demo 0 — The whole pipeline, headless (2 min) ⭐ best opener

```bash
pnpm --filter @loom/agent-network start
```

**What to show** — it prints 8 labeled sections and exits:

1. **Configurable LLM** — provider ready (swap `ScriptedLlmProvider` → `AnthropicProvider` to go live)
2. **Agent ReAct loop** — the agent calls a tool, then answers
3. **MCP tool discovery** — `Discovered 1 MCP tool(s): kb-lookup`
4. **A2A server + client** — serves an agent card, submits a task, gets `completed`
5. **Capability + Intent** — `Routed to capability: investigate-incident (keyword match)`
6. **Planner** — an ordered 2‑step plan
7. **Agent memory** — `Second-turn answer (with recall): Your cluster is prod-postgres`
8. **Terminal surface** — the incident dashboard rendered as ASCII

**Talking points**
- "This is every agentic runtime — LLM, agent, MCP, A2A, intent, planner, memory, multi‑surface — end to end, offline, in one script."
- "It's deterministic because the provider is scripted; in production you change one line to a real model."

---

## Demo 1 — Cloud Command Center: durable + human‑in‑the‑loop + streaming UI (5 min) ⭐ centerpiece

```bash
pnpm --filter @loom/cloud-command-center dev
```

Open the printed URL (default `http://localhost:5173/`, auto‑increments if busy).

**What to show**
1. The intent box is pre‑filled: *"investigate high CPU on the postgres cluster"*. Click **Run Intent**.
   - Event Log shows `Intent "…" → capability investigate-incident` — **Intent Over Routes**.
2. Watch the **Workflow Phase** badge move: investigating → triaging → awaiting‑approval. These are **A2UI patches** from the flow.
3. Watch **AI Root‑Cause Analysis** stream in **token by token** — the LLM effect pushing A2UI patches into the `ui` surface.
4. The workflow **suspends** at the approval step. Click **Approve Remediation**.
5. It **resumes** → phase `resolved`. The metrics/logs steps are **not** re‑run.

**Talking points**
- "The flow function suspended waiting for a human — it could wait for days, survive a restart, and resume exactly here."
- "The AI analysis streamed into the UI as durable patches — refresh the page and the state rebuilds from the event log."
- "Nothing here re‑ran the earlier steps on resume. That's continuation, not hydration."

---

## Demo 2 — Playground: see the machinery (4 min)

```bash
pnpm --filter @loom/playground dev
```

**What to show**
1. Type a goal, click **➤ Run Intent** (or **▶ Run Flow** for the direct path).
2. **A2UI tab** — live `ui` surface (left) next to the **raw patch stream** (right): `set` / `merge` / `append` / `increment` scrolling as the flow runs.
3. **Trace tab** — Gantt‑style per‑step timing (from `@loom/telemetry`).
4. **Event Log tab** — the append‑only event stream that *is* the application state.
5. Click **✓ Approve** to resume.

**Talking points**
- "The A2UI tab is the protocol laid bare — every UI change is a typed, ordered, replayable patch event."
- "The Trace and Event tabs are free observability: the event log gives you audit + timing with zero instrumentation."

---

## Demo 3 — Framework‑agnostic (2 min, optional)

```bash
pnpm --filter @loom/angular-command-center dev
```

**What to show** — the *same* incident workflow, rendered by **Angular** (`@Injectable` service + signals) instead of React.

**Talking points**
- "Same `WorkflowRuntime`, same flow, same blueprint — only the renderer changed. The runtime has zero UI‑framework imports."

> Run this on a **different port** than Demo 1/2 (Vite auto‑increments, or pass `-- --port 5175`).

---

## Demo 4 — Durability, proven by test (2 min, optional)

```bash
pnpm --filter @loom/cloud-command-center exec vitest run test/e2e/suspend-resume.test.ts
```

**What to show** — the test suspends in one runtime, **closes the event store** (simulating a restart), then resumes in a **new** runtime and asserts the metrics/logs effects were called **0 times**.

**Talking points**
- "This is the thesis as an assertion: resume in a fresh process, re‑run nothing, still finish."

---

## Demo 5 — Git‑style branching: fork → simulate → promote (3 min) ⭐ the "wow"

```bash
pnpm --filter @loom/incident-war-room demo:fork      # headless, narrated (best for a talk)
# …or the live UI:
pnpm --filter @loom/incident-war-room dev            # run the replica goal → "Explore branches" → "Promote"
```

**What to show** — a replica‑lag remediation runs to its approval gate and **suspends** at sequence 1. Instead of a blind approve/reject, it **forks** the suspended execution into three *mutually‑exclusive* candidate strategies (scale replicas / fail over / throttle), **simulates** each (concurrently) to preview projected lag/ETA/downtime/cost, shows the **parent still suspended and untouched**, then **promotes** the winner — which applies for real. In the UI: the **War Room** tab's branch graph + side‑by‑side diff fill in live, then **Promote**.

**Talking points**
- "Every other demo moved execution *forward*. This one branches it *sideways* — explore several futures, commit one."
- "Fork is copy‑on‑write over the event log: the parent's prefix is copied verbatim, so the branch re‑derives byte‑identical pre‑fork state and the parent never moves."
- "`parallelLimit` runs the speculative branches concurrently but returns them in input order — deterministic for replay."
- "There's deliberately **no merge**: two divergent executions have no principled join, so `promote()` is a pointer move and the losers stay as immutable lineage — your audit trail of alternatives considered."

**Second domain (optional, +1 min)** — to prove the seam is *domain‑agnostic*, run the same branching on a schema migration. The `BranchOrchestrator` and branch UI are reused verbatim; only the domain changes. It also streams **live per‑branch backfill progress** — three shadow‑migrations advancing at once.

```bash
pnpm --filter @loom/schema-migration-planner demo:fork   # add a NOT NULL column to a 40M‑row table: online‑DDL vs shadow‑copy vs dual‑write
```

---

## Suggested timings

| Slot | Sequence |
|------|----------|
| **5 min** | Demo 0 → Demo 1 |
| **15 min** | Demo 0 → Demo 1 → Demo 2 |
| **30 min** | Engineering deck (skim) → Demos 0–2 → Demo 4 → Demo 5 → 2–3 walkthrough excerpts |

---

## Fallbacks & gotchas

- **Port already in use?** Vite auto‑increments (5173 → 5174 …). To force one: append `-- --port 5175 --strictPort`.
- **Stop a dev server / free a port:**
  ```bash
  lsof -tiTCP:5173 -sTCP:LISTEN | xargs kill -9    # repeat per port
  ```
- **"does not provide an export" in a browser demo** — a `@loom/*` package isn't in that app's Vite `optimizeDeps.include`. It's a Vite pre‑bundle config, not a code bug (all current examples are configured correctly).
- **Go live with a real model** — in `examples/cloud-command-center/src/runtime/aiTriage.ts` (and `agent-network/src/main.ts`), replace `new MockLlmProvider()` / `new ScriptedLlmProvider(...)` with:
  ```ts
  import { AnthropicProvider } from "@loom/llm";
  const provider = new AnthropicProvider({ model: "claude-opus-4-8" }); // reads ANTHROPIC_API_KEY
  ```
  Nothing else changes.
- **No network needed** — all four demos run fully offline.

---

## One‑paragraph script (if you have 60 seconds)

> "Loom makes AI workflows behave like durable processes. Watch: I type a goal, it routes to a capability and starts a workflow; the AI streams its analysis straight into the UI; the workflow suspends for my approval — it could wait for days and survive a restart — I approve, and it resumes without re‑running a thing. Same runtime renders to React, Angular, or a terminal. That's the whole idea: continuation, not hydration."
