# Loom Documentation

Start here. The docs are a progressive funnel — read top to bottom, or jump to what you need.

| Doc | Read it when you want to… |
|---|---|
| **[Getting Started](getting-started.md)** | Go from zero to a running, suspend/resume flow in ~5 minutes. |
| **[Usage Guide](usage.md)** | Build a realistic app step by step (steps → flow → config → suspend/resume → agents → branching → ship). |
| **[User Guide](user-guide.md)** | Look up a specific feature: fork, A2A, middleware, projections, testing, CLI, compute… |
| **[CLI Usage Guide](usage-cli.md)** | Drive the `loom` command: scaffold (`new`/`gen`/`appgen`), validate (`doctor`/`check`/`verify`/`lint`), observe (`logs`/`debug`/`inspect`), data protection (`retention run`/`compliance report`), and gate a deploy (`eval`/`deploy check`). |
| **[Data classification](data-classification.md)** | Field-sensitivity markers (`secret()`/`sensitive()`/`internal()`/`externalized()`) that drive encryption, redaction, and egress scrubbing (K10-R1/R6). |
| **[Compliance](compliance.md)** | GDPR/CCPA-enabling: subject index, data export (Art. 15/20), and erasure (Art. 17), tenant-scoped (T3). |
| **[Composed surfaces](composed-surfaces.md)** | Record a runtime-composed UI as a durable artifact: validate → content-address → `ctx.emit` → replay, with pinning, and what not to do. |
| **[Transient manifest interpreter](transient-interpreter.md)** | Run a hot, content-addressed read path with zero events, escalating to a durable run only when a repair must be recorded. |
| **[Data-protection patterns](data-protection-patterns.md)** | The assembly order for long-running observer agents: redaction, shredding, pinned retention, tenant scoping, residency. |
| **[Acceptance governance](acceptance-governance.md)** | The self-quieting loop: OUTCOME_RECORDED → rankFromOutcomes → rankedRouter — proactivity trained by usage. |
| **[Architecture](architecture.md)** | Understand the mission, core principles (P1–P11), the runtime model, and *why* each decision was made. |
| **[Loom 2.0 deep-dives](loom-2.0/00-overview.md)** | The execution-kernel evolution in full detail: data structures, algorithms, and diagrams for every subsystem. |
| **[Presentation](presentation/loom-deck.md)** | Present Loom — the flagship deck (Marp). More decks in [`presentation/`](presentation/). |
| **[ADRs](adr/)** | Read the full decision history (0001–0104), one record per decision — including rejections (e.g. ADR 0067). |
| **[Requirements](requirements/)** | Recorded requirement sets — the kernel-hardening series [K7–K12, T1–T2](requirements/2026-07-10-kernel-hardening-k7-k12-t1-t2.md) and its code-grounded [evaluation & amendments](requirements/2026-07-10-kernel-hardening-evaluation.md) (all eight accepted with amendments, all implemented). |

## Loom 2.0 — the execution kernel

Loom 2.0 evolves the durable workflow runtime into the **execution kernel for intelligent software**. Everything is additive and opt-in, so the guides above stay valid. The deep-dive set lives in [`loom-2.0/`](loom-2.0/00-overview.md):

| Doc | Covers |
|---|---|
| [Overview](loom-2.0/00-overview.md) | Big picture, principles P9/P10, the two spines, milestone map, kernel scorecard, package map |
| [Execution & Decision seams](loom-2.0/01-execution-and-decision-seams.md) | `ctx.execute` + `Execution` PCB · `ctx.decide` + `DECISION_RECORDED` · kernel ABI (K1) |
| [Reasoning & Memory](loom-2.0/02-reasoning-and-memory.md) | Model routing/elevation (M3) · tiered memory + logged recall (M5) |
| [Compute, Scheduling & Storage](loom-2.0/03-compute-scheduling-storage.md) | Placement (M4) · scheduler-in-hot-path (M6) · supervision (K4) · Postgres scale-out (M3.5) |
| [Kernel hardening](loom-2.0/04-kernel-hardening.md) | Rings K1–K6 (ABI · authority · quotas · supervision · event-schema · safety) **plus the second series K7–K12 + T1–T2** (isolation/egress · cancellation · idempotency/fencing · log lifecycle · flow versioning · identity/tenancy · durable timers · wire ABI) |
| [Capabilities, Agents, Intelligence & DX](loom-2.0/05-capabilities-agents-intelligence-dx.md) | Capabilities (M7) · agents (M8) · analytics/self-opt (M9–M11) · NL→codegen (P11) |
| [Event-schema reference](loom-2.0/10-event-schema-reference.md) | The complete on-disk event ABI: every event, payload, and fold |
| [Encryption at rest](loom-2.0/11-encryption-at-rest.md) | K10.5 — encrypting the store files (SQLite/Postgres) and how it layers with field-level crypto + redaction |

