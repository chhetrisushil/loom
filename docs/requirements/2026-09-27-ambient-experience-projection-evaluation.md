# Ambient Experience Projection — placement evaluation (loom and loom-ui)

- Status: **Verdicts recorded. Kernel change: two bug fixes, no ABI change (corrected 2026-09-27,
  see below). Loom 1P: four small additive items, each with a named second consumer, plus two gated
  ones; two of the four (`emitOnce`, `startOnce`) are superseded by the kernel fixes. loom-ui: one new slice before 7, slices 7 and 8
  widened, two new slices (11, 12). Blueprint IR: one minor bump (2.5.0), one optional catalogue
  addendum, each with its own ADR.** Nothing here is built yet; this document records placements
  and a plan.
- Evaluates: [Ambient Experience Projection](2026-09-27-ambient-experience-projection.md), the
  maintainer's white paper. It describes a detached, durable process that watches committed agent
  responses, decides whether one deserves a visual, lifts it into a semantic description bound to
  recorded evidence, and lets a rendering runtime resolve that description per surface.
- Checked against: loom `main` at 1062441 (`KERNEL_ABI_VERSION = "1.1.0"` in
  `packages/workflow-runtime/src/abi.ts`, `EVENT_SCHEMA_VERSION = "1.18.0"` in
  `packages/replay-vm/src/eventHandlers.ts`, `EVENT_STORE_SPI_VERSION = "1.4.0"`, Blueprint IR
  2.4.0) and the sibling `loom-ui` repo at `main` f4a6b02 (after its PR #24). Paths below are loom
  paths unless prefixed `loom-ui/`.
- **Correction (2026-09-27).** This evaluation first placed both §2 defects outside the kernel
  ("kernel: none", with `emitOnce` and `startOnce` as 1P helpers). The maintainer ruled both into
  the kernel as bug fixes. Neither changes `KERNEL_ABI` (1.1.0).
  - The emit defect (§2.1) is fixed by [ADR 0102](../adr/0102-flow-emits-append-once.md): flow-level `ctx.emit` / `ctx.stream` / `ctx.ui`
    append once per execution. They are matched against the log by a content digest (never by
    timing), and an emit that cannot be matched is appended rather than dropped.
    `EVENT_SCHEMA` 1.18.0 → 1.19.0, and `emitOnce` is the alternative that ADR rejects (D6).
  - The duplicate-start defect (§2.2) is fixed by ADR 0103 (task L9): `start()` refuses a
    duplicate deterministic id before any effect runs, which makes `startOnce` redundant.

  The verdict rows below are amended to match. The rest of the document stands as written.
- Method: the ADR 0051 discipline — a placement verdict per mechanism (kernel / loom 1P / 3P / app
  / loom-ui / Blueprint IR), bias outward (P10), and the
  [second-consumer rule](../adr/0083-second-consumer-rule.md) before anything becomes loom 1P
  surface. **loom-ui is exempt from the second-consumer rule**: it builds each capability with a
  reference example first. Loom 1P is not exempt. Where the two working evaluations behind this
  document disagreed, §9 says so and rules.
- Builds on: the [Experience/Rendering Runtime evaluation](2026-09-21-experience-rendering-runtime-evaluation.md),
  the [loom-ui design](2026-09-21-loom-ui-design.md), the
  [Blueprint IR 2 design](2026-09-22-blueprint-ir-2-design.md) (§5.0 resolution at compile, §7
  roadmap), the [genUI migration design](2026-09-23-genui-migration-design.md) (§2.2, B5
  `mergeExperiences`), the [dynamic persona evaluation](2026-09-10-dynamic-persona-evaluation.md)
  and ADRs [0085](../adr/0085-untrusted-content-integrity-axis.md),
  [0092](../adr/0092-adaptive-operator-profiles-placement.md) and
  [0097](../adr/0097-blueprint-ir-2.md).

---

## 0. Verdict

| Tier | Verdict |
|---|---|
| **Kernel** | **Two bug fixes, no new mechanism** (corrected 2026-09-27). No syscall, no event kind; `KERNEL_ABI` stays 1.1.0 and `EVENT_STORE_SPI` stays 1.4.0. [ADR 0102](../adr/0102-flow-emits-append-once.md) makes flow-level emits append once per execution (`EVENT_SCHEMA` 1.18.0 → 1.19.0, one additive fold key). ADR 0103 refuses a duplicate deterministic-id `start()` before any effect runs. Every other durability, ordering, replay, idempotency, cancellation and authorization requirement in the paper resolves to an existing mechanism or to app code over one. |
| **Pre-existing loom defects** | Two, found by running code while evaluating (§2). **`ctx.emit` and `ctx.ui` re-append on every resume**, and **a duplicate `start()` with the same deterministic id runs its effects before the store refuses it, while `onEvent` fires for events that are never stored.** Neither needs an ABI change. Both would break the paper's idempotency and patch model if it were built the obvious way. Both are fixed in the kernel: [ADR 0102](../adr/0102-flow-emits-append-once.md) and ADR 0103. |
| **Loom 1P** | Four small additive items, none a new package: ~~`emitOnce`~~, ~~`startOnce`~~ (both superseded by the kernel fixes above), an evidence-contract check that generalises `@loom/knowledge`'s `checkCitations`, and recording the router's intent through `ctx.decide`. One correction: `DataBinding.sensitivity` gets a reader or is relabelled declaration-only. Two items are **gated, app first**: a value-level audience label, and cross-execution outcome attribution in `@loom/learning`. Second consumers are named per item in §7. |
| **App** | Most of the paper: the commit record (derived, §3.2), the augmenter's trigger, the gate's rules, supersession, time budgets and the evaluation metrics. |
| **3P** | A learned gate policy behind the existing `Policy` SPI (like `loom-plugin-linucb`); any cross-run result cache. |
| **loom-ui** | The experience layer and the rendering runtime: evidence-bound providers, surface profiles, fail-closed classification, message-anchored conversations, typed outcome types with per-surface resolvers, and a lifter SPI. Four of the paper's ten rendering-side mechanisms are Missing and six are Partial (§3). |
| **Blueprint IR** | `Layout.defer` (IR 2.5.0) and `WidgetSource.redacted` (the same minor, or its own), each with an ADR and a reader in both loom renderers. Optional: declared `actions` on `CatalogEntry` (an ADR 0088 addendum). No audience, evidence ids or conversation on the Blueprint. |

The short version: **loom already is the paper's "durable execution record" box, and the paper's
central claim — augmentation is a projection — is loom's own central design rule.** What loom
lacks is not a primitive. It is two footguns the paper's idempotency section would walk into, a
confidentiality label that travels with a value rather than a field, and one unrecorded routing
decision. What loom-ui lacks is larger: it cannot bind to recorded evidence at all today, and its
Experience is one level too low to hold the paper's experience types (§4).

## 1. The paper in one paragraph, and why it lands here

A root agent routes each request to a sub-agent; the sub-agent answers in prose. The paper adds an
**augmenter** that runs off the critical path: it observes a `response.committed` event, gates
(rules, then a small classifier, then generation), lifts the response into one of a closed set of
**experience types** (`Answer`, `Investigation`, `Comparison`, `None`) whose elements bind to
recorded tool outputs by reference, validates it (shape, evidence existence, classification
clearance per surface), and hands it to a **rendering runtime** that negotiates, resolves per
surface, patches the conversation and ranks augmentation below prose. User interaction comes back
as typed semantic intents through the root agent. The paper's four claims — augmentation is a
projection, visuals come from evidence not prose, agents assert experiences not components, the
default is silence — are all consistent with loom's rules. The work is in the details.

## 2. Two pre-existing loom defects the pattern exposes

Both were **probed by running code** against the built `dist/` of loom `main` 1062441. The probe
scripts (`emitprobe.mjs`, `uiprobe.mjs`, `dupstart.mjs`) are small in-memory runtimes; the outputs
below are verbatim.

### 2.1 `ctx.emit` and `ctx.ui` re-append on every resume

A flow re-runs from the top on resume ([architecture](../architecture.md),
[ADR 0057](../adr/0057-multi-gate-suspend-passthrough.md)). `execute` and `decide` short-circuit
against the fold. `emit` does not: `WorkflowContextImpl.emit`
(`packages/workflow-runtime/src/WorkflowContext.ts`) is a straight `journal.commit`, and
`ExecutionJournal.commit` (`packages/workflow-runtime/src/ExecutionJournal.ts`) has no replay
check. `ctx.ui` is built on `emit` (`createSurfaceEmitter` in the same file).

Probe — a runner that does `ctx.emit("response.committed", …)` then `ctx.suspend({ on: "go" })`,
resumed once:

```
EXECUTION_STARTED response.committed EXECUTION_SUSPENDED go EXECUTION_RESUMED response.committed EXECUTION_COMPLETED
```

Probe — the same with `ctx.ui.append("timeline", "x")`:

```
EXECUTION_STARTED SURFACE_PATCH{…append timeline "x"} EXECUTION_SUSPENDED go EXECUTION_RESUMED SURFACE_PATCH{…append timeline "x"} EXECUTION_COMPLETED
```

The surface folds to `["x", "x"]`.

**Why it matters here.** loom's recommended conversation shape is a long-lived execution parked on
a user-message gate ([ADR 0081](../adr/0081-long-lived-suspensions-no-promotion.md), the
[agent-runtime evaluation](2026-08-18-agent-runtime-placement-evaluation.md) §3.1). Under that
shape, turn 1's commit event is appended again on every later resume: N times by turn N. The
paper keys idempotency on the message id and prose hash "so duplicate commit events collapse". On
loom the duplicates are not an edge case; they are produced by construction. Meanwhile
[usage.md](../usage.md) describes `ctx.emit` as "durable, folded on replay" and `ctx.ui` as
"durable per patch", which reads as append-once.

**What is safe today:** an emit from inside an effect (it runs only when the step runs, and a
completed step is served from the log); `ctx.decide("commit:<msgId>", () => record)`, whose
`DECISION_RECORDED` is served on replay; or deriving the fact from existing events (§3.1).

**Placement.** Making `ctx.emit` replay-aware changes a syscall's meaning, which is a MAJOR under
the ABI's own rule, and ordinal matching of emits is fragile under data-dependent branching. **Do
not change the kernel.** In 1P: document the behaviour in `usage.md`, `cheatsheet-features.md` and
the `@loom/agent-surface` header; add a resume test that asserts the *log*, not the return value;
ship `emitOnce(ctx, key, type, payload)`, decide- or step-backed (§7). Whether `ctx.ui.append`
duplicating is a *bug* in `@loom/agent-surface` rather than a documentation gap is open for the
maintainer; the read here is that it is a bug (the rendered surface is deterministically wrong)
and fixable in 1P by routing `ctx.ui` through the same replay-safe path without touching `emit`.

> **Superseded (2026-09-27): [ADR 0102](../adr/0102-flow-emits-append-once.md).** The placement above was overruled. The fix is in the
> kernel, and it is a bug fix rather than a change of meaning. The ABI table already said `ui`
> drives "durable, replayable" surfaces, and `usage.md` already said emits are "folded on replay".
> A 1P `emitOnce` would fix only the call sites that remember to use it, and a forgotten site is a
> silent duplicate that no check can see. This section's objection to ordinal matching turned out
> to be right: in review, ordinal matching lost emits when concurrent branches interleaved
> differently on a re-run. ADR 0102 therefore matches emits by a digest of their content, and
> appends whenever it cannot prove a match. It records `emitOnce` as the rejected alternative,
> and covers a case this section did not: an emit made from inside an effect through a closure
> over `ctx`.

### 2.2 A duplicate `start()` with the same deterministic id runs effects twice before the store refuses it

The paper's idempotency is naturally spelled in loom as a deterministic execution id,
`aug:<msgId>:<hash>`. Probe — the same flow (one step calling a counting "model" effect) started
twice with `executionId: "aug:m1:h1"` against the in-memory async store:

```
first "completed"
second threw StorageWriteError Durable event write failed: duplicate sequence 0 for execution "aug:m1:h1": …
model calls 2 events EXECUTION_STARTED STEP_STARTED STEP_COMPLETED EXECUTION_COMPLETED
```

The log is idempotent; **the cost is not**. `WorkflowRuntime.start()`
(`packages/workflow-runtime/src/WorkflowRuntime.ts`) checks nothing before executing, and
`ExecutionJournal.commit` folds the envelope and fires `onEvent` synchronously *before* it enqueues
the durable append (its own comment: "live projection fold — synchronous, durability-independent").
So a duplicate start pays for its effects (one model call per duplicate trigger), and every
`onEvent` subscriber — live projections, `superviseChildren`, a read-model live tail — sees events
from a doomed run that never become durable. The phantom-`onEvent` half is read from the commit
order in the code; the double-effect half is the probe.

**Loom already contains the fix, privately.** `TimerService.startOccurrence`
(`packages/workflow-runtime/src/TimerService.ts`) does `loadState(id)` → return if present →
`acquireFence` → `start`. **Placement: 1P** — extract `startOnce(runtime, flow, input, { executionId })`
(§7). The cross-node check-then-start race remains; fencing narrows it and the store's sequence-0
uniqueness keeps the log correct. The residual cost is one wasted effect in a race, which is
acceptable if documented.

> **Superseded (2026-09-27): ADR 0103.** The fix is in the kernel. Only the kernel can order the
> sequence-0 write before the body runs, and `start()` itself refuses the duplicate, so
> `startOnce` is not built.

## 3. Mechanism by mechanism

Legend: **Has / Partial / Missing**. Size is the work on the side named: S (< 300 LOC with tests),
M (300–1000), L (1000–2500), XL (> 2500 or a new package).

### 3.1 The table

| # | Paper mechanism | loom | loom-ui | Placement | Size | Citations |
|---|---|---|---|---|---|---|
| 1 | `response.committed` event from the harness | **Partial** — every field but the message id is already a kernel fact if routing is recorded; the route is not | — | **App: derive, do not emit.** 1P: record the route (§3.2) | S | `packages/agent/src/agentLoop$.ts` (ADR 0087), `packages/orchestration/src/orchestration.ts`, `packages/intent/src/IntentRuntime.ts` |
| 2 | Evidence contract (claim markers → recorded outputs; a dangling marker is a defect) | **Partial** — stable ids exist (step id, `ContentRef`); the set-containment check exists for one namespace | — | ids: has. Check: **1P**, generalise `checkCitations`. Markers: app | S | `packages/knowledge/src/citations.ts`, [ADR 0054](../adr/0054-claim-check-middleware.md), [ADR 0061](../adr/0061-step-identity-interpreter-guardrails.md) |
| 3 | Detached, never-joined, causally linked augmenter | **Missing** as a spawn; the observer model is fully available | — | **App (observer).** A `spawnDetached` is not recommended (§9) | S app / M if built | [ADR 0058](../adr/0058-read-model-plugin.md), `packages/orchestration/src/orchestration.ts` |
| 4 | Augmenter model calls as recorded effects; experience runtime a deterministic function of the record | **Has** (effects, decisions); **Partial** (the "function of the record" claim needs pins) | planners already run on `ctx.decide` | App + existing mechanisms; pins per [ADR 0095](../adr/0095-binding-semantics-pin.md) | — | [ADR 0071](../adr/0071-read-only-replay-inspector.md), [ADR 0092](../adr/0092-adaptive-operator-profiles-placement.md) D2 |
| 5 | One record, causal order across the run tree | **Has** the store; a cross-run order is **Missing by design** | — | None. Causal references are app data | — | [ADR 0058](../adr/0058-read-model-plugin.md), [ADR 0074](../adr/0074-storage-scale-out-decorators.md), [scaling](../scaling.md) |
| 6 | Idempotency, supersession, time budgets | **Partial** | `anchorAugmentation` + `subject-superseded` (slice 8) | App + `startOnce` (1P) | S | §2.2, `packages/workflow-runtime/src/TimerService.ts` |
| 7 | Classification propagating from evidence; clearance per surface identity model | **Partial** — handling classes are field-level; no audience label; `DataBinding.sensitivity` has no reader | **Partial / Missing** — carried, never enforced; hydration serves by Experience, not audience | loom: app now, audience label **gated**; sensitivity reader-or-relabel **1P**. loom-ui: slice 7 | S (relabel) / M (label) / M–L (slice 7) | `packages/classify/src/classify.ts`, `packages/blueprint-runtime/src/types.ts`, `loom-ui/packages/hydration/src/split/server.ts` |
| 8 | Intents upward as untrusted, typed, authorised input | **Has** — `ExecutionAuthorizer`, `resumeSchemas`, taint | **Partial** — no intent domain, no typed intent schemas | App over loom; loom-ui slice 11 | M (loom-ui) | [ADR 0039](../adr/0039-execution-lifecycle-authz.md), [ADR 0077](../adr/0077-typed-resume-payloads.md), [ADR 0085](../adr/0085-untrusted-content-integrity-axis.md), `loom-ui/packages/planner/src/interaction.ts` |
| 9 | Tiered gate; learning from engagement | **Partial** — policy + propensity + SNIPS exist; outcome credit is same-execution only | `Gate` interface + rule-table reference (slice 12) | App (rules), 3P (learned), 1P gated (cross-execution credit) | S | [ADR 0079](../adr/0079-decision-context-and-policy.md), [ADR 0080](../adr/0080-learning-substrate.md), `packages/learning/src/trajectories.ts` |
| 10 | Cost levers: content-addressed cache, templates, compact format | **Partial** — `ContentStore`, no effect-result cache | **Partial** — artifacts content-addressed; `ResolutionCache` and the Assertion as the compact format are Missing | App / 3P (loom); slice 11 (loom-ui) | S–M | `plugins/content/src`, `loom-ui/packages/core/src/log.ts` |
| 11 | Evaluation metrics | **Partial** — every metric is cross-execution | `deferred-dropped` findings feed "share dropped" | App read lenses over `@loom/plugin-read-model` | — | [ADR 0058](../adr/0058-read-model-plugin.md) |
| 12 | Experience IR: semantic, closed, versioned, classified | — | **Partial** — closed and versioned per widget; carries layout; declares no intents; no multi-node types | loom-ui slice 11 (a new layer, §4) | XL | `loom-ui/packages/core/src/catalog.ts`, `loom-ui/packages/core/src/node.ts` |
| 13 | Binding by reference to **recorded** evidence | — | **Missing** — every provider executes a live MCP tool graph | loom-ui slice E | L | `loom-ui/packages/core/src/experience.ts`, `loom-ui/packages/hydration/src/provider.ts` |
| 14 | Admission validation (shape, evidence existence, clearance) | — | **Partial** — per-node validation; `unknown-handle` is only a warning; no clearance | loom-ui slices E / 7 / 11 | M | `loom-ui/packages/core/src/catalog.ts` (`validateExperience`) |
| 15 | Negotiation + per-type, per-surface resolvers | — | **Partial** — `Surface` is modality only; resolution is node → one kind | loom-ui slice 7 (`SurfaceProfile`), slice 11 (resolvers, `checkReduction`) | M + L | `loom-ui/packages/core/src/catalog.ts` (`resolveSurface`), [IR-2 design](2026-09-22-blueprint-ir-2-design.md) §5.0 |
| 16 | Patches attached to a message; deferred priority, collapse, drop | `SURFACE_PATCH` exists but is not keyed to experience nodes | **Has** (keyed recompose), **Missing** (message anchoring, presentation priority) | loom-ui slice 8 + **IR 2.5.0 `Layout.defer`** | L | `loom-ui/packages/renderer-lit/src/dom/renderBlueprintDom.ts`, [ADR 0101](../adr/0101-blueprint-ir-layout-ids.md), [ADR 0099](../adr/0099-blueprint-ir-layout-roles.md) |
| 17 | Adapters emit intents, never call tools | — | **Has** for tools (adapters have no invoker); **Partial** for intents | loom-ui slice 11; optional `CatalogEntry.actions` | M | `loom-ui/packages/renderer-lit/src/noHydration.test.ts`, `packages/blueprint-runtime/src/catalog.ts` |
| 18 | Augmenter selects templates, composes freely as fallback | `ctx.decide` fits | **Partial** — `Planner` machinery fits, its SPI does not | loom-ui slice 12 (`Lifter`) | L | `loom-ui/packages/planner/src/spi.ts`, `decision.ts` |

### 3.2 Notes on the loom rows

**Row 1 — derive the commit, do not emit it.** If the root agent routes through `ctx.decide` and
sub-agents run as children, the child's `EXECUTION_COMPLETED` (`{ content, toolCallLog }` from
`agentLoop$`) *is* the commit, and it is literally "emitted by the harness, not by each agent". Its
fields map as: prose hash = a pure function of the final `#turn:<i>` output; sub-agent identity =
the `flowId` in the recorded spawn choice; evidence refs = the turn's tool-call step ids
(`#turn:<i>:tool:<j>`, ADR 0061 D1) plus claim-check `ContentRef`s; message id = app. The one gap
is the **intent class**: `IntentRuntime.route()` runs outside any execution and `run()` starts the
chosen flow without recording the route — the same unrecorded-routing defect
[ADR 0087](../adr/0087-durable-agent-loop.md) fixed for `AgentRunner` (§6.3). Emit an explicit
commit event only where the answer is produced in-process inside a longer execution, and then
replay-safely (§2.1). Unknown domain event types are inert to the fold, so none of this needs an
`EVENT_SCHEMA` bump.

