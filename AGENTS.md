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
| `incident-war-room` | Git-style execution branching (fork / simulate / promote); its diagnostics agent runs on `agentLoop$` | `BranchRegistry`, `parallelLimit`, `defineConfig({ execution: { registerEffects } })` |
| `schema-migration-planner` | Branching + live per-branch progress | `reportProgress` / `onProgress` |
| `agent-swarm` | Dynamic agent swarm wired from user intent | `executeGraph` fan-out, `PLAN_COMPOSED` |
| `compute-cloudrun` | One flow across in-process / remote / Cloud Run backends | dispatcher + worker-runtime SPI · ADR 0001–0005 |
| `db-command-center` | intent → planner → A2A agentic app (React UI) | `intent`, `planner`, `@loom/plugin-a2a` |
| `db-command-center-server` / `-wc` | Server + web-component surfaces of the above | A2A server, `@loom/agent-surface` |
| `cloud-command-center` | Command-center built with the `@loom/compiler` `loomPlugin()` | `handler$` extraction, resumability |
| `db-sentinel` | Perpetual-agent / sentinel pattern | `sentinelPreset`, `@loom/plugin-durable-state` |
| `a2a-mesh`, `agent-network` | Agent-to-agent mesh / networking; a peer's card description is withheld from the model unless the operator vouches (`trustDescriptions: true`) | `@loom/plugin-a2a`, `A2AEffect` · ADR 0125 D14 |
| `a2ui-dashboard`, `angular-command-center` | UI / renderer surface variants | `@loom/agent-surface`, renderers |
| `a2ui-egress` | Project a surface onto the Google A2UI wire protocol | `@loom/plugin-a2ui` `A2UISurfaceBridge`, `ingestAction` |
| `a2ui-callfunction` | Bidirectional RPC: a client function driven from a flow, two grains | `callFunction` via suspend gate / delegated effect · ADR 0070 |
| `mcp-app-release-approval` | Serve an agent surface as an **MCP App** (SEP-1865), real server + real template | `@loom/plugin-mcp-app`, `createMcpServer`, the `loom_surface_since` cursor tool · ADR 0072 |
| `child-orchestration` | Cross-execution orchestration — fan-out, all-or-nothing gate, single child | `awaitChildren` / `awaitAll` / `awaitChild` · `@loom/orchestration` · `@loom/live-query` |
| `saved-views` | A composed surface as a logged artifact — promote, re-open, and catch a binding whose meaning moved | `validateBlueprint`, `checkBlueprintPins`, `sweepUnpinnedContent` · ADR 0088/0095 |
| `planner-decide-scope` | A loom-ui planner deciding THROUGH loom's decide scope: the model call is authorized as the deciding execution (identity + delegation), a denial propagates (nothing recorded), replay makes no model call | `ctx.decide` `DecideScope`, `@loom-ui/planner` `scopeInvoker`/`checkPlannerConformance`, `GrantTable`/`DelegationAuthorizer` · L30/L31/L33 |
| `provenance-explain` | Per-viewer "why is this here" + what a viewer saw: planner decision stamped on ops, viewer-safe explain, a capability-declared class bound as a read policy, a replayable per-viewer seen log, crypto-shred erasure, mark-and-sweep blob GC, retention roll-off | `plannerProvenance`, `Lineage.explain`, `declaredToolClassesFrom`/`ReadPolicy`, `snapshotSeen`/`SeenLog`/`seenToState`, `eraseViewer`, `collectSeenGarbage` · loom-ui U12/U10b |
| `experience-tabs-planner` | loom-ui U15 planner depth (support-ticket triage): a nested `tabs` container composed by the reference planner and drawn by `referenceContainers()`; a minimal-diff revise; an app-owned container stays locked; `setRole` tabs→stepper; an all-restricted panel collapses to a bare placeholder (policy A), and the declared tool-class read floor hides a node the planner never wrote | `REFERENCE_CONTAINER_ROLES`, `ComposeInput.containers`, `referenceContainers()`, `owner:"planner"`, `checkPlannerConformance`, `declaredToolClassesFrom`/`ReadPolicy`, `Lineage.explain` · loom-ui U15 |
| `agent-loop-triage` | The canonical agent loop as a support-ticket triage agent: model routed through the capability ring, parallel tools where a flaky one is `isError` feedback and a terminal quota/authority error still fails the run, a consumed failure never re-run, a refund parked on approval and resumed in a fresh runtime, `writeBack` recalled by the next ticket (tainted, fenced), a fork guard, and the config errors | `agentLoop$` `parallelTools`/`requireApproval`/`writeBack`, `registerReasoningRoutes`, `memoryWriteBackEffect`; state growth: `createSummarizerEffect` + the `LOOM_AGENT_STATE_GROWTH` warning · ADR 0121/0137 |
| `chat-agent` | The conversation layer, one owner: multi-turn, barge-in (the partial kept as interrupted), a tiny token window (rotation + rolling summary), a restart then SSE `Last-Event-ID` resume with no gap or duplicate, and another tenant getting the same 404 as a missing conversation | `@loom/conversation` `createConversations`/`inboxBargeIn`, `@loom/plugin-conversation-sse`, `budget` · ADR 0122 |
| `incident-shared-chat` | Shared mode for an incident war-room chat: participants share one conversation, each turn runs AS THE ASKER, answers classified and filtered per viewer (history, stream, model context), FIFO turns, HMAC-signed envelopes (tamper / impersonation / replay / stale refused), a service-principal coordinator, a non-participant 404; three viewers, three loom-ui `ChatFeed` transcripts | `conversation$({ shared })`, `createConversations`, `@loom/plugin-conversation-sse`, loom-ui `ChatFeed` · ADR 0122 D10 |
| `media-gallery` | Multi-modal media claim-checked by ADDRESS: `returnsMedia` tools, the log holds addresses not bytes, a tenant-authorizing `ContentResolver(ref, ctx)` (owner = a SET under dedupe), the provider capability allowlist with a text-only fallback, `x-content-ref` arguments refused for a foreign ref, a loom-ui gallery with viewer-scoped links, and content GC that must scan EVERY store (dry run first) | `returnsMedia`/`mediaResult`, `ContentResolver`, `contentRefArgsFrom`/`acceptContentRefParam`, `sweepUnpinnedContent` (an erasing pass over compacted logs needs `archiveStores`) · ADR 0120/0138 · loom-ui U9/U9b |
| `experience-merge` | loom-ui three-way merge of two forked Experiences (community-garden rota board): disjoint edits land clean, relabel → `edit/edit`, competing moves → `move/move`, one localization key given two meanings → `message/message`; ours-biased unsealed result, the app seals the merge commit with both heads as parents | `@loom-ui/core` `mergeExperiences`, `keyConflicts` · loom-ui B5a |
| `experience-broadcast` | loom-ui audience: ONE sealed Experience compiled for an agent's own screen (`viewer`) and a lobby wallboard (`broadcast`, least-privileged whoever is logged in); classified widgets become loom's redacted widget (IR 2.5.0, drawn as `⊘ redacted`), `audience-withheld` findings, the hydration inventory and a broadcast-scoped store hold no classified data | `compile({ audience })`, `handleInventory`, `HydrationScope.audience`, `WidgetSource.redacted` · loom-ui slice 7 |
| `learning-router` | The continuous-learning loop end to end (online → offline → gate) | `@loom/learning` `decideWithPolicy`/`trajectories`/`evaluatePolicy`/`promotionGate`, 3P `loom-plugin-linucb` |
| `tool-search-mcp-menu` | A large MCP tool menu kept out of the prompt: `search_tools` over a 64-tool catalogue, remote descriptions withheld and results tainted, host annotations plus a query stoplist ("bill the customer" finds `charge_invoice` alone), skills discovered by search and activated mid-loop, a custom ranker FACTORY built once per run from the sanitized search docs (two-ranker mode), and a crash/resume with zero factory and ranker calls | `agentLoop$` `toolSearch` (`catalog`, `annotations`, `ranker` factory, `stopwords`) / `skillActivation` `discovery: "search"`, `ToolSearchDoc`, `@loom/plugin-mcp` · ADR 0125 D13/D15 |
| `planner-learning` | The learning lifecycle for a loom-ui planner: viewers vote on what the server recorded showing them (exposure required, one bounded vote each), one late reward per planner decision, and a candidate layout policy through the R18 registry: SHADOW (scored, never served), CANARY (stable slice), SNIPS + `promotionGate`, then promote or ROLLBACK when the world drifted; one `ReferencePlanner` chooses the variant through the rollout (`variants.rollout`), a contextual candidate reads a host-owned feature store keyed by the unit; replay serves the recorded decision and consults no policy | loom-ui `ReferencePlanner` `variants.rollout`, `decideWithRollout`, `PolicyRegistry`, `SignalIngestor`/`seenLogExposure`/`VoteLedger`/`settleRewards`/`linkFromLedger` · ADR 0078–0080/0124 · loom-ui U11 |
| `blueprint-status` | A plain loom app on Blueprint IR 2: a health board whose projection folds a status channel, with grid-cell spans and `source` provenance read by the terminal renderer from the Blueprint alone | `validateBlueprint`, `check` seam, status channel · ADR 0097 |
| `experience-kinds` | loom-ui framework kinds (`Kpi`, `Table`, `StatusCard`, `Note`, `TimeSeries`) in a warehouse board, compiled for web and terminal and hydrated from checked sample values | `compile`, `HydrationStore`, `frameworkKindContracts`, `litRegistry` · loom-ui |
| `experience-layout` | Placement and section titles: explicit grid lines and row spans vs document-order flow, titled sections, a revision that restyles without remounting | Blueprint IR 2.1.0, `renderBlueprintDom` · ADR 0098 |
| `experience-stepped` | The container-renderer seam: an app-registered renderer for the `"stepper"` role with the adapter keeping mount, reconcile and focus; `setRole`, zero-mutation updates, appended steps | `DomRenderOptions.containers`, `Layout.role` · ADR 0099 |
| `experience-recompose` | An agent revision landing while the user types: live-DOM reconcile by widget id keeps focus, selection and text; hydration recomposes in the same step | `handle.update`, `DomWidgetHandle.patch`, `HydrationController` · loom-ui slice 6a |
| `experience-board-edit` | Operations and planner accounting: `setPlacement` resize, `removeProvider` refused while bound, a revision that keeps the user's resize, usage replayed with no model call | `interpretAction`, `apply`, `PlanReport.usage` · loom-ui |
| `order-lines` | The empty binding state: an out-of-range index into a real empty array is `empty` ("No data"), a wrong key is `error`; the dependent tool is never called | `walkPath`, `unresolved-step-reference` · ADR 0100 |
| `split-hydration` | Split hydration: the server holds the Experience and the handle inventory, the client loads values over a JSON-boundary loader; no provider detail crosses | `handleInventory`, `SplitHydrationController`, `HandleLoader.loadMany` · loom-ui |
| `runbook-recall` | Retrieval-augmented generation from parts that exist for other reasons: the semantic memory tier as the corpus, `ctx.decide` for which passages were used, taint at ingest | `MemoryStore.search`, `@loom/knowledge` · ADR 0085/0091 |
| `reasoning-audit` | Model reasoning as audit evidence: an expense agent's reasoning is captured at the provider seam into a sidecar store and kept out of the log (the step value holds signatures, refs and digests, never text), sent back unchanged in vendor block order, read back TAINTED by an auditor, erasable without breaking replay, sealed to its execution (a forged ref is dropped), streamed live on its own hub channel, and discarded with a warning (or refused) on the direct routed path | `defineConfig({ observability: { reasoning } })`, `readReasoning`, `LLM_REASONING_CAPTURED`, `reasoningToolId`/`requireReasoningContinuation`, `ConversationHub.reasoningSink()` · ADR 0133 |
| `appgen-brownfield`, `appgen-models` | AI-driven app generation | `@loom/appgen` |

