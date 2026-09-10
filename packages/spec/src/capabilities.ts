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
    id: "cancellation-deadlines",
    title: "Cancellation, Deadlines & Bounded Effects",
    package: "@loom/workflow-runtime",
    level: "L3",
    summary:
      "The kernel's kill path, end to end (K8). `EffectContext.signal` reaches every effect and the built-in LLM/tool/A2A effects forward it to providers; `ExecutionRuntime.cancel(executionId)` fences then appends a durable `EXECUTION_CANCELLED` that replay reconstructs at the same sequence; declared deadlines (`ExecutionPolicy.deadlineMs`, step `timeoutMs`) are enforced BY THE KERNEL against the logged `EXECUTION_STARTED`, never wall-clock at re-run; cancellation crosses the dispatch seam (`WorkerRuntime.cancel`, worker-server `POST /cancel`) as best-effort delivery with durable-fact settlement; and `streamTokenBudget` severs a streaming generation mid-flight on an estimated token budget, emitting the same `QUOTA_EXCEEDED` fact metering writes.",
    evidence: {
      conformanceTest: "packages/workflow-runtime/src/k8-cancellation.test.ts",
      usedIn:
        "plugins/worker-server/src/crossSeamCancel.integration.test.ts — cancellation across the dispatch seam; packages/middleware/src/streamTokenBudget.test.ts — K8.4 mid-stream severance",
    },
    note: "ADR 0020 — every other K3 enforcement point is ADMISSION CONTROL (it decides whether the next effect runs); K8.4 is the only one that acts inside a call already in flight, which is why it waited on streaming effects and landed only with ADR 0087's series. A5 predicted it could not be middleware (right — middleware sees the effect once, at the end) and proposed an `EffectContext` usage-reporter hook (wrong — both wired providers report usage once, at the end, so such a hook could only fire where metering already reads the number). What ships observes the only thing a stream reports continuously, its own output, and names the estimate AS an estimate in the type, the reason and the default. Not L4: no committed bench — the acceptance criterion is a latency claim (<1s) that no bench pins, and provider forwarding is best-effort anyway (A7), so the honest ceiling is L3 via the cross-seam integration.",
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
    id: "blueprint-conformance",
    title: "Blueprint Conformance",
    package: "@loom/blueprint-runtime",
    level: "L3",
    summary:
      "validateBlueprint checks a composed blueprint against a declared widget catalogue (closure + bindings-not-data + silent-omission checks, findings never throws); catalogCoverage checks the other direction, that a renderer implements everything the catalogue declares.",
    evidence: {
      conformanceTest: "packages/blueprint-runtime/src/catalog.test.ts",
      usedIn: "loom-examples: db-observability composes per question and validates its own output",
    },
    note: "ADR 0088 (W1a–W1e); ADR 0094 adds the cross-tree half — `preservesNodes` / `blueprintNodeIds`, which report which node ids a structural change DROPPED, the failure a single-tree validator cannot see. Its second consumer is the a2ui bridge's `identityDiff`, and being a real one changed the API: id sets rather than blueprints, because A2UI components are a flat list. Pure functions over JSON-serializable values — no syscall, no event type, KERNEL_ABI/EVENT_SCHEMA untouched (P10). The catalogue vocabulary is the APP's (the ADR 0084 pattern); builtinCatalog is loom's own eight widgets, not a mandate. catalogCoverage is wired into plugins/renderer-react's suite and immediately found the live gap it was written for — WidgetKind declared 8 kinds, defaultRegistry registered 5, and a test ASSERTED the placeholder string, pinning it as intended. The same hole existed twice on the a2ui egress path — the bridge stamped a catalogId it never checked, and callFunction was never compared to the catalogue's declared `functions`; both are now refusals, and `recompose()` finally produces the `updateComponents` message whose payload type shipped with no producer. Also W1d (optional stable `id` on all 8 builders — the derived id re-identifies a node on every prop edit) and W1e (`by` provenance on SurfacePatchPayload + surfaceProvenanceProjection; SURFACE_PATCH is a userspace event so EVENT_SCHEMA is untouched, and the bridge never forwards `by` to a viewer). L2 → L3 once `db-observability` called it: the one example that COMPOSES a blueprint per question, from an agent's widget selection, with nothing looking at the result before a renderer does. It validates clean on all four topics — so the evidence is the negative case, a test that reuses a topic's primary widget as a WHY widget and gets `duplicate-node-id` (ids are derived from content, so the same entry built twice collides on the renderer's key and one silently replaces the other). Without that, a validator wired to nothing looks identical to one that passes. ADR 0095 (accepted 2026-09-10, implementation immediately following) extends the same surface to the DATA axis: the address freezes a binding's NAME while the projection behind it is unversioned live code, so a declared `version` is compared by `checkVersionPins` and the recorded pin rides in `Blueprint.projectionVersions`, INSIDE the content address. Its second consumer is `ReadModelService.checkPins` — an unversioned extractor is a live defect there, not a hypothetical.",
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
      "Spawn child workflows and durably await their results via decide/suspend/resume + a completion-correlating supervisor — one child (awaitChild, throws childFailed on failure), a concurrent group (awaitChildren, wait-all settled ChildResult[] in input order), or the all-or-nothing awaitAll (unwrapped outputs, throws on any failure).",
    evidence: {
      conformanceTest: "packages/orchestration/src/parallelChildren.test.ts",
    },
    note: "Composed from existing primitives — NO new syscall or event type (P10 win; the plan's CHILD_COMPLETED governed event proved unnecessary). L2; single-child and concurrent fan-out both land on the one suspend/resume cycle, and child failure propagates — awaitChild throws (composing up the tree), awaitChildren settles per-child for the parent to weigh.",
  },
  {
    id: "sandbox-eval",
    title: "Sandboxed Reshaping Executor",
    package: "@loom/plugin-sandbox",
    level: "L2",
    summary:
      "QuickJS-in-WASM eval of content-addressed, LLM-authored reshaping scripts: in-engine memory/CPU/wall-clock limits, no ambient I/O by construction, output shape-hash validation — typed scriptMissing/limitExceeded/shapeMismatch channels. Opt-in worker-thread evaluation keeps a synchronous eval off the caller's event loop and adds the hard kill the in-engine guards cannot do.",
    evidence: {
      conformanceTest: "plugins/sandbox/src/sandbox.test.ts",
    },
    note: "ADR 0064 — engine choice: quickjs-emscripten (capability-EMPTY VM vs @loom/isolate's subtractively-scrubbed child process; the isolation CONTRACT follows IsolatedToolSpec). idempotent:true (pure function of script+input); resource kills are typed so replay never re-burns CPU. Written once, audited once — the security test list is the audit's executable form. ADR 0089 adds an opt-in worker pool (`workers`, off by default): both engines share ONE `evalInFreshRuntime`, so the 0064 security list is parameterized over them rather than copied, and the pool contributes what the in-engine guards structurally cannot — a hard kill for a script that never reaches the interrupt handler (measured: 790ms against a 50ms wall clock, one interrupt callback). Pool evidence: plugins/sandbox/src/workerPool.test.ts.",
  },
  {
    id: "mcp-dynamic-dispatch",
    title: "MCP Dynamic Dispatch",
    package: "@loom/plugin-mcp",
    level: "L2",
    summary:
      'ONE registered `mcp.invoke` effect; tool name/args/schema-pin are runtime data on dynamically-minted steps. Pinned jsonSchemaHash verified per call → typed schemaDrift/toolNotFound channels; principals ride ctx.principal/secretRef, never the log; MCP_DISPATCHED indexed by projection. Opt-in `resultFidelity: "full"` yields the whole CallToolResult, and a UI-bearing result records MCP_UI_OBSERVED with an explicit four-state pin.',
    evidence: {
      conformanceTest: "plugins/mcp/src/mcpInvoke.test.ts",
    },
    note: "ADR 0063 — plugin placement per the ADR 0043 litmus (vendor-specific). Canonical hashing lives in @loom/core (one implementation for drift check + registry change detection). MCP_DISPATCHED/MCP_UI_OBSERVED are userspace domain events (fold skips unknown types — no EVENT_SCHEMA bump). ADR 0072 follow-up (plugins/mcp/src/uiDispatch.test.ts): the ingress UI layer was reachable only from McpClient, because every step seam dispatched through the projection that erases `_meta` — asserted now through the EFFECT, which is the level a flow actually traverses.",
  },
  {
    id: "effect-mode-boundary",
    title: "Effect Mode Boundary (journaled vs ambient)",
    package: "@loom/effect-runtime",
    level: "L2",
    summary:
      "`tool$({ mode })` declares which side of the determinism boundary a tool may be invoked from. `execute` refuses an `ambient` effect; `invokeTransient` refuses a `journaled` one (EffectModeViolationError). Undeclared effects are byte-identical on both seams (G2).",
    evidence: {
      conformanceTest: "packages/effect-runtime/src/effectMode.test.ts",
    },
    note: "ADR 0073 — a boundary CHECK at the execute seam, not a journaling mode: KERNEL_ABI stays 1.1.0, no event type, one replay model. The rejected alternative (ambient = 'skip the journal inside an execution') is DE-2's durability class, a second semantic model inside one execution. Enforced by the entry point, not by context contents, so a transient-looking hand-built context cannot spoof it.",
  },
  {
    id: "mcp-server",
    title: "MCP Server",
    package: "@loom/plugin-mcp",
    level: "L2",
    summary:
      "Serves loom tools/resources over MCP JSON-RPC (initialize / tools/list / tools/call / resources/list / resources/read) — the A2AServer analogue for the MCP ecosystem. Audience-scoped listing and dispatch; app-originated calls to `journaled` tools denied by default.",
    evidence: {
      conformanceTest: "plugins/mcp-app/src/mcpApp.test.ts",
    },
    note: 'ADR 0072 D7 — the prerequisite the MCP Apps work sits on (loom previously spoke MCP as a client only). The UI extension gives the SERVER no in-band audience signal, so `audienceOf` is deployment-supplied and defaults to "model": absent an explicit boundary, app-only tools stay unreachable rather than silently open.',
  },
  {
    id: "mcp-apps-ui-egress",
    title: "MCP Apps `ui://` Egress",
    package: "@loom/plugin-mcp-app",
    level: "L2",
    summary:
      "Projects a loom agent surface onto MCP Apps (SEP-1865) as ONE static content-pinned surface-host template whose payload is the existing A2UI catalog model, plus an `ambient`/app-visibility surface cursor tool over EventStore.readRange that substitutes for the extension's missing server push.",
    evidence: {
      conformanceTest: "plugins/mcp-app/src/mcpApp.test.ts",
    },
    note: "ADR 0072 D4/D5 — egress only; the host role (iframe, CSP, postMessage) is rejected for this repo (D2), and D8 declines to package one as 3P until a real consumer needs it — it implements no seam, and the part that IS Loom-shaped is pin verification, not sandboxing. No per-flow HTML: the rendered UI is a pure function of (pinned template hash, logged structuredContent), and the pin uses the SAME hashResourceBody the ingress side applies, so a plan-time pin equals what a reader recomputes (ADR 0063 D1). Egress redaction is required-by-configuration, never defaulted.",
  },
  {
    id: "content-batch-resolution",
    title: "Batched Content Resolution",
    package: "@loom/plugin-content",
    level: "L4",
    summary:
      "ContentStore.getMany (CONTENT_STORE_SPI_VERSION 1.2.0) + batch-scoped two-phase resolution: one round-trip per read batch, plus a byte-budgeted cache-forever LRU decorator (delete evicts first).",
    evidence: {
      conformanceTest: "plugins/content/src/contentStoreConformance.test.ts",
      bench: "plugins/content/src/content.bench.ts",
    },
    note: "TS-10 (ADR 0062) — the read-side sequel to ADR 0059's putStream. Optional-method + conformance-skip idiom; interactive budget p95 ≤ 150ms for ≤ 50 refs (asserted in batchedResolution.test.ts against an injected-latency backend).",
  },
  {
    id: "storage-scale-out",
    title: "Storage Scale-Out Decorators",
    package: "@loom/event-runtime",
    level: "L2",
    summary:
      "CoalescingEventStore (cross-execution append batching, per-row fencing preserved) and ShardedEventStore (hash-routed fan-out over N backends) as EventStore DECORATORS — so a BYO store inherits scale-out without implementing it (EVENT_STORE_SPI 1.3.0 appendBatch, optional-with-fallback).",
    evidence: {
      conformanceTest: "packages/event-runtime/src/scaleDecorators.test.ts",
    },
    note: "ADR 0074 — capability in packages, optimization in plugins. L2 not L4: the committed bench (tools/bench-throughput) measures the LOG, not these decorators specifically, so the L4 bar is not met on this capability's own evidence.",
  },
  {
    id: "shard-rebalancing",
    title: "Shard Rebalancing",
    package: "@loom/event-runtime",
    level: "L2",
    summary:
      "Virtual buckets + minimal-movement reassignment + lazy drain, so a sharded log can grow its shard count without a stop-the-world migration and without a coordinator.",
    evidence: {
      conformanceTest: "packages/event-runtime/src/shardRebalance.test.ts",
    },
    note: "ADR 0075 — builds on 0074. Minimal-movement is asserted exactly (a naive `bucket % shardCount` moved 80-89% of buckets); reads fall back to the previous plan until a bucket drains.",
  },
  {
    id: "classification-path-reach",
    title: "Classification Path Reach (array crossings)",
    package: "@loom/classify",
    level: "L2",
    summary:
      "`[]` array-crossing segments in classification dot-paths, expanded once against the concrete value (expandPaths) so telemetry masking, field-level encryption and content externalization all reach marks inside array elements.",
    evidence: {
      conformanceTest: "packages/classify/src/expand.test.ts",
    },
    note: "ADR 0076 — closes a SILENT gap: a sensitive() mark inside an array element collected no path, so it was masked nowhere, encrypted nowhere, externalized nowhere. The @loom/verify `classification-reachability` rule now covers only what remains unaddressable (record/union/tuple/intersection).",
  },
  {
    id: "untrusted-content-integrity",
    title: "Untrusted-Content Integrity Axis",
    package: "@loom/classify",
    level: "L2",
    summary:
      "`tainted(value, origin)` attaches provenance to a VALUE at ingress (plain JSON, so it survives the log and replay). `guardRequest` REFUSES tainted content in system / assistant / tool-description position and fences it in a `user` message, and it runs at every site that hands a request to an `LlmProvider`: `createLlmEffect`, `AgentRunner.complete`, and `ReasoningRuntime.call`. Producers (both opt-in): `registerMcpInvoke({ taintResults })` taints the whole result; `A2APeerClient({ taintResults })` taints `content` only, its flag's literal type selecting the output type.",
    evidence: {
      conformanceTest: "packages/llm/src/untrusted.test.ts",
      usedIn:
        "packages/agent/src/promptBoundary.test.ts + packages/reasoning/src/promptBoundary.test.ts — the agent and reasoning paths, each asserted to fence a tainted tool result and refuse a tainted description; plugins/mcp/src/taintedIngress.test.ts — a real flow whose MCP tool returns an injection payload",
    },
    note: "ADR 0085 — a value wrapper, NOT a fourth schema marker: confidentiality is a property of a field (static, forever), integrity is a property of a value (acquired at runtime from a specific origin), and a marker that guesses reads as coverage. The check is unconditional because a gate defaulting to off protects exactly the apps that never think about it; the opt-in sits on the producer, where tainting changes the output shape. The REFUSAL is structural; the FENCE is a label a model can be talked across — do not sell the second as the first. AMENDED (R2, 2026-08-18): this entry previously said the guard ran inside every `createLlmEffect` — true, and not load-bearing, because `createLlmEffect` had NO production consumer while `AgentRunner` and `ReasoningRuntime` called `provider.complete` directly. The agent path additionally ERASED the evidence (`JSON.stringify` flattened the envelope, so `isTainted` was false downstream and no later guard could recover the origin). Both paths now guard; the erasure is fixed by re-tainting the serialized body.",
  },
  {
    id: "durable-agent-loop",
    title: "Durable Agent Loop",
    package: "@loom/agent",
    level: "L2",
    summary:
      "`agentLoop$(ctx, config, input)` runs a ReAct loop from a RUNNER BODY, one durable frame per turn: ids minted `#turn:<i>` / `#turn:<i>:tool:<j>` per the ADR 0061 identity rule, the model call resolved through the EffectRuntime by `modelToolId` (so K2, metering, retry, idempotency and `guardRequest` all apply), and `requireApproval` parking the execution on a gate BEFORE a destructive tool runs. `agentStep$` is retained as the cheap opaque form — one frame instead of 2N.",
    evidence: {
      conformanceTest: "packages/agent/src/agentLoopCrash.test.ts",
      usedIn:
        "packages/agent/src/agentLoopApproval.test.ts — mid-loop HITL parking before the effect, approved and refused",
    },
    note: "ADR 0087 — nothing was missing from the kernel; the loop was on the wrong side of it. A step handler receives `StepHandlerContext` (emit, and nothing else), so 40 model calls were ONE frame, approval had to be hoisted out of the agent, and DECISION_RECORDED was hand-emitted in a shape @loom/learning cannot evaluate. Per-turn durability grows the log with conversation length: the two mitigations already ship (ADR 0054 claim-check for bytes, TieredMemory summarization for turns), and the summarize pass is deliberately NOT wired yet because a lossy nondeterministic summary must be journaled to stay replay-safe. Skill selection is likewise left out until it can go through ctx.decide.",
  },
  {
    id: "runner-body-reach",
    title: "Runner-Body Reach Analysis",
    package: "@loom/compiler",
    level: "L2",
    summary:
      "`analyzeRunnerReach` reads a flow runner's ctx.run targets and ctx.suspend conditions, closing the 'reachable = DECLARED steps' bound that limited capability-compat, effect-class and suspension-safety. Targets it cannot resolve are REPORTED, so each rule states its own coverage instead of reporting clean.",
    evidence: {
      conformanceTest: "tools/compiler/src/runnerReach.test.ts",
      usedIn:
        "packages/app/src/verify.test.ts — driven through defineConfig, with a control showing the bound",
    },
    note: "ADR 0086 — populating FlowSpec.suspends (which had NO producer) proved two suspension-safety checks wrong: the blanket correlationKey error was false (resume routes by executionId, nothing matches on correlationKey) and would have fired on most correct code; the wakeAt check is real only when no TimerStore is wired, since the runtime derives wakeAt from timeout when one is. A check nothing populates is also a check nobody can see is wrong.",
  },
  {
    id: "typed-resume-payloads",
    title: "Typed Resume Payloads",
    package: "@loom/workflow-runtime",
    level: "L3",
    summary:
      "Per-gate resume contracts (`flow$({ resumeSchemas })`) parsed BEFORE the append, so a wrongly-shaped resume is refused instead of becoming a permanent fold input; the parsed value is what is recorded. `ctx.suspend<T>` types the call site.",
    evidence: {
      conformanceTest: "packages/workflow-runtime/src/resumeSchemas.test.ts",
      usedIn: "loom-examples: all 19 ctx.suspend gate sites",
    },
    note: "ADR 0077 — the shape counterpart to K12.2's identity gate (which authenticates WHO may resume, never WHAT they send). KERNEL_ABI unchanged 1.1.0: no syscall added, and ctx.suspend's type parameter is erased. Opt-in by presence (G2).",
  },
  {
    id: "step-identity-guardrails",
    title: "Step Identity & Interpreter Pattern",
    package: "@loom/workflow-runtime",
    level: "L2",
    summary:
      "The ADR 0061 identity rule (durable-step ids are a pure function of logged inputs; dynamic ids minted `${id}#${index}`), linted by the compiler's analyzeLoopIdentity and pinned by the kernel's interpreter crash-matrix test.",
    evidence: {
      conformanceTest: "packages/workflow-runtime/src/interpreterLoop.test.ts",
    },
    note: "No kernel changes — a documented contract + compiler lint (tools/compiler loopIdentity.ts, surfaced via @loom/verify's determinism rule) + crash-matrix tests. Dynamic steps are deliberately outside flowContentHash (K11.1 covers the compiled skeleton only).",
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
    level: "L5",
    summary:
      "M5 working/episodic/semantic/procedural tiers with deterministic recall, over a versioned MemoryStore SPI with durable SQLite/Postgres backends and optional relevance search (ADR 0090).",
    evidence: {
      versionConstant: "MEMORY_STORE_SPI_VERSION",
      conformanceTest: "packages/memory/src/conformance.test.ts",
      usedIn: "loom-examples: runbook-recall, agent-network",
    },
    note: "ADR 0090/0091 — `search` is proven portable by FOUR independent implementations of one kit (in-memory IDF, SQLite FTS5, Postgres tsvector, and the 3P loom-plugin-vector's cosine similarity), which is what makes the seam a contract rather than a description of an inverted index. ADR 0091 took the SPI to 2.0.0: entry `id` (REQUIRED to round-trip, so the read-filter-replace fallback has something to match) plus the optional `remove`, because `search` ranks within one key while a document — the unit a corpus is actually edited in — is a subset of it. MAJOR because a backend that decomposes an entry into columns drops a field nobody told it to keep, which is silent in every case that only checks `content`. L3 → L5 once MEMORY_STORE_SPI_VERSION landed: the level bar is a versioned contract pinned by a conformance kit, and this seam is the first whose implementations live OUTSIDE this repo, which is what made an unversioned contract an actual hazard rather than a formality. As with every SPI here, nothing forces the constant to be bumped when the shape changes — the version is a declaration, the kit is the check.",
  },
  {
    id: "knowledge",
    title: "Document Corpora",
    package: "@loom/knowledge",
    level: "L3",
    summary:
      "KnowledgeBase over a memory tier: upsert/sync/remove by document, provenance-preserving prompt assembly, and decidable citation checking (ADR 0091).",
    evidence: {
      conformanceTest: "packages/knowledge/src/KnowledgeBase.test.ts",
      usedIn:
        "loom-examples: db-sentinel (a runbook corpus edited mid-year — a March finding replays to March's guidance after the corpus is emptied), runbook-recall (RAG, migrated off its hand-written chunker/prompt builder)",
    },
    note: "ADR 0091 — the package owns exactly one thing: the mapping from a DOCUMENT (the unit a corpus is edited in) to the PASSAGES it is searched in, so a revision supersedes its predecessor instead of duplicating it. Storage is `MemoryStore`'s, ranking is the backend's, reproducibility is `ctx.decide`'s, safety is ADR 0085's. NOT a seam: there is nothing to plug — an alternative KnowledgeBase would differ only in its manifest layout, and the seam it would need is one layer down. The second consumer (ADR 0083) is db-sentinel, chosen because it is UNLIKE the first: runbook-recall ingests once and asks once, where an append-only corpus and an upsertable one are indistinguishable — which is exactly how the gap this package closes survived ADR 0090.",
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