**Row 2 — the evidence contract is `checkCitations` over a different id space.** `@loom/knowledge`'s
`checkCitations` / `assertGrounded` computes *claimed ids ⊄ retrieved ids* and names the violation
the way the paper does. The paper's contract is the same set-containment check over claimed step
ids versus the step ids recorded in the turn. That is the same mechanism, not merely the same
motive, so it meets ADR 0083. Record a violation as a counted **finding**, not a throw (ADR 0088
D3; the paper's own "consistency violations" metric needs the count); if it must stop the turn, use
a typed failure channel ([ADR 0060](../adr/0060-typed-failure-channels.md)). It cannot be a
`@loom/verify` rule: markers exist only at runtime. The paper also never says what "existence"
means after retention: evidence cited by an admitted experience must outlive its run, which is the
K10.6 pin seam ([ADR 0055](../adr/0055-k10-6-pin-seam-content-gc.md), `retention.pinned`,
`pinByEventKinds`), while crypto-shredding and content GC are *allowed* to make it unresolvable
(`ContentMissingError`).

**Row 3 — observer, not child.** `awaitChild` / `awaitChildren` are joined by construction; the
supervisor starts a child only on the parent's `EXECUTION_SUSPENDED { on: CHILD_DONE }` and
reclaims unstarted specs when the parent terminates. Its state is in-memory with no catch-up path,
so an unjoined child lost in a crash would be lost silently. The observer model needs nothing from
the parent: a `@loom/plugin-read-model`-shaped trigger (live tail + catch-up scan + monotonic
per-execution watermarks, ADR 0058 D2), then `startOnce` with a deterministic id, a recorded
`cause: { executionId, sequence, eventId, chainHash? }` (the chain hash from
`plugins/audit-chain/src/hashChain.ts` makes the link tamper-evident), and a durability gate
before starting, because `onEvent` precedes the durable write (§2.2). The paper's "rotation" has no
loom referent (`rotate$` is deferred, [ADR 0052](../adr/0052-run-chaining-deferred-evidence-gate.md)).

**Row 4 — "a deterministic function of the record" is true only of a pinned fold.** The fold here
is the type catalogue, templates, admission rules and resolvers — all versioned, all expected to
change. Re-running a newer resolver over an old record is the substitution ADR 0071 refuses. So:
record the **admitted experience** as a content-addressed artifact and emit its ref (the
[composed-surfaces](../composed-surfaces.md) recipe, replay-safely), record the versions it was
admitted under (ADR 0095 `projectionVersions` / `checkVersionPins`, ADR 0096
`BLUEPRINT_IR_VERSION`), and treat per-surface resolution as reproducible only when the resolver
version is pinned or the resolved output is itself content-addressed. The paper's "resolved output
can be content-addressed" is load-bearing for its replay claim, not a cost lever. Anything
time-based (budgets, "moved on by several turns") enters as a recorded fact, never a render-time
comparison (ADR 0092 D3).

**Row 5 — causal order, not total order.** loom's log is per execution; ADR 0058 records that a
store-wide positioned feed would be a kernel change, and `ShardedEventStore` cannot provide one.
The paper asks for *causal* order ("not one writer appending to another's log"), which recorded
`(executionId, sequence)` references give as a partial order. A global sequence would cap the
write ceiling — the log is already the bottleneck at ~5.7K durable executions/s
([scaling](../scaling.md)) — to answer a question causal references already answer. The
augmenter writes its own log; the conversation view is a join. Writing augmentation patches into
the conversation's log would need a resume into a running execution, which the ingress gate
correctly refuses.

**Row 6 — idempotency, supersession, budgets.** The key needs two corrections (§9, item 6).
Supersession: deterministic ids make the pending augmentation addressable, and `runtime.cancel`
records a terminal `EXECUTION_CANCELLED`, but cancel races completion, so "discarded" must be a
**fold rule in the join** (admit iff the augmentation's key hash equals the latest committed hash
for that message), never a delete. Budgets: `deadlineMs` anchors to the augmentation's own
`EXECUTION_STARTED`, so after a backlog the budget silently stretches; compute the remaining budget
from the recorded commit timestamp through `ctx.decide` and pass it as `deadlineMs`, or
`sleepUntil(commitTs + budget)`.

**Row 7 — classification.** See §6.1 and §6.2.

**Row 8 — intents.** Re-entry is `start()` of a new turn or `resume()` of the conversation parked
on its gate. Both already authorise (ADR 0039; a denied resume records `EXECUTION_DENIED`), validate
against a declared schema before the append (ADR 0077 — mind that `z.object` strips unknown keys,
which changes what is persisted), and treat the intent as data, not instructions. The a2ui
`callFunction` grains ([ADR 0070](../adr/0070-a2ui-callfunction-bidirectional-rpc.md)) are the
template. Two additions: validate evidence ids in an intent against the set admitted for that
message (the §3.2 row 2 check again), and taint any evidence content re-entering a prompt (ADR 0085;
tainted content in a `user` message is fenced, not excluded).

**Row 9 — the gate.** A gate is a policy: `decideWithPolicy` / `ctx.decide` with
`policy: { id, version, propensity }` (ADR 0079), `trajectories` → `evaluatePolicy` → `promotionGate`
(ADR 0080). Three problems the paper does not see are in §9 item 7. On the delayed reward: start
with the app re-keying its own `engagement.recorded` events into outcome records before calling
`trajectories` (zero loom change). Do **not** add a field to `OUTCOME_RECORDED` — its fold
whitelists fields, so that would be an `EVENT_SCHEMA` minor for something a read lens can do. A
`TrajectoryOptions` hook for external outcomes is the gated 1P item (§7).

**Row 10 — cache.** A cache hit is legitimate on loom's terms only if it is **recorded as the step's
output** (then it is a cheaper effect implementation; replay serves the recorded value either way).
A cross-run *plan* cache was rejected as replay confusion (portfolio C5).

### 3.3 Notes on the loom-ui rows

**Row 13 — the largest gap.** `ProviderSpec` is only an MCP execution graph, and `executeProvider`
refuses anything else as `empty-graph` (`loom-ui/packages/hydration/src/provider.ts`). No provider
kind reads an already-recorded output. So loom-ui cannot bind to evidence, and a chart built by live
re-execution is the paper's rejected "re-derive" failure one step removed: the data can move
between commit and render. loom-ui's `replay` reproduces *structure*; hydration re-fetches *values*
live, deliberately ("Data has no version here", [loom-ui design](2026-09-21-loom-ui-design.md)
§3.2). The workaround to reject is a fake MCP tool whose "invoke" reads the content store: the spec
would claim a tool call that never happens, pin a meaningless schema hash, and put TTL semantics on
an immutable value. Build a provider-kind union instead (slice E, §8).

**Rows 14–15 — admission and resolution.** `validateExperience` checks prop keys and binding
presence per node; evidence existence and clearance are absent, and `unknown-handle` asks whether a
*provider spec* exists, not whether *recorded evidence* exists. Negotiation is compile-time and
modality-only (`Surface = "web" | "terminal" | "chat"`): no identity model, no late-update
capability, no density. `"chat"` has no adapter yet, and an embedded host iframe has no `Surface`
value. Resolution stays at compile, per the IR-2 ruling; §9 item 10 defends that against the
paper's runtime framing.

**Row 16 — patches.** Keyed recompose already preserves focus, caret and scroll across revisions
(slice 6a). P0/P1/P2 is *data-fetch* priority, a different axis from the paper's presentation
priority. No `conversation` or `message` concept exists anywhere in loom-ui, and an Experience's
`intent` is immutable, so a conversation is not naturally one lineage.

**Rows 17–18 — intents and the augmenter.** `interpretAction` splits `experience.op` from
"business"; the paper's intents are a third domain (conversational requests) that would today fall
into "business", untyped. Neither `SemanticEntry` nor loom's `CatalogEntry` declares which actions a
kind emits. The `Planner` machinery fits the augmenter (one `ctx.decide` per plan, bounded retry,
schema-derived contracts, tainted samples, conformance kit), and `planDecisionId` hashing every
prompt-shaping input *is* the paper's idempotency key. But `compose` authors an Experience from live
capabilities, and the augmenter must author an outcome description (or `None`) from recorded
evidence.

## 4. The semantic layer above Experience

### 4.1 Why today's Experience cannot express the paper's types

loom-ui's "semantic" is per **widget**, not per **outcome**. A node never names a visual kind (a
planner asserts "a `Trend` bound to handle h", never "a line chart"), but containers carry
geometry — `direction`, `span`, `row`, `rowSpan`, `column`, `role` — and the planner authors it;
`genesis` defaults to a 12-column grid precisely so a model's `span` lands. That is the "column
two" the paper forbids agents to assert. Three concrete limits:

