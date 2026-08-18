# AGENTS.md — Loom

Orientation for AI coding agents (and humans) working in the `loom` repo.

This repo is the **Loom framework**: the kernel + first-party packages under
`packages/*`, `plugins/*`, and `tools/*`, wired as a pnpm workspace. Runnable
example apps are **not** here — see below.

## Examples live in the sibling `loom-examples` repo

To keep this repo focused on the framework, the example apps were extracted to
**`loom-examples`** (`git@github.com:chhetrisushil/loom-examples.git`), the same
sibling-repo pattern used for `loom-plugins` (3P plugins) and `loom-demo`.

They consume this repo's **unpublished** `@loom/*` packages from a sibling
`../loom` checkout via `link:` (pnpm `overrides`), not `workspace:*`:

```
workspace/
├── loom/            # this repo:        pnpm install && pnpm build
├── loom-plugins/    # 3P plugins.       Only `learning-router` needs it.
└── loom-examples/   # git clone, then:  pnpm install   (link: → ../loom)
```

**To evaluate an example's usage pattern:** read the catalogue below (or the
long-form `docs/examples.md`) to pick the right one, then read its source in
`../loom-examples/examples/<name>/`. Ensure `loom-examples` is checked out beside
`loom`; run one with `pnpm --filter @loom/<name> start` from that repo. Full
wiring rationale (why `link:`/overrides and not git/npm deps) is in
`../loom-examples/AGENTS.md`.

## Example catalogue

| Example | Pattern it teaches | Key APIs / ADRs |
|---|---|---|
| `loom-starter` | Minimal flow + human-in-the-loop approval | `step$`, `ctx.run`, resume |
| `db-observability` | Transient hydration → durable repair (GenUI dashboards) | `invokeTransient`, `mcpInvoke$`, `sandboxEval$` · ADR 0065/0066 |
| `incident-war-room` | Git-style execution branching (fork / simulate / promote) | `BranchRegistry`, `parallelLimit` |
| `schema-migration-planner` | Branching + live per-branch progress | `reportProgress` / `onProgress` |
| `agent-swarm` | Dynamic agent swarm wired from user intent | `executeGraph` fan-out, `PLAN_COMPOSED` |
| `compute-cloudrun` | One flow across in-process / remote / Cloud Run backends | dispatcher + worker-runtime SPI · ADR 0001–0005 |
| `db-command-center` | intent → planner → A2A agentic app (React UI) | `intent`, `planner`, `@loom/plugin-a2a` |
| `db-command-center-server` / `-wc` | Server + web-component surfaces of the above | A2A server, `@loom/agent-surface` |
| `cloud-command-center` | Command-center built with the `@loom/compiler` `loomPlugin()` | `handler$` extraction, resumability |
| `db-sentinel` | Perpetual-agent / sentinel pattern | `sentinelPreset`, `@loom/plugin-durable-state` |
| `a2a-mesh`, `agent-network` | Agent-to-agent mesh / networking | `@loom/plugin-a2a`, `A2AEffect` |
| `a2ui-dashboard`, `angular-command-center` | UI / renderer surface variants | `@loom/agent-surface`, renderers |
| `a2ui-egress` | Project a surface onto the Google A2UI wire protocol | `@loom/plugin-a2ui` `A2UISurfaceBridge`, `ingestAction` |
| `a2ui-callfunction` | Bidirectional RPC: a client function driven from a flow, two grains | `callFunction` via suspend gate / delegated effect · ADR 0070 |
| `mcp-app-release-approval` | Serve an agent surface as an **MCP App** (SEP-1865), real server + real template | `@loom/plugin-mcp-app`, `createMcpServer` · ADR 0072 |
| `child-orchestration` | Cross-execution orchestration — fan-out, all-or-nothing gate, single child | `awaitChildren` / `awaitAll` / `awaitChild` · `@loom/orchestration` |
| `learning-router` | The continuous-learning loop end to end (online → offline → gate) | `@loom/learning` `decideWithPolicy`/`trajectories`/`evaluatePolicy`/`promotionGate`, 3P `loom-plugin-linucb` |
| `appgen-brownfield`, `appgen-models` | AI-driven app generation | `@loom/appgen` |

## Working in this repo

- Package manager: `pnpm@9.14.4` (pinned; use `corepack`). Build: `pnpm build`
  (turbo). Test: `pnpm test`. Lint: `pnpm lint` (biome).
- **A package's tests import its siblings' built `dist`**, which is what a consumer
  gets — so that is what `pnpm test` checks. The cost lands on the inner loop: edit
  a dependency's source and the dependent's tests will not see it until you rebuild,
  while the sourcemaps still point at `src` with pre-edit line numbers, so the
  failure reads as a mystery rather than a stale build. Use **`pnpm test:src`**
  (`LOOM_TEST_SRC=1`) to resolve siblings to source for immediate feedback. Not the
  default, because the two answers differ and CI wants the one that ships.
- Vitest config lives once, in `vitest.shared.ts`; each package's
  `vitest.config.ts` is a two-line re-export so turbo can run tests per package.
- All changes land on a feature branch via PR (never commit to `main` directly).
- ADRs in `docs/adr/`; the recipe docs in `docs/` cross-link the examples that
  demonstrate them (e.g. `docs/transient-interpreter.md` → `db-observability`).
