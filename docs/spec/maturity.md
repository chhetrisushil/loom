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
| Batched Content Resolution | `L4` | @loom/plugin-content | test · bench |
| Cooperative Scheduler | `L4` | @loom/scheduler | test · bench |
| Deterministic Simulation Testing | `L4` | @loom/dst | test · bench |
| Per-Tenant Fair Scheduler | `L4` | @loom/fair-scheduler | test · bench |
| Projection Runtime | `L4` | @loom/projection-runtime | test · bench |
| Reasoning Router | `L4` | @loom/reasoning | test · bench |
| Runtime Verification | `L4` | @loom/verify | test · bench |
| Compiler | `L3` | @loom/compiler | `COMPILER_MANIFEST_VERSION` · test · used: loom-starter, examples/* |
| Decision Materialization | `L3` | @loom/analytics | test · used: advisoryPipeline + loom introspect |
| Tiered Memory | `L3` | @loom/memory | test · used: examples/db-command-center |
| Typed Resume Payloads | `L3` | @loom/workflow-runtime | test · used: loom-examples: all 19 ctx.suspend gate sites |
| Child-Workflow Orchestration | `L2` | @loom/orchestration | test |
| Classification Path Reach (array crossings) | `L2` | @loom/classify | test |
| Effect Mode Boundary (journaled vs ambient) | `L2` | @loom/effect-runtime | test |
| Execution-Lifecycle Authorization | `L2` | @loom/workflow-runtime | test |
| Live Query | `L2` | @loom/live-query | test |
| MCP Apps `ui://` Egress | `L2` | @loom/plugin-mcp-app | test |
| MCP Dynamic Dispatch | `L2` | @loom/plugin-mcp | test |
| MCP Server | `L2` | @loom/plugin-mcp | test |
| Placement Adapters | `L2` | @loom/dispatcher + workers | test |
| Saga / Compensation | `L2` | @loom/saga | test |
| Sandboxed Reshaping Executor | `L2` | @loom/plugin-sandbox | test |
| Shard Rebalancing | `L2` | @loom/event-runtime | test |
| Step Identity & Interpreter Pattern | `L2` | @loom/workflow-runtime | test |
| Storage Scale-Out Decorators | `L2` | @loom/event-runtime | test |
| Tamper-Evident Audit Chain | `L2` | @loom/plugin-audit-chain | test |
| Typed Failure Channels | `L2` | @loom/workflow-runtime | test |
| GPU Worker | `L0` | — | — |

## Notes

- **Batched Content Resolution** (`L4`): TS-10 (ADR 0062) — the read-side sequel to ADR 0059's putStream. Optional-method + conformance-skip idiom; interactive budget p95 ≤ 150ms for ≤ 50 refs (asserted in batchedResolution.test.ts against an injected-latency backend).
- **Deterministic Simulation Testing** (`L4`): Test/dev-only harness, not a wire contract → cannot be L5; L4 via its append-overhead bench. Production overhead is structurally zero (no runtime package imports it).
- **Per-Tenant Fair Scheduler** (`L4`): Implements the existing Scheduler interface (drops into any consumer); L4 via its Infinity-fast-path bench. Not L5 — the scheduler is ephemeral, not a durable/wire contract.
- **Runtime Verification** (`L4`): No ABI version constant (it is a tool, not a wire contract) → cannot be L5; L4 via its zero-overhead bench.
- **Compiler** (`L3`): Manifest schema is versioned but not conformance-PINNED like the semver ABIs → L3, not L5.
- **Decision Materialization** (`L3`): Proposed as L4, but has no dedicated bench → evidence-derived L3.
- **Typed Resume Payloads** (`L3`): ADR 0077 — the shape counterpart to K12.2's identity gate (which authenticates WHO may resume, never WHAT they send). KERNEL_ABI unchanged 1.1.0: no syscall added, and ctx.suspend's type parameter is erased. Opt-in by presence (G2).
- **Child-Workflow Orchestration** (`L2`): Composed from existing primitives — NO new syscall or event type (P10 win; the plan's CHILD_COMPLETED governed event proved unnecessary). L2; single-child and concurrent fan-out both land on the one suspend/resume cycle, and child failure propagates — awaitChild throws (composing up the tree), awaitChildren settles per-child for the parent to weigh.
- **Classification Path Reach (array crossings)** (`L2`): ADR 0076 — closes a SILENT gap: a sensitive() mark inside an array element collected no path, so it was masked nowhere, encrypted nowhere, externalized nowhere. The @loom/verify `classification-reachability` rule now covers only what remains unaddressable (record/union/tuple/intersection).
- **Effect Mode Boundary (journaled vs ambient)** (`L2`): ADR 0073 — a boundary CHECK at the execute seam, not a journaling mode: KERNEL_ABI stays 1.1.0, no event type, one replay model. The rejected alternative (ambient = 'skip the journal inside an execution') is DE-2's durability class, a second semantic model inside one execution. Enforced by the entry point, not by context contents, so a transient-looking hand-built context cannot spoof it.
- **Execution-Lifecycle Authorization** (`L2`): L2 (tested; opt-in, byte-identical when unwired). Enforced only when a call carries a principal (trust-boundary model) — a boundary check, not a syscall, so no KERNEL_ABI change; adds EXECUTION_DENIED (EVENT_SCHEMA 1.12.0).
- **Live Query** (`L2`): Pure read-model — no syscall, no event type (P10). L2 (tested; not yet wired into a shipped example path).
- **MCP Apps `ui://` Egress** (`L2`): ADR 0072 D4/D5 — egress only; the host role (iframe, CSP, postMessage) is rejected for this repo (D2). No per-flow HTML: the rendered UI is a pure function of (pinned template hash, logged structuredContent), and the pin uses the SAME hashResourceBody the ingress side applies, so a plan-time pin equals what a reader recomputes (ADR 0063 D1). Egress redaction is required-by-configuration, never defaulted.
- **MCP Dynamic Dispatch** (`L2`): ADR 0063 — plugin placement per the ADR 0043 litmus (vendor-specific). Canonical hashing lives in @loom/core (one implementation for drift check + registry change detection). MCP_DISPATCHED/MCP_UI_OBSERVED are userspace domain events (fold skips unknown types — no EVENT_SCHEMA bump). ADR 0072 follow-up (plugins/mcp/src/uiDispatch.test.ts): the ingress UI layer was reachable only from McpClient, because every step seam dispatched through the projection that erases `_meta` — asserted now through the EFFECT, which is the level a flow actually traverses.
- **MCP Server** (`L2`): ADR 0072 D7 — the prerequisite the MCP Apps work sits on (loom previously spoke MCP as a client only). The UI extension gives the SERVER no in-band audience signal, so `audienceOf` is deployment-supplied and defaults to "model": absent an explicit boundary, app-only tools stay unreachable rather than silently open.
- **Placement Adapters** (`L2`): SPI is L5, but only local/remote/CloudRun adapters exist; K8s/Lambda/GPU are demand-driven (#72) → the adapter set is L2.
- **Saga / Compensation** (`L2`): NO new syscall/event type/fold change (P10 win; the plan's ctx.compensate syscall + COMPENSATION_* events proved unnecessary — compensators run as replay-guarded ctx.run steps). KERNEL_ABI stays 1.1.0. Verified crash-safe by a DST no-double-compensation property.
- **Sandboxed Reshaping Executor** (`L2`): ADR 0064 — engine choice: quickjs-emscripten (capability-EMPTY VM vs @loom/isolate's subtractively-scrubbed child process; the isolation CONTRACT follows IsolatedToolSpec). idempotent:true (pure function of script+input); resource kills are typed so replay never re-burns CPU. Written once, audited once — the security test list is the audit's executable form.
- **Shard Rebalancing** (`L2`): ADR 0075 — builds on 0074. Minimal-movement is asserted exactly (a naive `bucket % shardCount` moved 80-89% of buckets); reads fall back to the previous plan until a bucket drains.
- **Step Identity & Interpreter Pattern** (`L2`): No kernel changes — a documented contract + compiler lint (tools/compiler loopIdentity.ts, surfaced via @loom/verify's determinism rule) + crash-matrix tests. Dynamic steps are deliberately outside flowContentHash (K11.1 covers the compiled skeleton only).
- **Storage Scale-Out Decorators** (`L2`): ADR 0074 — capability in packages, optimization in plugins. L2 not L4: the committed bench (tools/bench-throughput) measures the LOG, not these decorators specifically, so the L4 bar is not met on this capability's own evidence.
- **Tamper-Evident Audit Chain** (`L2`): L2 (stable + tested, incl. a DST crash/recovery integrity property) — not yet wired into a shipped example/defineConfig path, so not L3; no version constant (a composable wrapper, not a wire contract).
- **Typed Failure Channels** (`L2`): NO new syscall — TypedFailure is a userspace throw caught at the execute seam (KERNEL_ABI stays 1.1.0, the saga/ctx.compensate precedent). EVENT_SCHEMA 1.17.0: additive STEP_FAILED {channel, payload}. Undeclared channels keep legacy at-least-once retry semantics (G2).
- **GPU Worker** (`L0`): Concept only — there is NO gpu-worker package. Demand-driven (#72). A hand-assigned 'L1' would be a badge that lies; evidence-derived it is L0.