1. **One node resolves to one kind.** `resolveSurface` follows `degradeTo` from node to node and
   ends at one `KindContract`. "Investigation → dashboard on web" is one type expanding into many
   widgets; no resolution variant expands a node into a subtree.
2. **One node binds one handle.** An `Investigation` binds N pieces of evidence, one per finding.
3. **Repetition is data.** "Findings" is a list whose length is data. The node tree has no
   iteration construct, and it should not get one.

Modelling `Investigation` as one catalogue entry whose web resolution is a custom element that
draws the whole dashboard smuggles the resolver into a renderer, gives up the per-surface closed
vocabulary and hides the evidence bindings inside props. Rejected under the grow-the-IR ruling.

### 4.2 Three layers, not two

| Layer | What it says | Who writes it | Where |
|---|---|---|---|
| **Assertion** | what should exist: a typed, closed, versioned outcome with slots and evidence refs | the augmenter (lifter) | loom-ui, new package (working name `@loom-ui/outcome`) |
| **Experience** | editable presentation: nodes, layout, providers | per-type, per-profile resolvers; users | loom-ui core (today) |
| **Blueprint** | rendering IR | `compile` | loom `@loom/blueprint-runtime` (today) |

The shape (working names):

```
OutcomeType { name, version, slots: zod, evidenceSlots, intents: Record<name, zod>,
              classification: (slots, evidence) => DataClass | undefined }
Assertion   { type, typeVersion, subject: { messageId, contentHash, intentClass },
              slots, evidence: Record<EvidenceId, EvidenceRef> }        // content-addressed
resolve(assertion, profile, resolvers) → Experience                    // pure, deterministic ids
```

