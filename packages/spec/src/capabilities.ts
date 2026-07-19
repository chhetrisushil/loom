// ── Capability Maturity Model ────────────────────────────────────────────────
//
// A maturity level per kernel subsystem. Crucially, levels are NOT self-assessed — each
// capability declares the EVIDENCE that backs its level, and `spec.test.ts` asserts that
// evidence actually exists (the named version constant is exported; the named conformance
// test / bench file is present). So a badge can never claim more than the code proves — the
// maturity model is itself a fitness function.
//
// Level ladder (the reviewer's meanings), with the OBJECTIVE bar each requires:
//   L0 Concept accepted        — an ADR accepts it; may have no package yet.
//   L1 Experimental            — a package exists and builds.
//   L2 Stable implementation   — has a passing test suite.
//   L3 Production-ready        — tested AND exercised by an example/integration.
//   L4 Verified & benchmarked  — L3 + a committed bench (perf is measured, not assumed).
//   L5 ABI guaranteed          — a versioned contract (`*_VERSION`) pinned by a conformance test.

export type MaturityLevel = "L0" | "L1" | "L2" | "L3" | "L4" | "L5";

export const MATURITY_MEANINGS: Record<MaturityLevel, string> = {
  L0: "Concept accepted",
  L1: "Experimental implementation",
  L2: "Stable implementation",
  L3: "Production-ready",
  L4: "Verified & benchmarked",
  L5: "ABI guaranteed",
};

export interface CapabilityEvidence {
  /** Name of the exported `*_VERSION` constant that backs an ABI/SPI guarantee (required for L5). */
  versionConstant?: string;
  /** Repo-relative path to the conformance / pinning test proving the contract. */
  conformanceTest?: string;
  /** Repo-relative path to a committed bench proving performance (required for L4). */
  bench?: string;
  /** Free-text pointer to where it's exercised (example / integration) — for L3. */
  usedIn?: string;
}

export interface Capability {
  /** Stable id (kebab). */
  id: string;
  title: string;
  /** Owning package, or "—" for a concept with no package yet. */
  package: string;
  level: MaturityLevel;
  summary: string;
  evidence: CapabilityEvidence;
  /** Optional note — e.g. why a level differs from an intuitive guess. */
  note?: string;
}

/**
 * The registry. Levels are grounded in the evidence fields (validated by spec.test.ts).
 * Where an intuitive/proposed level over-claims, the honest evidence-derived level is used
 * and the delta is noted (e.g. "GPU Worker" has no package → L0, not L1).
 */
