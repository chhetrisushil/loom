# Examples catalogue

The runnable example apps live in the sibling **`loom-examples`** repo
(`git@github.com:chhetrisushil/loom-examples.git`) — extracted from this repo to
keep the framework packages front-and-centre. This page is the index: what each
example teaches and the APIs/ADRs it exercises, so you can pick the right
reference (or point an agent at it) without cloning first.

## How the examples consume loom

Loom is unpublished. Each example resolves this repo's `@loom/*` packages from a
sibling `../loom` checkout via `link:` (declared centrally as pnpm `overrides` in
`loom-examples/package.json`), not `workspace:*`. Lay the two repos out as
siblings, install/build `loom`, then `pnpm install` in `loom-examples`. The full
rationale — and why git/npm deps can't work for an unpublished monorepo — is in
`loom-examples/AGENTS.md`.

```bash
git clone git@github.com:chhetrisushil/loom-examples.git   # beside ./loom
cd loom-examples && pnpm install
pnpm --filter @loom/db-observability start
```

## Catalogue

### Core patterns

- **`loom-starter`** — the smallest useful flow: a `step$` sequence with a
  human-in-the-loop approval and resume. Start here.
- **`db-observability`** — GenUI dashboards. Demonstrates the **transient
  interpreter** pattern: hydrate the read path with `invokeTransient` (zero
  events) and escalate to a durable repair run only on schema drift. See
  [`transient-interpreter.md`](./transient-interpreter.md), ADR 0065/0066.
- **`db-sentinel`** — the perpetual-agent / sentinel pattern via `sentinelPreset`
  (schedule + durable carry-state + claim-checked telemetry).
- **`child-orchestration`** — cross-execution orchestration (`@loom/orchestration`)
  end to end: a release pipeline that fans out builds with `awaitChildren`
  (wait-all settled, tolerate partial failure), gates smoke tests with `awaitAll`
  (all-or-nothing), and publishes with `awaitChild` (one child) — each service a
  separate durable child execution, no new syscall.

### Execution branching

- **`incident-war-room`** — git-style branching over an execution: fork, simulate
  on a branch, promote — no merge. Uses `BranchRegistry` + `parallelLimit`.
- **`schema-migration-planner`** — a second branching demo (proving the seam is
  domain-agnostic) with live per-branch backfill progress
  (`reportProgress`/`onProgress`).

### Agentic composition

- **`agent-swarm`** — a dynamic agent swarm wired from user intent (release-audit):
  record-plan → `PLAN_COMPOSED`, then a parallel `executeGraph` fan-out. Offline.
- **`db-command-center`** (+ **`-server`**, **`-wc`**) — an intent → planner → A2A
  agentic app with a React UI, an A2A server surface, and a web-component surface.
- **`a2a-mesh`**, **`agent-network`** — agent-to-agent mesh / networking with
  `@loom/plugin-a2a` and `A2AEffect`.

### Compute & backends

- **`compute-cloudrun`** — the same flow on three interchangeable backends
  (in-process / remote-HTTP / Cloud Run) offline via a static platform. Exercises
  the dispatcher + worker-runtime SPI (ADR 0001–0005).
- **`cloud-command-center`** — a command-center built with the `@loom/compiler`
  `loomPlugin()` (build-time `handler$` extraction + resumability).

### UI / generation

- **`a2ui-dashboard`**, **`angular-command-center`** — renderer/UI surface variants
  over `@loom/agent-surface`.
- **`appgen-brownfield`**, **`appgen-models`** — AI-driven app generation
  (`@loom/appgen`).

## Gotcha for UI examples: React singleton

An example that mounts `@loom/plugin-renderer-react` hooks under jsdom links
renderer-react from `../loom`, whose React lives in `../loom/node_modules`. Its
`vite.config.ts` aliases `react`/`react-dom` to the copy the linked package uses
so the app and the hooks share one React (see
`loom-examples/examples/db-command-center/vite.config.ts`).