Resolvers emit semantic node types and let `compile` resolve per modality, so duplication across
surfaces is limited to structure decisions (dashboard versus headline), which is exactly what should
differ. The paper's two layers (semantic IR → resolved output) are too few because user authorship
— its own open question — needs an editable presentation layer: moving or hiding a panel is neither
a semantic mutation nor an edit to rendered output, and without that layer every re-resolution
throws the user's layout away. The layer must not touch the Blueprint, own an event store, or
resolve at render time.

**Genericity check:** a support bot, a BI assistant and a code-review agent all answer in prose over
tool evidence. The types ship as a reference pack, not core, so an app can register its own.

## 5. Blueprint IR growth

Each is a loom PR with its own ADR, landed before the loom-ui PR that bumps `LOOM_REF` (the IR-2
pattern). Adding an ADR trips the ADR index, changelog coverage, doc citation and capability-registry
guards; budget for them. **Condition on every field:** it ships with a reader in both loom renderers
(React and terminal). `Layout.role` (ignored by the terminal and React renderers, ADR 0099 D5) and
`DataBinding.sensitivity` (§6.2) are IR fields loom itself never reads; that is the pattern to
avoid, and it is also why IR growth should answer ADR 0083's question even though loom-ui is exempt
from it.

| Change | Why a workaround will not do | Bump | Slice |
|---|---|---|---|
| `Layout.defer?: "deferred" \| "supporting"` (name to be decided) | Deferral and collapse are delivery semantics every adapter must honour, including one-shot text and broadcast chat, which cannot reflow. A `role` is honoured only by registered Lit container renderers ([ADR 0099](../adr/0099-blueprint-ir-layout-roles.md) D5), so it would degrade silently on two of three renderers. React: collapsed `<details>` for `supporting`, no reflow of primary content for late `deferred`. Terminal: deferred printed after primary with a marker, `supporting` on one line. | minor → **2.5.0** + ADR | 8 |
| `WidgetSource.redacted?` (`true` or `{ reason }`) | Slice 7's plan already names `source.redacted`, but `WidgetSource` today has only `type`, `version` and `degradedFrom`, so it is IR growth, not a compile-only change. | minor (may share 2.5.0 if the slice 7 and 8 loom PRs combine; otherwise its own) + ADR | 7 |
| *(optional)* `CatalogEntry.actions?: readonly string[]` | Makes the actions a kind emits declared contract, so a conformance test can hold loom's own renderers to it. ApprovalCard's `APPROVE` / `REJECT` is convention today. loom-ui can declare intents on `SemanticEntry` without it. | catalogue contract, [ADR 0088](../adr/0088-blueprint-conformance.md) addendum | 11 |