export const CAPABILITIES: readonly Capability[] = [
  {
    id: "workflow-runtime",
    title: "Workflow Runtime",
    package: "@loom/workflow-runtime",
    level: "L5",
    summary: "Execution model + the K1 kernel syscall ABI.",
    evidence: {
      versionConstant: "KERNEL_ABI_VERSION",
      conformanceTest: "packages/workflow-runtime/src/abi.test.ts",
    },
  },
  {
    id: "replay-vm",
    title: "Replay VM",
    package: "@loom/replay-vm",
    level: "L5",
    summary: "Deterministic fold + the K5 on-disk event-schema ABI.",
    evidence: {
      versionConstant: "EVENT_SCHEMA_VERSION",
      conformanceTest: "packages/replay-vm/src/eventSchema.test.ts",
    },
  },
  {
    id: "wire-abi",
    title: "Wire ABI",
    package: "@loom/wire-abi",
    level: "L5",
    summary: "T2 wire-protocol projection of the K1 syscalls + fold-vector conformance.",
    evidence: {
      versionConstant: "WIRE_ABI_VERSION",
      conformanceTest: "packages/wire-abi/src/wire-abi.test.ts",
    },
  },
  {
    id: "event-store",
    title: "Event Store SPI",
    package: "@loom/event-runtime",
    level: "L5",
    summary: "Durable append-only log SPI (in-memory / SQLite / Postgres).",
    evidence: {
      versionConstant: "EVENT_STORE_SPI_VERSION",
      conformanceTest: "packages/conformance/src/index.test.ts",
      bench: "packages/event-runtime/src/sequenceRange.bench.ts",
    },
  },
  {
    id: "snapshot-store",
    title: "Snapshot Store SPI",
    package: "@loom/snapshot-runtime",
    level: "L5",
    summary: "Point/latest/before snapshot SPI, bounding replay tail.",
    evidence: {
      versionConstant: "SNAPSHOT_STORE_SPI_VERSION",
      conformanceTest: "packages/conformance/src/index.test.ts",
    },
  },
  {
    id: "branch-registry",
    title: "Branch Registry SPI",
    package: "@loom/event-runtime",
    level: "L5",
    summary: "Fork/promote lineage DAG SPI (no merge, by design).",
    evidence: {
      versionConstant: "BRANCH_REGISTRY_SPI_VERSION",
      conformanceTest: "packages/conformance/src/index.test.ts",
    },
  },
  {
    id: "dispatcher",
    title: "Execution Dispatcher SPI",
    package: "@loom/dispatcher",
    level: "L5",
    summary: "Placement-agnostic dispatch/cancel/health SPI.",
    evidence: {
      versionConstant: "DISPATCHER_SPI_VERSION",
      conformanceTest: "packages/conformance/src/index.test.ts",
    },
  },
  {
    id: "verification",
    title: "Runtime Verification",
    package: "@loom/verify",
    level: "L4",
    summary: "Pre-flight determinism/replay/capability/placement/resource checks.",
    evidence: {
      conformanceTest: "packages/verify/src/verify.test.ts",
      bench: "packages/verify/src/verify.bench.ts",
    },
    note: "No ABI version constant (it is a tool, not a wire contract) → cannot be L5; L4 via its zero-overhead bench.",
  },
  {
    id: "dst",
    title: "Deterministic Simulation Testing",
    package: "@loom/dst",
    level: "L4",
    summary:
      "Seeded virtual clock + fault-injecting store/network that drive the kernel under adversarial schedules and reproduce/minimize any invariant violation.",
    evidence: {
      conformanceTest: "tools/dst/src/dst.test.ts",
      bench: "tools/dst/src/faultStore.bench.ts",
    },
    note: "Test/dev-only harness, not a wire contract → cannot be L5; L4 via its append-overhead bench. Production overhead is structurally zero (no runtime package imports it).",
  },
  {
    id: "audit-chain",
    title: "Tamper-Evident Audit Chain",
    package: "@loom/plugin-audit-chain",
    level: "L2",
    summary:
      "Hash-chained (optionally HMAC-signed) EventStore wrapper; verifyChain detects any edit/insert/reorder/drop. Fold-invisible — replay byte-identical.",
    evidence: {
      conformanceTest: "plugins/audit-chain/src/hashChain.test.ts",
    },
    note: "L2 (stable + tested, incl. a DST crash/recovery integrity property) — not yet wired into a shipped example/defineConfig path, so not L3; no version constant (a composable wrapper, not a wire contract).",
  },
  {
    id: "fair-scheduler",
    title: "Per-Tenant Fair Scheduler",
    package: "@loom/fair-scheduler",
    level: "L4",
    summary:
      "Drop-in Scheduler with weighted round-robin across tenants behind a concurrency cap; no tenant can starve another. Zero-overhead Infinity fast path.",
    evidence: {
      conformanceTest: "packages/fair-scheduler/src/fairScheduler.test.ts",
      bench: "packages/fair-scheduler/src/fairScheduler.bench.ts",
    },
    note: "Implements the existing Scheduler interface (drops into any consumer); L4 via its Infinity-fast-path bench. Not L5 — the scheduler is ephemeral, not a durable/wire contract.",
  },
  {
    id: "execution-authz",
    title: "Execution-Lifecycle Authorization",
    package: "@loom/workflow-runtime",
    level: "L2",
    summary:
      "Pluggable ExecutionAuthorizer gating start/resume/cancel/query at the trust boundary; denied resume/cancel record a durable EXECUTION_DENIED audit fact.",
    evidence: {
      conformanceTest: "packages/workflow-runtime/src/c1-lifecycle-authz.test.ts",
    },
    note: "L2 (tested; opt-in, byte-identical when unwired). Enforced only when a call carries a principal (trust-boundary model) — a boundary check, not a syscall, so no KERNEL_ABI change; adds EXECUTION_DENIED (EVENT_SCHEMA 1.12.0).",
  },
  {
    id: "live-query",
    title: "Live Query",
    package: "@loom/live-query",
    level: "L2",
    summary:
      "Read current folded state and subscribe to updates on an in-flight execution, over loadState + EventStore.subscribe.",
    evidence: {
      conformanceTest: "packages/live-query/src/liveQuery.test.ts",
    },
    note: "Pure read-model — no syscall, no event type (P10). L2 (tested; not yet wired into a shipped example path).",
  },
  {
    id: "orchestration",
    title: "Child-Workflow Orchestration",
    package: "@loom/orchestration",
    level: "L2",
    summary:
      "Spawn a child workflow and durably await its result via decide/suspend/resume + a completion-correlating supervisor.",
    evidence: {
      conformanceTest: "packages/orchestration/src/orchestration.test.ts",
    },
    note: "Composed from existing primitives — NO new syscall or event type (P10 win; the plan's CHILD_COMPLETED governed event proved unnecessary). L2; single-child await today (fan-out is a follow-up).",
  },
  {
    id: "typed-failure-channels",
    title: "Typed Failure Channels",
    package: "@loom/workflow-runtime",
    level: "L2",
    summary:
      "Contracts declare `errors:` channels; a TypedFailure on a declared channel is logged with its validated payload and SUBSTITUTED on replay — flows branch on failure deterministically.",
    evidence: {
      conformanceTest: "packages/workflow-runtime/src/typedFailure.test.ts",
    },
    note: "NO new syscall — TypedFailure is a userspace throw caught at the execute seam (KERNEL_ABI stays 1.1.0, the saga/ctx.compensate precedent). EVENT_SCHEMA 1.17.0: additive STEP_FAILED {channel, payload}. Undeclared channels keep legacy at-least-once retry semantics (G2).",
  },
  {
    id: "saga",
    title: "Saga / Compensation",
    package: "@loom/saga",
    level: "L2",
    summary:
      "Register compensators as a flow progresses; run them in reverse on failure. Compensators are ordinary ctx.run steps, so rollback is replay-safe.",
    evidence: {
      conformanceTest: "packages/saga/src/saga.test.ts",
    },
    note: "NO new syscall/event type/fold change (P10 win; the plan's ctx.compensate syscall + COMPENSATION_* events proved unnecessary — compensators run as replay-guarded ctx.run steps). KERNEL_ABI stays 1.1.0. Verified crash-safe by a DST no-double-compensation property.",
  },
  {
    id: "scheduler",
    title: "Cooperative Scheduler",
    package: "@loom/scheduler",
    level: "L4",
    summary: "Bounded concurrency + priority; zero-overhead-when-unwired.",
    evidence: {
      conformanceTest: "packages/scheduler/src/scheduler.test.ts",
      bench: "packages/scheduler/src/scheduler.bench.ts",
    },
  },
  {
    id: "reasoning-router",
    title: "Reasoning Router",
    package: "@loom/reasoning",
    level: "L4",
    summary: "M3 model routing/elevation with O(1) ranked selection.",
    evidence: {
      conformanceTest: "packages/reasoning/src/ReasoningRuntime.test.ts",
      bench: "packages/reasoning/src/routing.bench.ts",
    },
  },
  {
    id: "projection-runtime",
    title: "Projection Runtime",
    package: "@loom/projection-runtime",
    level: "L4",
    summary: "Fold events into read-model surfaces; coalescing + bounded retention.",
    evidence: {
      conformanceTest: "packages/projection-runtime/src/InMemoryProjectionRuntime.test.ts",
      bench: "packages/projection-runtime/src/projectionStorm.bench.ts",
    },
  },
  {
    id: "analytics",
    title: "Analytics & Observability",
    package: "@loom/analytics",
    level: "L4",
    summary: "Read-only lenses: analyze / profile / introspect / decision graph / advisory.",
    evidence: {
      conformanceTest: "packages/analytics/src/analytics.test.ts",
      bench: "packages/analytics/src/analyze.bench.ts",
    },
  },
  {
    id: "decision-materialization",
    title: "Decision Materialization",
    package: "@loom/analytics",
    level: "L3",
    summary: "DecisionStore / DecisionGraph read-models over the log (ADR 0030).",
    evidence: {
      conformanceTest: "packages/analytics/src/decisions.test.ts",
      usedIn: "advisoryPipeline + loom introspect",
    },
    note: "Proposed as L4, but has no dedicated bench → evidence-derived L3.",
  },
  {
    id: "compiler",
    title: "Compiler",
    package: "@loom/compiler",
    level: "L3",
    summary: "handler$ extraction, flow-graph + non-determinism analysis, manifest.",
    evidence: {
      versionConstant: "COMPILER_MANIFEST_VERSION",
      conformanceTest: "tools/compiler/src/transform.test.ts",
      usedIn: "loom-starter, examples/*",
    },
    note: "Manifest schema is versioned but not conformance-PINNED like the semver ABIs → L3, not L5.",
  },
  {
    id: "memory",
    title: "Tiered Memory",
    package: "@loom/memory",
    level: "L3",
    summary: "M5 working/episodic/semantic/procedural tiers with deterministic recall.",
    evidence: {
      conformanceTest: "packages/memory/src/TieredMemory.test.ts",
      usedIn: "examples/db-command-center",
    },
  },
  {
    id: "placement-adapters",
    title: "Placement Adapters",
    package: "@loom/dispatcher + workers",
    level: "L2",
    summary: "WorkerRuntime SPI + local/remote/CloudRun adapters.",
    evidence: {
      conformanceTest: "packages/conformance/src/index.test.ts",
    },
    note: "SPI is L5, but only local/remote/CloudRun adapters exist; K8s/Lambda/GPU are demand-driven (#72) → the adapter set is L2.",
  },
  {
    id: "gpu-worker",
    title: "GPU Worker",
    package: "—",
    level: "L0",
    summary: "A GPU-backed WorkerRuntime adapter.",
    evidence: {},
    note: "Concept only — there is NO gpu-worker package. Demand-driven (#72). A hand-assigned 'L1' would be a badge that lies; evidence-derived it is L0.",
  },
];
