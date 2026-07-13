# Loom Documentation

Start here. The docs are a progressive funnel — read top to bottom, or jump to what you need.

| Doc | Read it when you want to… |
|---|---|
| **[Getting Started](getting-started.md)** | Go from zero to a running, suspend/resume flow in ~5 minutes. |
| **[Usage Guide](usage.md)** | Build a realistic app step by step (steps → flow → config → suspend/resume → agents → branching → ship). |
| **[User Guide](user-guide.md)** | Look up a specific feature: fork, A2A, middleware, projections, testing, CLI, compute… |
| **[CLI Usage Guide](usage-cli.md)** | Drive the `loom` command: scaffold (`new`/`gen`), validate (`check`), observe (`logs`/`debug`/`inspect`), data protection (`retention run`/`compliance report`), and gate a deploy (`eval`/`deploy check`). |
| **[Data classification](data-classification.md)** | Field-sensitivity markers (`secret()`/`sensitive()`/`internal()`/`externalized()`) that drive encryption, redaction, and egress scrubbing (K10-R1/R6). |
| **[Compliance](compliance.md)** | GDPR/CCPA-enabling: subject index, data export (Art. 15/20), and erasure (Art. 17), tenant-scoped (T3). |
| **[Architecture](architecture.md)** | Understand the mission, core principles (P1–P11), the runtime model, and *why* each decision was made. |
| **[Loom 2.0 deep-dives](loom-2.0/00-overview.md)** | The execution-kernel evolution in full detail: data structures, algorithms, and diagrams for every subsystem. |
| **[Presentation](presentation/loom-deck.md)** | Present Loom — the flagship deck (Marp). More decks in [`presentation/`](presentation/). |
| **[ADRs](adr/)** | Read the full decision history (0001–0044, all accepted), one record per decision. |
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

Then the **[Kernel Governance Layer](spec/loom-kernel-specification.md)** ([ADR 0035](adr/0035-kernel-governance-layer.md)) added the normative spec, evidence-derived [maturity badges](spec/maturity.md), and the [compatibility matrix](spec/compatibility-matrix.md), all generated from one manifest (`@loom/spec`). Most recently, the **three-direction arc** ([ADRs 0036–0041](adr/)) added three frontiers as opt-in packages over the stable syscall surface — **simulation testing** (`@loom/dst`), **multi-tenant isolation** (`@loom/plugin-audit-chain`, `@loom/fair-scheduler`, execution-lifecycle authorization), and **coordination primitives** (`@loom/live-query`, `@loom/orchestration`, `@loom/saga`) — landing `EVENT_SCHEMA_VERSION 1.12.0` (`+EXECUTION_DENIED`) with `KERNEL_ABI` unchanged. See [§5.8 of the architecture](architecture.md#58-the-three-direction-arc--simulation-testing-coordination-multi-tenant-isolation).

## The one-paragraph version

A Loom workflow is an ordinary `async` TypeScript function whose every meaningful step is recorded to a durable, append-only **event log**. State is `fold(events)` — a pure, deterministic reconstruction — so an execution can **pause for a human, resume on another machine, replay bit-for-bit, fork to explore alternatives, and be evaluated against its own history**. The durable log is the moat; durability, resumability, replay, branching, evals, and time-travel debugging are all just *lenses on it*.

## Also in this folder

- [`api-reference.org`](api-reference.org) — exhaustive per-package API reference.
- [`usage-compiler.org`](usage-compiler.org) — the optional `@loom/compiler` (build-time `handler$` extraction, resumability).
- [`benchmarks.md`](benchmarks.md) — committed performance baselines.
- [`examples/`](examples/) — reference walkthroughs (`acme-support`, a Postgres storage backend).

## Runnable examples

See [`../examples`](../examples):

- **[`loom-starter`](../examples/loom-starter)** — **start here.** The canonical new-architecture example: `defineConfig` + folder convention (`loom gen`) + effect middleware + `@loom/testing` + evals + deploy-sim + the compute seam, in one compact release-approval app.
- `agent-network` — the full agentic pipeline (LLM, ReAct agent, MCP, A2A, intent, planner, memory).
- `db-command-center` — intent → planner → A2A dispatch → durable human approval (same backend rendered in React, Web Components, and Angular).
- `incident-war-room` & `schema-migration-planner` — git-style branching (fork → simulate → compare → promote).