## Working in this repo

- **GitHub Actions minutes are a budget.** CI runs once per READY pull request (drafts and pushes to
  `main` do not run; `workflow_dispatch` runs it by hand). Open PRs as **drafts**, iterate fix rounds
  against the full LOCAL verify (`pnpm build && npx turbo test --force --concurrency=2 && pnpm typecheck && pnpm typecheck:tests
  && pnpm lint`), and mark the PR ready for review only when it is final. Never push just to "see CI".
- **Writing tests — CI is concurrent and shared; a flaky test is a bug.** (Enforced by
  `packages/spec/src/testTiming.test.ts`; flakes are hunted ON DEMAND by `.github/workflows/flake-hunt.yml` — manual only, it costs N× CI minutes.)
  - Wait on a CONDITION (`until(...)`, `eventually(...)`), never a fixed `sleep`/`tick(n)` before
    asserting a background effect — and wait for the WHOLE exchange (e.g. the predecessor's commit,
    not just the successor's park) before reading its results.
  - Never gate on wall-clock noise: no `performance.now()` and no timing ratios in a `*.test.ts`. Put
    perf ratios/budgets in a `*.perf.test.ts` (excluded from `pnpm test`; run locally with `pnpm test:perf` or via the manual flake hunt, non-blocking
    in CI). Prefer deterministic evidence — call counts, rows scanned, round trips. When the slow path is
    a hang, completing within the test timeout IS the proof; otherwise justify an elapsed upper bound
    with `// timing-bound: <what the slow path costs>` and keep it ≥ 5 s.
  - A precondition that depends on elapsed time needs a WIDE window (seconds, not ~100 ms), and a test
    that intentionally waits must raise its own timeout (vitest's default is 5 s).
  - A test server binds the host its client dials: `server.listen(0, "127.0.0.1", cb)`, never a bare
    `listen(0)`. On macOS a wildcard bind can share a port with another process's 127.0.0.1 listener,
    and the client then talks to that stranger (enforced by `packages/spec/src/testServerBinding.test.ts`).

- **`pnpm typecheck` does NOT see tests** (every package tsconfig excludes `*.test.ts`); **`pnpm typecheck:tests`**
  runs each package's `tsconfig.test.json` (`noEmit`, tests included, siblings resolved from built `dist`, so
  build first). A new package with tests needs a `tsconfig.test.json` + the script
  (enforced by `packages/spec/src/testTypecheckCoverage.test.ts`).
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
- **`pnpm build` (turbo) runs 78 separate `tsc --build` processes**, one per
  package, and per-process startup dominates: the cold profile is flat, with tiny
  packages costing nearly as much as large ones. `pnpm build:fast` is the same
  graph in ONE process via project references. Timings below were measured on an earlier,
  smaller tree (72 tasks); only the counts are current:

  | | `pnpm build` (turbo) | `pnpm build:fast` |
  | --- | --- | --- |
  | cold | 22.9s wall / 132.5s CPU | **6.1s / 9.8s** |
  | after editing `@loom/core` | 8.4s (63 of 72 tasks re-ran; now 69 of 78 by the task graph) | **0.54s** |
  | no-op | 0.69s (full turbo cache) | ~0.3s |

  Use `build:fast` for the edit-rebuild loop. `pnpm build` stays canonical because
  turbo's per-package cache is what the `test` task's `^build` dependency reads —
  CI has no remote cache, so it pays the cold number on every run.
- All changes land on a feature branch via PR (never commit to `main` directly).
- ADRs in `docs/adr/`; the recipe docs in `docs/` cross-link the examples that
  demonstrate them (e.g. `docs/transient-interpreter.md` → `db-observability`).
