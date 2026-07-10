# Loom Capability Maturity

> Generated from `@loom/spec` (`loom kernel-manifest --emit-docs`). Do not edit by hand — it is
> derived from the version constants + capability registry, which are the source of truth.

**Levels:** `L5` ABI guaranteed · `L4` Verified & benchmarked · `L3` Production-ready · `L2` Stable implementation · `L1` Experimental implementation · `L0` Concept accepted

Levels are **evidence-derived, not self-assessed**: `L5` requires a versioned contract pinned
by a conformance test; `L4` requires a committed bench; `L2`/`L3` require a passing test suite.
`spec.test.ts` fails if a capability claims evidence it does not have — so a badge can't rot.

| Capability | Level | Package | Evidence |
|---|---|---|---|
| Branch Registry SPI | `L5` | @loom/event-runtime | `BRANCH_REGISTRY_SPI_VERSION` · test |
| Event Store SPI | `L5` | @loom/event-runtime | `EVENT_STORE_SPI_VERSION` · test · bench |
| Execution Dispatcher SPI | `L5` | @loom/dispatcher | `DISPATCHER_SPI_VERSION` · test |
| Replay VM | `L5` | @loom/replay-vm | `EVENT_SCHEMA_VERSION` · test |
| Snapshot Store SPI | `L5` | @loom/snapshot-runtime | `SNAPSHOT_STORE_SPI_VERSION` · test |
| Wire ABI | `L5` | @loom/wire-abi | `WIRE_ABI_VERSION` · test |
| Workflow Runtime | `L5` | @loom/workflow-runtime | `KERNEL_ABI_VERSION` · test |
| Analytics & Observability | `L4` | @loom/analytics | test · bench |
| Cooperative Scheduler | `L4` | @loom/scheduler | test · bench |
| Deterministic Simulation Testing | `L4` | @loom/dst | test · bench |
| Per-Tenant Fair Scheduler | `L4` | @loom/fair-scheduler | test · bench |
| Projection Runtime | `L4` | @loom/projection-runtime | test · bench |
| Reasoning Router | `L4` | @loom/reasoning | test · bench |
| Runtime Verification | `L4` | @loom/verify | test · bench |
| Compiler | `L3` | @loom/compiler | `COMPILER_MANIFEST_VERSION` · test · used: loom-starter, examples/* |
| Decision Materialization | `L3` | @loom/analytics | test · used: advisoryPipeline + loom introspect |
| Tiered Memory | `L3` | @loom/memory | test · used: examples/db-command-center |
| Child-Workflow Orchestration | `L2` | @loom/orchestration | test |
| Execution-Lifecycle Authorization | `L2` | @loom/workflow-runtime | test |
| Live Query | `L2` | @loom/live-query | test |
| Placement Adapters | `L2` | @loom/dispatcher + workers | test |
| Saga / Compensation | `L2` | @loom/saga | test |
| Tamper-Evident Audit Chain | `L2` | @loom/audit-chain | test |
| GPU Worker | `L0` | — | — |

## Notes

- **Deterministic Simulation Testing** (`L4`): Test/dev-only harness, not a wire contract → cannot be L5; L4 via its append-overhead bench. Production overhead is structurally zero (no runtime package imports it).
- **Per-Tenant Fair Scheduler** (`L4`): Implements the existing Scheduler interface (drops into any consumer); L4 via its Infinity-fast-path bench. Not L5 — the scheduler is ephemeral, not a durable/wire contract.
- **Runtime Verification** (`L4`): No ABI version constant (it is a tool, not a wire contract) → cannot be L5; L4 via its zero-overhead bench.
- **Compiler** (`L3`): Manifest schema is versioned but not conformance-PINNED like the semver ABIs → L3, not L5.
- **Decision Materialization** (`L3`): Proposed as L4, but has no dedicated bench → evidence-derived L3.
- **Child-Workflow Orchestration** (`L2`): Composed from existing primitives — NO new syscall or event type (P10 win; the plan's CHILD_COMPLETED governed event proved unnecessary). L2; single-child await today (fan-out is a follow-up).
- **Execution-Lifecycle Authorization** (`L2`): L2 (tested; opt-in, byte-identical when unwired). Enforced only when a call carries a principal (trust-boundary model) — a boundary check, not a syscall, so no KERNEL_ABI change; adds EXECUTION_DENIED (EVENT_SCHEMA 1.12.0).
- **Live Query** (`L2`): Pure read-model — no syscall, no event type (P10). L2 (tested; not yet wired into a shipped example path).
- **Placement Adapters** (`L2`): SPI is L5, but only local/remote/CloudRun adapters exist; K8s/Lambda/GPU are demand-driven (#72) → the adapter set is L2.
- **Saga / Compensation** (`L2`): NO new syscall/event type/fold change (P10 win; the plan's ctx.compensate syscall + COMPENSATION_* events proved unnecessary — compensators run as replay-guarded ctx.run steps). KERNEL_ABI stays 1.1.0. Verified crash-safe by a DST no-double-compensation property.
- **Tamper-Evident Audit Chain** (`L2`): L2 (stable + tested, incl. a DST crash/recovery integrity property) — not yet wired into a shipped example/defineConfig path, so not L3; no version constant (a composable wrapper, not a wire contract).
- **GPU Worker** (`L0`): Concept only — there is NO gpu-worker package. Demand-driven (#72). A hand-assigned 'L1' would be a badge that lies; evidence-derived it is L0.