Deliberately **not** IR growth: audience or surface profile on the Blueprint (a surface property
resolved at compile, ADR 0097 D5 stands); evidence ids on widgets (the widget id is the join key,
evidence stays server-side like provider specs); classified props (evidence-derived text is bound,
not a prop, §6.1); conversation or message on the Blueprint (a message is a container with a layout
id; IR 2.4.0 suffices).

## 6. Corrections to prior decisions

### 6.1 ADR 0085 D1 — confidentiality is value-level for audience, field-level for handling

[ADR 0085](../adr/0085-untrusted-content-integrity-axis.md) D1 says "Confidentiality is a property
of a FIELD: `ssn` is sensitive in every execution, forever." That holds for loom's **handling**
classes — `@loom/classify`'s `secret` / `sensitive` / `internal` mean *never persist*, *encrypt at
rest and shred*, *never egress externally*, applied by three dot-path sinks
([ADR 0076](../adr/0076-wildcard-classification-paths.md)). It fails for **audience**: the same
`rows` field of the same SQL tool is public for one query and restricted for another (which table,
which tenant, which customer). The paper's "every tool output carries a classification" is the
second axis. **Correction:** confidentiality has two sub-axes — a field-level handling class
(existing, correct as is) and a value-level audience label (missing). Record the split before a
product builds audience as a fourth schema marker.