The foundational decision record is [ADR 0016](adr/0016-loom-2.0-execution-runtime-and-decision-seam.md); the second kernel-hardening series (K7–K12, T1–T2) is recorded in [ADRs 0019–0026](adr/) with its [evaluation & amendments](requirements/2026-07-10-kernel-hardening-evaluation.md). Two follow-ups then landed on `main`: a second DS&A optimization pass ([ADR 0015 amendment](adr/0015-dsa-performance-optimizations.md#amendments-second-dsa-pass-pr-63-2026-07-10)) and off-log advisory pre-warming ([ADR 0027](adr/0027-advisory-pre-warming.md)).

Then the **[Kernel Governance Layer](spec/loom-kernel-specification.md)** ([ADR 0035](adr/0035-kernel-governance-layer.md)) added the normative spec, evidence-derived [maturity badges](spec/maturity.md), and the [compatibility matrix](spec/compatibility-matrix.md), all generated from one manifest (`@loom/spec`). Then the **three-direction arc** ([ADRs 0036–0041](adr/)) added three frontiers as opt-in packages over the stable syscall surface — **simulation testing** (`@loom/dst`), **multi-tenant isolation** (`@loom/plugin-audit-chain`, `@loom/fair-scheduler`, execution-lifecycle authorization), and **coordination primitives** (`@loom/live-query`, `@loom/orchestration`, `@loom/saga`) — landing `EVENT_SCHEMA_VERSION 1.12.0` (`+EXECUTION_DENIED`) with `KERNEL_ABI` unchanged. See [§5.8 of the architecture](architecture.md#58-the-three-direction-arc--simulation-testing-coordination-multi-tenant-isolation). Then the **perpetual-agents series** ([ADRs 0051–0057](adr/)) made logically perpetual, schedule-driven agents a first-class pattern: typed, contract-migratable carry state (`@loom/plugin-durable-state`), claim-checked bulk effect data (`claimCheckMiddleware` — the log records `{ ref, size, digest }` as the value), the K10.6 retention pin seam + pinned content GC, K11.5 contract-versioned state migration on `resumeAs`, opt-in `validateInput`, and a fix for the multi-gate suspend replay bug — landing `EVENT_SCHEMA_VERSION 1.16.0` with `KERNEL_ABI` unchanged, proven by a DST-simulated year in `db-sentinel` (in the sibling [`loom-examples`](examples.md) repo). Its **db-copilot infrastructure follow-on** ([ADRs 0058–0059](adr/)) added durable cross-execution read models (`@loom/plugin-read-model` — the institutional-memory query engine), paged store enumeration (EventStore SPI 1.2.0), streaming content ingestion (`putStream` + stream-typed claim-check), the `loom sweep content` operator CLI with the first durable content backend, and `sentinelPreset()`/`loom new sentinel`.

The arcs since have all landed **outside** the kernel — `KERNEL_ABI` is still `1.1.0`, and only two of them touched the event schema at all (typed failure channels took it to `1.17.0`, the learning substrate's decision context to `1.18.0`). One kernel bug fix has touched it since: [ADR 0102](adr/0102-flow-emits-append-once.md) made flow-level `ctx.emit`/`stream`/`ui` append once per execution instead of once per re-run (`1.19.0`, no ABI change):

- **GenUI dynamic execution** ([ADRs 0060–0066](adr/)) — the one that *did* change the kernel, and minimally: **typed failure channels** (`STEP_FAILED.channel/payload`, `EVENT_SCHEMA_VERSION 1.17.0`) let a step fail into a named channel that replay substitutes rather than re-runs. Around it, in userspace: the step-identity/interpreter contract ([0061](adr/0061-step-identity-interpreter-guardrails.md)), batched content resolution (`getMany`), MCP **dynamic dispatch** with schema-hash pinning ([0063](adr/0063-mcp-dynamic-dispatch.md)), the QuickJS `@loom/plugin-sandbox` ([0064](adr/0064-sandbox-eval-plugin.md)), and the `invokeTransient` façade ([0066](adr/0066-transient-effect-invocation-facade.md)) — see [the transient-interpreter guide](transient-interpreter.md). [ADR 0067](adr/0067-reactive-graph-resumability-rejected.md) records what was *rejected* here.
- **Agent surfaces on the wire** ([ADRs 0068–0070](adr/)) — `subscribeSelector`, and `@loom/plugin-a2ui`: Loom agent surfaces projected onto the Google A2UI protocol, including `callFunction` bidirectional RPC, where the client's *result* re-enters as a recorded fact under a deterministic `callId` — which is what keeps a client-invoked function inside the replay grain.
- **Replay inspection** ([ADR 0071](adr/0071-read-only-replay-inspector.md)) — `@loom/replay-inspector`, a strictly read-only lens over a stored log.
- **MCP Apps** ([ADRs 0072–0073](adr/)) — ingress fidelity for the `io.modelcontextprotocol/ui` extension, an MCP **server** (`createMcpServer`) that exposes Loom flows to any host, and `ui://` egress as **one static content-pinned template** rather than per-flow generated HTML. The host role (iframe, CSP, postMessage) was deliberately rejected — and [D8](adr/0072-mcp-apps-ui-extension-placement.md) records why packaging one as a third-party plugin is not yet worth it either: it implements no Loom seam, and an unmaintained sandbox fails silently in the attacker's favour. Alongside it, the **effect-mode boundary** ([0073](adr/0073-effect-mode-journaled-vs-ambient.md)): `journaled` vs `ambient` is a *boundary check* at the execute seam, not a second durability class — user-driven enrichment reads stay out of the log without adding a second replay model.

- **Storage scale-out, then boundary contracts** ([ADRs 0074–0077](adr/)) — `CoalescingEventStore` and `ShardedEventStore` put cross-execution batching and hash-routed fan-out in *decorators* ([0074](adr/0074-storage-scale-out-decorators.md)), so a BYO store inherits scale-out without implementing it, and [0075](adr/0075-shard-rebalancing.md) lets a sharded log grow its shard count via virtual buckets and lazy drain — no coordinator, no stop-the-world migration. Then two boundaries that *looked* enforced and were not: [0076](adr/0076-wildcard-classification-paths.md) gave classification paths an `[]` array crossing, because a `sensitive()` mark inside an array element had collected no path at all — masked nowhere, encrypted nowhere, externalized nowhere; and [0077](adr/0077-typed-resume-payloads.md) added per-gate `resumeSchemas`, parsed *before* the append, so a wrongly-shaped resume is refused instead of becoming a permanent fold input. `KERNEL_ABI` and `EVENT_SCHEMA` both unchanged throughout.

- **Learning, and the placement of it** ([ADRs 0078–0084](adr/)) — [0078](adr/0078-exploration-in-the-routing-seam.md) fixed a learned router that collapsed onto whichever arm got lucky first; [0079](adr/0079-decision-context-and-policy.md) added `context` and `policy.propensity` to `DECISION_RECORDED` (the one quantity that cannot be reconstructed later), and [0080](adr/0080-learning-substrate.md) built `@loom/learning` on top: trajectories, SNIPS off-policy evaluation against real traffic, and a promotion gate — while the learning *algorithm* stays third-party behind a one-method SPI. Then the Companion workload arrived asking for two kernel promotions and got neither: [0081](adr/0081-long-lived-suspensions-no-promotion.md) found month-long suspensions already work (retention only reaps *terminal* runs, and nothing polls), and [0082](adr/0082-substitutive-replay-deferred.md) deferred substitutive replay until someone shows a fork-from-prefix branch cannot answer the same question. That review also exposed an asymmetry — a strong antibody against kernel growth and none against first-party surface growth — so [0083](adr/0083-second-consumer-rule.md) added the second-consumer rule. What that workload *did* get is [0084](adr/0084-effect-classes-static-ceiling-k2-floor.md): **effect classes** as a static ceiling — a flow may not reach an effect worse than it declared — sitting beside K2's runtime floor rather than inside it, because a *granted* capability can still bust the class and nothing at runtime would notice. `KERNEL_ABI` unchanged throughout; `EVENT_SCHEMA` moved once, additively, to 1.18.0.

- **Two axes that only existed on paper** ([ADRs 0085–0086](adr/)) —
  [0085](adr/0085-untrusted-content-integrity-axis.md) added the **integrity** axis beside
  classification's confidentiality one: integrity is a property of a *value*, not a field, so
  `tainted()` wraps third-party bytes at ingress and `@loom/llm`'s `guardRequest` refuses them in
  every instruction position, fencing them in a `user` message. The refusal is structural; the
  fence is only a label, and the doc says which is which. Then
  [0086](adr/0086-runner-body-reach-analysis.md) closed the *"reachable = declared steps"* bound
  that limited three `@loom/verify` rules — and populating `suspension-safety`'s never-fed input
  proved two of its three checks wrong, one of which would have errored on the majority of
  correct code. A check whose input nothing populates is also a check nobody can see is wrong.

- **Loom as an agent runtime** ([ADR 0087](adr/0087-durable-agent-loop.md)) — a placement
  evaluation asked whether Loom could host an agent runtime without touching the kernel, and
  answered that at the kernel layer it already is one: the gap was that `@loom/agent` ran the ReAct
  loop on the wrong side of two boundaries — inside a step handler, so it had no syscalls, and
  outside the `EffectRuntime`, so it had no protection ring. **Nine gaps, all 1P, kernel unchanged.**
  `agentLoop$` runs the loop from a *runner body*: one durable frame per turn, ids minted per the
  ADR 0061 identity rule, the model call resolved through the `EffectRuntime`, and a gate that parks
  the execution *before* a destructive tool runs. Its choices — which skills, what memory, which
  model — go through `ctx.decide`, so a replay reconstructs the prompt that actually ran rather than
  re-deciding. Alongside it: the prompt-boundary guard now runs where prompts are actually built
  (it had no production consumer, and the agent path *erased* taint rather than merely ignoring it);
  an agent's declared tool menu became its reachable effect set, so `effect-class` and
  `capability-compat` stopped passing vacuously over agent flows; a capability denial became
  terminal for the turn instead of retryable feedback; a spawned child can be conferred *less*
  authority than the flow it runs; the streaming SPI gained a **streamed ≡ completed** conformance
  contract; and K8.4 — the last unimplemented piece of [ADR 0020](adr/0020-k8-cancellation-deadlines-bounded-effects.md) —
  now severs a runaway generation *while it generates*.

- **Composed surfaces, made checkable** ([ADRs 0088–0089](adr/), [0094–0095](adr/)) — a blueprint a
  *person* writes is checked by the type system; one a **model** composes at runtime is data, and
  nothing checked it. [0088](adr/0088-blueprint-conformance.md) closed both vocabulary paths —
  `validateBlueprint` reports findings (never throws, so a composer can degrade and file a gap) and
  `catalogCoverage` asks the question that is easy to forget, whether a renderer implements
  everything the catalogue declares; it failed on shipped code the day it was written.
  [0094](adr/0094-blueprint-node-identity.md) added the half a single-tree validator cannot see —
  which node ids a structural change DROPPED — and [0095](adr/0095-binding-semantics-pin.md) the
  half a content address cannot: a binding freezes a *name*, while the fold behind it is live code,
  so what that name MEANT is declared and compared rather than assumed.
  [0089](adr/0089-sandbox-worker-pool.md) gave the QuickJS sandbox an opt-in worker pool, which
  contributes the one thing an in-engine guard structurally cannot — a hard kill for a script that
  never reaches the interrupt handler.

- **Knowledge, and the lifecycle of a corpus** ([ADRs 0090–0093](adr/)) —
  [0090](adr/0090-knowledge-is-retrieval-over-memory.md) refused a `knowledge$` construct and made
  retrieval one optional verb on the memory seam (`search`), proven portable by four independent
  implementations of one conformance kit. [0091](adr/0091-corpus-lifecycle-and-the-knowledge-package.md)
  then corrected its own premise: a corpus is **mutable**, `search` ranks within one key while a
  *document* is a subset of it, so entry identity plus `remove` (MemoryStore SPI 2.x) and
  `@loom/knowledge` for the document↔passage mapping. [0092](adr/0092-adaptive-operator-profiles-placement.md)
  placed adaptive per-operator UI entirely in userland — with the expiry that would have made a fold
  impure moved into an event — and [0093](adr/0093-read-model-row-purge.md) made erasing one subject
  from a read model cost one subject rather than a whole-model rebuild (measured at 68×).

## The one-paragraph version

A Loom workflow is an ordinary `async` TypeScript function whose every meaningful step is recorded to a durable, append-only **event log**. State is `fold(events)` — a pure, deterministic reconstruction — so an execution can **pause for a human, resume on another machine, replay bit-for-bit, fork to explore alternatives, and be evaluated against its own history**. The durable log is the moat; durability, resumability, replay, branching, evals, and time-travel debugging are all just *lenses on it*.

## Also in this folder

- [`api-reference.org`](api-reference.org) — exhaustive per-package API reference.
- [`usage-compiler.org`](usage-compiler.org) — the optional `@loom/compiler` (build-time `handler$` extraction, resumability).
- [`cheatsheet-features.md`](cheatsheet-features.md) — Card I: the kernel's ten syscalls, the builders, and the subsystems on the log. Printable.
- [`cheatsheet-dx.md`](cheatsheet-dx.md) — Card II: the CLI, the scaffolds, the tests, the operator passes, and what bites. Printable.
- [`plugins.md`](plugins.md) — authoring a plugin: the seam list, `loom plugin new`, and the 1P/3P split.
- [`transient-interpreter.md`](transient-interpreter.md) — the transient/interpreter grain (`invokeTransient`, dynamic step minting).
- [`benchmarks.md`](benchmarks.md) — committed performance baselines.
- [`scaling.md`](scaling.md) — capacity guide: which regime your workload is in, what scaling support ships today, and what each further change is waiting on.
- [`examples/`](examples/) — reference walkthroughs (`acme-support`, a Postgres storage backend).

## Runnable examples

The runnable example apps live in the sibling **`loom-examples`** repo
(`git@github.com:chhetrisushil/loom-examples.git`); this repo keeps the framework
packages. See the **[examples catalogue](examples.md)** for what each teaches and
the APIs/ADRs it exercises, then read the source in `../loom-examples/examples/<name>/`
(check `loom-examples` out beside `loom`; run one with `pnpm --filter @loom/<name> start`).

- **`loom-starter`** — **start here.** The canonical new-architecture example: `defineConfig` + folder convention (`loom gen`) + effect middleware + `@loom/testing` + evals + deploy-sim + the compute seam, in one compact release-approval app.
- `agent-network` — the full agentic pipeline (LLM, ReAct agent, MCP, A2A, intent, planner, memory).
- `db-command-center` — intent → planner → A2A dispatch → durable human approval (same backend rendered in React, Web Components, and Angular).
- `db-sentinel` — the perpetual-agent pattern (ADRs 0051–0057): a `schedule$`-driven sentinel with durable carry state, claim-checked telemetry, findings as domain events, and pinned retention — all ten acceptance criteria proven over a DST-simulated year.
- `incident-war-room` & `schema-migration-planner` — git-style branching (fork → simulate → compare → promote).
- `agent-swarm` — a fleet wired from intent, with `policy$` least-privilege enforcement (each agent scoped to its own effect; a fleet-wide read-only guardrail).
- `a2ui-dashboard` — one agent surface per agent (`defineConfig({ agentSurface: true })`): each agent drives its own live panel, folded durably from the event log.
- `appgen-brownfield` & `appgen-models` — `loom appgen` walkthroughs (docs-only): surgical edits to an existing app, and planning with the model of your choice (`--model anthropic:` / `openai:` / `gemini:` / a local `.gguf`).
