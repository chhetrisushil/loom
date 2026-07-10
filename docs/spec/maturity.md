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
| Projection Runtime | `L4` | @loom/projection-runtime | test · bench |
| Reasoning Router | `L4` | @loom/reasoning | test · bench |
| Runtime Verification | `L4` | @loom/verify | test · bench |
| Compiler | `L3` | @loom/compiler | `COMPILER_MANIFEST_VERSION` · test · used: loom-starter, examples/* |
| Decision Materialization | `L3` | @loom/analytics | test · used: advisoryPipeline + loom introspect |
| Tiered Memory | `L3` | @loom/memory | test · used: examples/db-command-center |
| Placement Adapters | `L2` | @loom/dispatcher + workers | test |
| GPU Worker | `L0` | — | — |

## Notes

- **Runtime Verification** (`L4`): No ABI version constant (it is a tool, not a wire contract) → cannot be L5; L4 via its zero-overhead bench.
- **Compiler** (`L3`): Manifest schema is versioned but not conformance-PINNED like the semver ABIs → L3, not L5.
- **Decision Materialization** (`L3`): Proposed as L4, but has no dedicated bench → evidence-derived L3.
- **Placement Adapters** (`L2`): SPI is L5, but only local/remote/CloudRun adapters exist; K8s/Lambda/GPU are demand-driven (#72) → the adapter set is L2.
- **GPU Worker** (`L0`): Concept only — there is NO gpu-worker package. Demand-driven (#72). A hand-assigned 'L1' would be a badge that lies; evidence-derived it is L0.