Shape, reusing loom's own precedents: **producer-assigned at acquisition** (like taint, ADR 0085
D4); **recorded, not recomputed** (recompute under newer rules is the ADR 0092 D2 substitution; a
tool may declare a label function beside its result schema, the ADR 0051 D3 declared-`digest`
precedent); **on the reference, not a wrapper on the value**, because the IR binds by reference —
`{ executionId, stepId, ref, label }`, with an element's label the strictest of the refs it binds
(`strictest()` already exists in `@loom/classify`); **enforced twice**, at admission and at delivery
(§9 item 5). Logs written before the producer started labelling are unlabelled and must be treated
as uncleared, not public (ADR 0085 D5's retrofit bound). Placement: app now; 1P is gated (§7).

### 6.2 `DataBinding.sensitivity` has no reader

`packages/blueprint-runtime/src/types.ts` documents the field as "Read by compilers and delivery;
never by renderers". Both working evaluations found that nothing reads it for enforcement: in loom
the only reader is the `sensitivity-unknown` spelling check in `packages/blueprint-runtime/src/catalog.ts`;
in loom-ui, `compile` copies it, the planner clamps a model's attempt to lower it
(`sensitivity-not-lowered`, a warning) and the prompt describes it. It is a textbook vacuous check:
a declared field that reads as coverage. A product built on this paper would assume it is enforced.
ADR 0097 D4 itself called it "a field, not an enforcement point", so the doc comment contradicts the
ADR. **Correction:** relabel the doc comment as declaration-only now (S, independent of this
paper); loom-ui slice 7 becomes the first enforcing reader for loom-ui-compiled Blueprints. A
delivery-side reader in loom itself is 1P surface and waits for a consumer outside loom-ui.

### 6.3 The router's intent is not recorded

`IntentRuntime.route()` (`packages/intent/src/IntentRuntime.ts`) runs outside any execution, and
`run()` starts the routed flow without recording the route. The paper's commit record needs "the
intent class the router assigned"; an unrecorded route can be neither replayed nor evaluated, which
is the argument ADR 0087 made when it fixed `AgentRunner`. **Correction:** route through
`ctx.decide` with policy and propensity (ADR 0079). App code until then:
`ctx.decide("route", () => intent.route(text))` in the root flow.

### 6.4 Smaller corrections

- **`usage.md`, `cheatsheet-features.md`, the `@loom/agent-surface` header** — "durable, folded on
  replay" / "durable per patch" omit the resume re-append (§2.1). The ERR evaluation's line that
  `SURFACE_PATCH` is "replayed by construction" is true of the fold and hides that the log
  accumulates duplicates.
- **Portfolio Part II G4** — `PatchProvenance = { by, note? }` (`packages/agent-surface/src/types.ts`)
  carries evidence only as free text. That meets "who placed this", not "every referenced piece of
  evidence exists". Not a reason to grow it now: evidence binds in the Assertion, not on patches.
- **ADR 0058 D4** — this paper is not the consumer that lifts the aggregate-read-model deferral: a
  per-message join fits the row model. Recorded so a later submission does not cite it for that.
- **loom-ui slice 7 as scoped** ("compile withholds") would leave the data path open:
  `handleInventory` / `serveHandles` derive the served set from the Experience, not the
  audience-compiled Blueprint (`loom-ui/packages/hydration/src/split/server.ts`), and `DataClass`
  has no "public" member, so absence passes. §8 widens slice 7 to close both.

## 7. Loom 1P items, with second consumers (ADR 0083)

| # | Item | Package | Second consumer / argument | Status | Size |
|---|---|---|---|---|---|
| L1 | Document emit/ui resume re-append; resume test asserting the log; rule bug-vs-docs for `ctx.ui.append` | docs + `workflow-runtime` / `agent-surface` tests | every suspending `ctx.emit` / `ctx.ui` caller | **ruled a bug; fixed in the kernel — [ADR 0102](../adr/0102-flow-emits-append-once.md)** | S |
| L2 | `emitOnce(ctx, key, type, payload)` (decide- or step-backed) | `workflow-runtime` or `agent-surface` | `@loom/agent-surface` `append` / `increment` callers; `BLUEPRINT_COMPOSED` emitters in the composed-surfaces recipe; ADR 0051 D4 findings emitters | **rejected — the kernel fix supersedes it (ADR 0102 D6)** | S |
| L3 | `startOnce(runtime, flow, input, { executionId })`, extracted from `TimerService.startOccurrence` | `workflow-runtime` | schedules (in-tree today); the orchestration supervisor's in-memory `started` set; domain argument: any trigger fed from an at-least-once source | **superseded — ADR 0103 (kernel)** | S |
| L4 | Evidence-contract check: generalise `checkCitations` over `readonly string[]`, recorded as a finding | `@loom/agent` (owns the turn's id space) | `@loom/knowledge` (shipped) — same mechanism | do | S |
| L5 | `DataBinding.sensitivity`: relabel declaration-only (a loom delivery reader only on a consumer outside loom-ui) | `blueprint-runtime` | vacuous-check fix; needs no second consumer as a relabel | do (relabel) | S |
| L6 | Record the router's intent via `ctx.decide` with policy and propensity | `@loom/intent` | `@loom/learning` (an unrecorded route cannot be evaluated); ADR 0087 precedent | do | S |
| L7 | Value-level audience label on evidence descriptors | `@loom/classify` | candidates: `@loom/knowledge` retrieval over corpora with per-document ACLs; loom's own surface egress, which can only mask by path. Domain argument is strong; still require the second implementation to show the same shape | **gated — app first** | M |
| L8 | External-outcome join in `trajectories` | `@loom/learning` | delayed, out-of-run reward in any intervention policy | **gated — app re-keying first** | S |
| — | `spawnDetached` in orchestration | — | none; the observer model serves the paper better | **not recommended** | (M) |

Kernel (corrected 2026-09-27): two bug fixes, no ABI change. [ADR 0102](../adr/0102-flow-emits-append-once.md) covers emits and ADR 0103 covers a duplicate start.

## 8. loom-ui slice plan

Every slice ships a capability plus a reference example in `loom-examples` that is **not** drawn from any
one product. Where the IR grows, the loom PR lands first. The roadmap today (IR-2 design §7) is
6a (shipped) → 6 → 6b → 6c → 7 → 8 → 9 → 10.

| Slice | Capability | Reference example | Proves | Size |
|---|---|---|---|---|
| **E (new, before 7)** | Evidence providers: `ProviderSpec` becomes a discriminated union with `{ source: { kind: "evidence", ref: EvidenceRef } }` (old specs parse as the graph variant and hash the same); injected `EvidenceReader { read(locator, { principal, signal }) → { value, classification? } }` authorised per principal; immutable, principal-scoped cache with no TTL (`global` refused for classified evidence); `evidence-missing` / `evidence-unauthorized` as errors; no drift loop (`evidence-reshape-failed` is an error); class clamped to `strictest(declared, evidence)`; evidence existence becomes an admission error | `experience-evidence`: a recorded output rendered; the live tool changes; replay is byte-identical; a missing ref renders `error`; a second principal is refused | bind by reference to recorded evidence, never re-execute | L |
| **7 (widened)** | `SurfaceProfile { modality, audience: viewer \| broadcast + clearance, updates: live \| edit \| append \| none, layout: rich \| linear \| text, density?, limits? }` as a compile input, never on the Blueprint; **fail-closed** classification (absent class on an evidence-backed binding refused for broadcast, `classification-missing`); **audience-scoped serving** (inventory and serve from the audience-compiled Blueprint, not the Experience); `global` cache refused for classified bindings; `source.redacted` (IR + ADR) | `experience-broadcast` + negative: a withheld handle requested directly answers `unknown-handle` and never reaches the store | the identity model is enforced on the data path, not only the markup | M–L |
| **8 (widened)** | Chat adapter (block emitter, size-limit degradation) **plus** message anchoring: a conversation is a `column` of message containers keyed by message id (IR 2.4.0 layout ids); prose is the first child; `anchorAugmentation(conv, messageId, resolved) → Operation[]` with `subject-superseded`; **deferred priority** via IR 2.5.0 `Layout.defer`; late-arrival policy per `updates`; a drop is a `deferred-dropped` finding, never silent | `experience-slack` + `experience-conversation`: prose first, augmentation late; web patches in place, chat emits an edit, terminal appends, a `none` surface drops with a finding; regenerated prose supersedes | patches attach to messages; priority is honoured on every surface | L |
| **9 (+density)** | Vocabulary pack as planned + `density` / compact hints + a `Link` / `Action` deep-link kind | `experience-vocabulary`, including a compact profile | resolvers have building blocks | as planned + S |
| **11 (new) outcome package** | `@loom-ui/outcome`: type registry, `Assertion`, `admit` (`type-shape`, `evidence-missing`, `claim-unmapped`, `clearance-exceeded`, `intent-undeclared`, `no-evidence`), resolvers per (type, profile) with deterministic slot ids, `checkReduction` (evidence ⊆ admitted, no live-graph provider, no class lowered), `interpretIntent` (third domain; `intent-undeclared`, `intent-payload-invalid`, `intent-reference-unknown`; free text tainted), `ResolutionCache` key; reference pack `Answer` / `Investigation` / `Comparison` / `None`; optional loom `CatalogEntry.actions` | `experience-outcomes`: one Investigation → web dashboard / chat headline + link / compact card; `explore(E3)` round-trips as a typed intent; `explore(E99)` and an injected text payload are refused | agents assert experiences, not components; resolvers only reduce | XL |
| **12 (new) Lifter SPI** | `Lifter` + `Gate` SPIs in `@loom-ui/planner` on `ctx.decide` (the gate its own decision with policy and propensity); lift templates; lifter conformance kit (`None` reachable, no invented evidence, every cited claim in the claim map, a second lift on the same subject calls no model); structured `type-gap` reason on `None` | `ambient-augmenter` (headless, scripted model): commit fixtures → gate → lift → admit → resolve for three profiles → anchor; most fixtures yield `None`; a duplicate commit is one decision; regenerated prose is discarded | augmentation is a recorded projection that defaults to silence | L |
| 10 | diff-based refine (unchanged) | `planner-refine` | — | as planned |
| B5 (slice 6 phase 3, planned) | `mergeExperiences` gains a second consumer: the user's presentational overlay re-applied after re-resolution | an AEP case in B5's example | user authorship survives augmentation | as planned |

Order: 6 → 6b → 6c → **E** → **7** → **8** → **9** → **11** → **12** → 10. E and 6b/6c touch disjoint
packages (hydration versus renderer-lit) and can run in parallel. 11 needs 7 (profiles), 8 (the
chat surface) and 9 (building blocks); 12 needs 11.

## 9. Where the paper is wrong or underspecified

Merged from both working evaluations; each item carries the reason.

1. **"A child its parent never joins" versus "a consumer of the record."** Two architectures one
   section apart. A spawned child needs the parent to write a spawn record, so the answering path
   knows the augmenter exists, and loom's supervisor has no recovery path for unjoined children.
   The observer model inherits ADR 0058's convergence for free. Drop "child".
2. **"Replaying a conversation reproduces exactly the visuals the user saw."** Overclaims four
   ways: only if the admitted artifact *and* the versions it was admitted and resolved under are
   recorded (ADR 0092 D2, ADR 0071); surface-side collapse and drop decisions are not in the record;
   retention, crypto-shredding and GC are allowed to make evidence unresolvable, and data protection
   must win; and it is false for any live-bound data, which is loom-ui's default today. Accurate
   claim: replay reproduces what was admitted, under recorded versions, while its evidence is
   retained — a property of evidence binding, not of projection.
3. **Cancel, discard, drop.** Fine only as recorded facts: cancellation is `EXECUTION_CANCELLED`,
   discard is a fold rule (key hash ≠ latest hash), a budget drop is a decision or `TIMER_FIRED`. A
   silent adapter drop contradicts auditability and also hides the paper's own "share dropped"
   metric; make it a finding. The budget's anchor is ambiguous; anchored at augmentation start it
   stretches under backlog.
4. **"One record, not two."** Right in spirit. "Causal ordering across the run tree" should be
   defined as recorded causal references — a partial order — not a store-wide sequence, which loom
   deliberately lacks. The conversation view is then a join over logs with independent watermarks,
   so "the state at time T" needs the watermark vector.
5. **Classification checked once, at admission.** Necessary, not sufficient: channel membership,
   viewer clearance and source classification change after admission, and targets are often
   unknown at admission (a web view later shared, a link unfurl, an export). Enforce at admission
   against the surface's identity class, again at every per-profile compile, and on the data path
   (what the hydration server will serve to that audience). A reclassification upward needs a
   recorded retraction fact. The paper is right that a resolver must not be the enforcement point.
6. **Idempotency key (message id, prose hash).** Missing the evidence signature (identical prose
   over re-run tool calls must not collapse onto a visual bound to old evidence), and ambiguous about
   marked versus display prose (hash the marked prose, or two answers with the same words and
   different citations collide). On loom, duplicate commits come by construction (§2.1) and a
   duplicate start pays for its effects (§2.2): "collapse to one result" is true of the log, not of
   the bill. Avoid `::` and the `__loom_` prefix in ids.
7. **Learning the gate from engagement.** Silent on propensity — the fourth submission to omit it —
   and a log written only by the deterministic rules tier (propensity 1) can never evaluate the
   classifier meant to replace it. Default silence makes false negatives unobservable without
   exploration, which conflicts with "low and stable"; choose an exploration budget and report ESS
   beside any lift. Engagement arrives in another execution after the deciding run ends.
8. **"Every tool output carries a classification."** Underspecified on who assigns it (the
   producer, at acquisition), whether it is recorded (yes), and what old logs mean (uncleared) —
   §6.1.
9. **"Checked at admission by confirming every claim maps to a marker."** Decidable only for claim
   *identity* (set containment). Whether the visual's *numbers* agree with the prose's needs a
   judge; `checkCitations`'s own documentation draws this line. Say which half is structural.
10. **Resolution as a rendering-runtime mechanism.** loom-ui resolves at compile, content-addresses
    the result and keeps adapters dumb (IR-2 design §5.0). The paper's closing line — a compiled
    immutable representation belongs here "as the product of resolution" — is compatible if the
    rendering runtime includes a compile step. Side with compile: it is the one choke point where
    classification before any text fallback is enforceable.
11. **Two layers are too few** — §4.2.
12. **"Bind by reference, never by value" does not cover generated text.** A conclusion or finding
    title is model-authored, not tool output, yet the paper classes IR elements only by the evidence
    they bind. Rule: generated text is itself recorded (it is the augmenter's decision output),
    classed `strictest(cited evidence)` and bound like evidence. Otherwise text is the exfiltration
    path the paper warns about.
13. **"A resolver can only reduce."** Reduce what — evidence set, row detail, class? Is a mean over
    secret rows a reduction? Rule: an aggregate inherits the strictest input class unless its type
    declares a declassifying aggregation, reviewed like a type. Enforce with `checkReduction`;
    without a check, "only reduces" is prose.
14. **"Late updates" is binary.** Broadcast surfaces render prose natively, with edit windows and
    rate limits; augmentation is often an edit, a threaded reply, or nothing. Needs
    `live | edit | append | none`.
15. **Cache key `(type, intent class, evidence signature)`.** Ambiguous and missing a component.
    Under a content signature nothing is shared; under a shape signature only structure is shared,
    which needs a structure/value split the paper never states (loom-ui has one). Both readings are
    valid for different caches: a result cache keys on evidence *content* hashes (claim-check refs,
    not ids, or re-run queries hit stale entries); a resolution cache keys on per-slot *shape* +
    cardinality + resolver and catalogue versions and re-binds values. Both must include the
    audience / surface-profile class, or a resolution cached for a requester is served to a
    broadcast channel — the leak the paper itself names.
16. **"Adapters never call tools."** Right for consequential actions, blurry for reads.
    Re-hydrating a live dashboard for a new time range is a read on the user's behalf; on an
    evidence-bound augmentation there is nothing to re-read, so the same gesture must be an intent
    and a new turn.
17. **"Templates per sub-agent"** conflates lift templates (which Assertion to fill; data for the
    lifter) with resolution templates (how a type looks per surface; the resolvers). Different
    owners, versions and cache keys.
18. **"Generalisation should follow evidence of need."** For loom 1P that is ADR 0083 and holds.
    For loom-ui the standing ruling is the opposite: build the capability with a reference example
    first. loom-ui already has two real surfaces, so the paper's own gate is met anyway.
19. **Intent provenance.** An intent must carry its subject (the assertion hash) and be typed
    differently from a typed user message, or the audit record cannot tell "clicked explore on E3"
    from "typed explore E3". Evidence ids in an intent must be members of the admitted set; free
    text must be tainted.

## 10. The paper's open questions, answered from loom and loom-ui's design

| Question | Answer |
|---|---|
| **One representation or two?** | **Three, each with one owner** (§4.2): Assertion (the augmenter), Experience (resolvers and users), Blueprint (`compile`). loom-ui already chose "a mutable model plus one IR"; the paper adds a layer above. Resolver duplication is limited to structure decisions because resolvers emit semantic types and `compile` resolves per modality. |
| **Experiences across turns?** | **Per-message Assertions are separate lineages** by construction: loom-ui's `intent` is immutable and inside the hash, and "a new intent is a new lineage" ([loom-ui design](2026-09-21-loom-ui-design.md) §3.2). The conversation view is its own lineage whose objective is the conversation, and it *anchors* them (slice 8). An investigation that evolves across turns is a new Assertion listing the prior one in `parents`. Replay stays one decision plus one artifact per augmentation. On the loom side it is a per-message join in a read model (§6.4, ADR 0058 D4). |
| **User authorship?** | Edits split cleanly. *Semantic* edits (refute, pivot, explore) are **intents** — new turns, never mutations. *Presentational* edits (move, resize, hide, rename) are **ops on the resolved Experience**, recorded with `Provenance { source: "user" }`. When a later augmentation re-resolves, the overlay is re-applied with `mergeExperiences(base, ours, theirs)` — B5 in the [genUI migration design](2026-09-23-genui-migration-design.md) §2.2, which this gives a second, unrelated consumer. That needs resolvers to mint node ids deterministically from (assertion lineage, slot path), or every re-resolution drops every id and the merge degenerates. |
| **Growing the vocabulary?** | Closed at runtime is already the rule: a gap is a finding and a human ships the type. The lifter's `None` carries `reason: "no-fitting-type"` plus the evidence shapes as a structured `type-gap` report that an offline process clusters and a human admits (slice 12). The admission process is app or tooling. |

## 11. Adoption path mapping

The paper's five stages are an **app's** order. loom-ui's slice order is a **framework's**
capability order (capabilities before consumers). They need not match; this table says which
slices and tasks each stage needs.

| Paper stage | loom | loom-ui | App |
|---|---|---|---|
| **1. Record and commit** | L6 (record the route), L4 (evidence-contract finding), L1 + L2 (replay-safe emits, if an explicit commit is emitted at all), L5 (relabel `sensitivity` so nobody leans on it) | — | derive the commit from the child's `EXECUTION_COMPLETED` (§3.2); markers as a prompt convention; consistency metric as a read-model lens |
| **2. `Answer`, one surface** | L3 (`startOnce`); `plugin-read-model`-shaped trigger (existing) | **E** (evidence providers); a web-only subset of 11 (`Answer` + `admit`) and 12 (`Gate` rule table + `Lifter`) | rule-based gate as `ctx.decide` with propensity from day one; supersession fold rule; budget from the commit timestamp |
| **3. `Investigation`, templated** | — | **11** (`Investigation` type, resolvers, `checkReduction`), **12** (lift templates) | choose the two or three recurring shapes |
| **4. A second surface** | L7 (audience label — app first, 1P gated) | **7** (profiles, fail-closed classification, audience-scoped serving, `redacted` + IR ADR), **8** (chat adapter, message anchoring, IR 2.5.0 `Layout.defer` + ADR), **9** (density, deep-link kind) | channel clearance; delivery-time recheck |
| **5. Intents upward** | existing: `resumeSchemas` (ADR 0077), `ExecutionAuthorizer` (ADR 0039), taint (ADR 0085); L8 (gated) for engagement credit | **11** (`interpretIntent`, third domain, anti-smuggling); optional `CatalogEntry.actions` ADR | re-enter through the root flow as a typed intent, distinct from a typed user message |

## 12. Summary

| Claim | Verdict |
|---|---|
| Kernel change | **Two bug fixes, no ABI change** (corrected 2026-09-27): [ADR 0102](../adr/0102-flow-emits-append-once.md) (emits append once, `EVENT_SCHEMA` 1.19.0) and ADR 0103 (a duplicate start is refused before its effects). `KERNEL_ABI` 1.1.0, `EVENT_STORE_SPI` 1.4.0. |
| Pre-existing defects | Two, probed: emit/ui re-append on resume; duplicate start pays for effects and leaks phantom `onEvent`s. |
| Loom 1P | ~~`emitOnce`~~, ~~`startOnce`~~ (superseded by the kernel fixes), evidence-contract check, recorded routing, `sensitivity` relabel — each with a second consumer. Audience label and outcome join gated, app first. |
| loom-ui | Slice E before 7; 7 and 8 widened; new 11 (outcome package) and 12 (Lifter SPI). |
| Blueprint IR | 2.5.0 `Layout.defer`; `WidgetSource.redacted`; optional `CatalogEntry.actions` — each with an ADR and a reader in both loom renderers. |
| Prior decisions corrected | ADR 0085 D1 (audience is value-level), `DataBinding.sensitivity` (no reader), `IntentRuntime` (route unrecorded), emit/ui docs. |
