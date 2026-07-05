# Loom — Adoption Presentation Kit

Everything you need to present Loom to **engineers** and **leadership** and drive a live demo.

**Loom is a framework for building durable, event‑sourced, agentic applications** — workflows that
suspend for humans and survive restarts, agents with tools and memory, and interfaces that agents
generate and drive live. The core thesis: *intelligence behaves like a process, not a request —
optimize for continuation, not hydration.*

---

## What's in here

| File | Audience | Use it for |
|------|----------|------------|
| [`leadership-deck.md`](./leadership-deck.md) | Leadership / execs | The why: platform shift, problems, value, competitive positioning, adoption path |
| [`engineering-deck.md`](./engineering-deck.md) | Engineers / architects | The how: architecture, primitives, execution model, agentic + intelligence pipeline |
| [`code-walkthrough.md`](./code-walkthrough.md) | Engineers | Annotated tour of real files (read‑along) |
| [`demo-script.md`](./demo-script.md) | Presenter | Live runbook — exact commands, what to show, talking points, timings |
| [`db-command-center-deck.md`](./db-command-center-deck.md) | Engineers / architects | Deep dive on the **agentic DB command center** (React) — intent → planner → A2A → durable human‑in‑the‑loop, BYOR + BYOC + render‑side fiber |
| [`db-command-center-wc-deck.md`](./db-command-center-wc-deck.md) | Engineers / architects | The **same app in vanilla Web Components** — proof of BYOR: reuse the whole agentic backend, swap only the render layer |
| [`db-command-center-server-deck.md`](./db-command-center-server-deck.md) | Engineers / architects | The **same app as server + client** — durable runtime on a Node server (SQLite), Web-Components client over HTTP + SSE; Loom's isomorphic deployment model |

Suggested order: **leadership deck → live demo (Demo 0 + 1) → engineering deck → walkthrough** as
depth requires. The demo script has 5 / 15 / 30‑minute variants.

---

## Rendering the decks (Marp)

The decks are [Marp](https://marp.app/) Markdown. No install needed — use `npx`:

```bash
# Live preview with hot reload (opens a browser; great for presenting)
npx @marp-team/marp-cli@latest -s docs/presentation/

# Export a single deck
npx @marp-team/marp-cli@latest docs/presentation/leadership-deck.md  -o leadership.html
npx @marp-team/marp-cli@latest docs/presentation/engineering-deck.md -o engineering.pdf  --pdf
npx @marp-team/marp-cli@latest docs/presentation/leadership-deck.md  -o leadership.pptx --pptx
```

Or install the **Marp for VS Code** extension and open a deck for WYSIWYG preview + export.
Presenter notes are in `<!-- ... -->` comments (shown in Marp presenter view, hidden on slides).

---

## Running the demos

Full runbook: [`demo-script.md`](./demo-script.md). Quick start — **no API key needed** (offline):

```bash
pnpm install && pnpm build        # once

pnpm --filter @loom/agent-network start          # Demo 0: whole pipeline, headless (best opener)
pnpm --filter @loom/cloud-command-center dev      # Demo 1: durable + streaming UI + approval (React)
pnpm --filter @loom/playground dev                # Demo 2: A2UI patch stream + Trace tab
pnpm --filter @loom/angular-command-center dev    # Demo 3: same runtime, Angular UI (optional)
pnpm --filter @loom/db-command-center dev         # Demo 4: agentic DB command center — planner + A2A + HITL + fiber (React)
pnpm --filter @loom/db-command-center-wc dev      # Demo 5: the same app in vanilla Web Components (no framework)
pnpm --filter @loom/db-command-center-server dev  # Demo 6: the same app as server + client (durable Node server + WC client over SSE)
```

**Prerequisites:** Node ≥ 20, pnpm ≥ 9. Use `vite dev` (not `vite build`) for the browser apps.

---

## The 30‑second pitch

> Loom makes AI workflows behave like **durable processes**. A user expresses a goal; Loom routes it to a
> **capability** and starts a **workflow**; agents call **tools** (local or via MCP) and can delegate to
> other agents (**A2A**); the workflow **suspends** for human approval — surviving restarts — and
> **resumes** without re‑running completed work; and agents **generate and drive the UI** live via durable
> patches (**A2UI**), rendering to web, Angular, or a terminal. State is an **append‑only event log**, so
> durability, auditability, and cost‑efficiency are the same mechanism.

---

## Deeper references (in `docs/`)

- [`../architecture.org`](../architecture.org) — system design, event sourcing, replay, package graph
- [`../api-reference.org`](../api-reference.org) — full API for every package
- [`../usage-framework.org`](../usage-framework.org) — step‑by‑step build guide
- [`../usage-compiler.org`](../usage-compiler.org) — the `@loom/compiler` Vite plugin
- [`../../README.org`](../../README.org) — repo overview & package list
