# Product portfolio — placement evaluation (three submissions)

- Status: **Verdicts recorded. Net kernel change required by all three products: zero.**
  One new 1P work item (W1, blueprint conformance); one pattern to document (W2); one
  evidence-gated deferral (W3). Everything else is already shipped, already rejected, or app code.
- Evaluates three submissions, held externally at time of writing:
  1. **Console AI mode** — "the response to a user's intent should be interface, not prose"
     (principles P1–P8, §§1–15). Referred to below as **CON**.
  2. **Treadle — a personal toil compiler** (v0.2, requirement series OB/EP/SG/AN/PR/EX/LP/PV/EC/TX/KP).
     Referred to as **TRD**. This supersedes
     [the Companion platform submission](2026-08-12-companion-ambient-execution-platform.md);
     its verdicts stand unless re-opened below.
  3. **AetherOS — Intelligent Experience Platform**. Referred to as **AET**.
- Method: the ADR 0051 discipline — a placement verdict per series, judged against the best
  userland alternative, bias outward (P10), [second-consumer rule](../adr/0083-second-consumer-rule.md)
  applied before anything becomes 1P surface. Every claim was checked against the repo before
  judgment. Corrections come first, because three of them are re-submissions.

---

## 0. Corrections — three of these have been made before

| # | Submitted | Repo record |
|---|---|---|
| **C1** | TRD **LP-4**: *"Interventions are micro-randomised at decision points, and **the randomisation draw** is written to the event log."* | **A regression against a correction this document's predecessor already made.** The [Companion evaluation](2026-08-12-companion-platform-evaluation.md) §5.1 corrected exactly this text: the draw is the sample (`0.37`); the **propensity** is `P(action taken \| context)`. Recovering a propensity from a draw needs the policy's internal state at decision time, which is not durable and is gone after a retrain. `evaluate.ts` reports `estimator: "agreement-only"` and refuses a value estimate without it; `promotionGate` then fails with *"no unbiased value estimate … log policy.propensity at decision time"*. LP-6 is **not computable** over a log written to LP-4 as it now stands, and nothing downstream detects this until someone tries. The mechanism exists and is free: `ctx.decide`'s `policy: { id, version, propensity }` ([ADR 0079](../adr/0079-decision-context-and-policy.md)), populated by `decideWithPolicy` ([ADR 0080](../adr/0080-learning-substrate.md)). **This is the single most consequential item in this evaluation.** |
| **C2** | TRD **KP-6**: *"Policy as `guard$` with learned state."* | **`guard$` does not exist.** Correction C6 of the Companion evaluation, resubmitted verbatim. `policy$` (`@loom/core`) is a `PolicyDefinition` of named rules — a different construct. The learned-policy seam is the 3P `Policy` SPI (`loom plugin new policy`), reference `loom-plugin-linucb`. |
| **C3** | TRD **KP-5**: *"Very-long-lived suspensions … interacts with run-lifetime bounding."* | **There is no lifetime bounding on suspended runs to interact with.** [ADR 0081](../adr/0081-long-lived-suspensions-no-promotion.md); retention reclaims terminal executions only (`tools/cli/src/retention.ts` — `if (!TERMINAL.has(state.status)) return "not-terminal"`). Second submission of a rejected promotion. The open item is a **benchmark** (bytes-per-suspended-run at 10⁴–10⁵), not a primitive. |
| **C4** | TRD **KP-1**: *"orders of magnitude higher-volume than agentic run events."* | Still **unquantified**, as flagged in §3.1 of the prior evaluation. No requirement in OB or KP states a target write rate, against a measured ceiling of ~5.7K durable appends/sec where the log is the bottleneck (`docs/scaling.md`). M0 runs the collector for a working week and can emit this number for free; until it does, [ADR 0065](../adr/0065-group-commit-deferred-evidence-gate.md)'s evidence gate stays shut. |
| **C5** | AET: *"deterministic replay … LLM reasoning can be bypassed"* by persisting optimised DAGs. | This is a **plan cache**, not replay. Caching an execution plan to skip reasoning was rejected in the [Execution OS evaluation](2026-07-10-execution-operating-system-evaluation.md). Loom's actual mechanism is `ctx.decide` → `DECISION_RECORDED`, where the *choice* is the replay input ([ADR 0030](../adr/0030-decision-materialization.md)); it does not make a second run cheaper, it makes the same run reproducible. Different property, different guarantee. |
| **C6** | CON §10.3: *"content from resources is data rendered by components, never input to composition."* | Correct as a principle; loom's mechanism is **weaker than the sentence implies**. `guardRequest` ([ADR 0085](../adr/0085-untrusted-content-integrity-axis.md)) **refuses** tainted content in system / assistant / tool-description position but **fences** it inside a `user` message. For a composer, "fenced" is not "excluded". Nothing stops an app passing tainted resource metadata as a user message. The boundary CON wants is app-level abstinence, and it currently has no check. See §4, W3-adjacent. |
| **C7** | CON: root cause *"is not offered"* (P8, §10.5). AET: *"Root-cause analysis"* as a headline AetherGraph capability. | These are the same platform making opposite claims. If both ship, CON's P8 is decorative. A claim discipline that one product observes and another ignores is not a discipline. |

---

## 1. CON — Console AI mode

**Net kernel change: zero.** The paper's architecture is, to an unusual degree, already loom's.

| CON | loom today | Verdict |
|---|---|---|
| **P1** response is interface | `@loom/blueprint-runtime` + `@loom/agent-surface` (`SURFACE_PATCH`, durable/ordered/replayable) | **app** |
| **P2** composition is an event; render replays | No `BLUEPRINT_COMPOSED` event exists **and none is needed**: the fold treats unknown event types as inert, so `ctx.emit(type, payload)` writes a domain event that `foldEvents` skips while still advancing `sequence`. Store the blueprint by `sha256:` ref ([ADR 0046](../adr/0046-content-store-seam-thin-authoritative-log.md)) + claim-check ([ADR 0054](../adr/0054-claim-check-middleware.md)) | **app**. See W2 |
| **P3** closed, shape-typed vocabulary | **GAP.** See §4 W1 | **1P** |
| **P4** blueprints carry bindings, never data | Structurally true of the 1P widgets — `MetricCard`/`Timeline`/`ApprovalCard` all *require* a `DataBinding`. The hole is `customWidget$`, where `binding` is optional and `props` is free-form | **1P**, same item as P3 |
| **P5** additive personalization | app |  |
| **P6** no silent omission; query one interaction away | app; the query behind a widget is its `DataBinding` `{ projectionId, path }` — already a first-class, inspectable value | **app** |
| **P7** one artifact, two projections | **Already true, and the best-supported claim in the paper.** `agentSurfaceProjection()` folds patches into a projection; `A2UISurfaceBridge` projects the *same* surface onto an external wire format ([ADR 0069](../adr/0069-a2ui-egress-adapter.md)). Two renderings, one logged artifact, no divergent agent API | **none** |
| **P8** typed claims | Nothing today. Mechanism precedent exists; see §4 W3 | **defer** |
| §5.5 per-viewer hydration against viewer IAM | `@loom/live-query` (fold + subscribe, no syscall), K2 grants, execution-lifecycle authz ([ADR 0039](../adr/0039-execution-lifecycle-authz.md)), `TenantScopedEventStore` | **app** |
| §5.6 work session ≠ blueprint; **reference, not containment** | Exactly loom's shape: append-only log + content-addressed payload ref. The paper reached the right answer independently | **none** |
| §10.3 injection boundary | [ADR 0085](../adr/0085-untrusted-content-integrity-axis.md) taint, with MCP and A2A producers shipping | **shipped**, but see C6 |
| §10.4 auditability | tamper-evident audit chain ([ADR 0037](../adr/0037-tamper-evident-audit-chain.md)) | **shipped** |
| **§11 reversibility classes 0–4** | **[ADR 0084](../adr/0084-effect-classes-static-ceiling-k2-floor.md), shipped.** The vocabulary is *app-supplied* (`checks.verify.effectClasses`, ascending severity) precisely so a product's own ladder is not baked into the framework. CON's five classes are that array, verbatim. The class composes as the max over every reachable effect, and [ADR 0086](../adr/0086-runner-body-reach-analysis.md) made "reachable" mean the runner body, not just declared steps | **shipped** |
| §9 gap engine, §12 demand ranking | `@loom/analytics` read-only lenses | **app** |
| §5.3 tool contracts w/ cost / latency / freshness class | Not in loom, and shouldn't be — this is MCP tool annotation. Discovery and dispatch already exist ([ADR 0063](../adr/0063-mcp-dynamic-dispatch.md)) | **app** |

### One contribution to CON's open questions

§14 records *"the migration story for content-addressed immutable artifacts needs design."*
**Loom has already solved the isomorphic problem.** `EXECUTION_STARTED.flowHash` pins code
identity into the fold; replaying against changed code raises `FlowCodeMismatchError` rather than
producing a plausible wrong answer; and K11.5 `resumeAs` ([ADR 0056](../adr/0056-k11-5-state-migration-on-resume.md))
is contract-versioned migration of a pinned artifact whose dependencies moved. The replay
inspector's `pinOf()` additionally names the third case such designs always miss —
`unpinned-legacy`, where there is no pin to display, and where reporting a blank or inferring the
current version is the silent fallback the pin exists to prevent. CON's "component implementation
floats forward, semantic identity is frozen" is the same split, and can be built on the same
precedent rather than designed from scratch.

---

## 2. TRD — Treadle

**Net kernel change: zero.** KP-1…KP-8 were substantially dispositioned on 2026-08-12; the
mapping below records what changed since, and two findings that are new.

| KP | Prior verdict | Status now |
|---|---|---|
| KP-1 high-volume ingest | app + existing plugin (`CoalescingEventStore`, `appendMany` at 8.2×, [ADR 0074](../adr/0074-storage-scale-out-decorators.md)) | unchanged; **C4** still open |
| KP-2 local execution host | existing plugin — `@loom/dispatcher` + `plugin-worker-remote` / `worker-server`. *Not* an SPI change (the missing-rung finding) | unchanged |
| KP-3 mining as a deterministic projection | app — `@loom/projection-runtime`, `plugin-read-model` | unchanged; **new finding below** |
| KP-4 runtime blueprint synthesis | accepted in full, incl. BP-2's refusal to open the vocabulary | **now has a second consumer** — §4 W1 |
| KP-5 very-long suspensions | rejected, ADR 0081 | **C3** |
| KP-6 policy with learned state | app; PO-1…PO-4 shipped | **C2**; `@loom/learning` ships `trajectories()`, `evaluatePolicy()` (SNIPS + clipping + ESS), `promotionGate`, `loom learn eval` |
| KP-7 effect-class declaration + enforcement | compiler + runtime, reconciled with K2 | **SHIPPED** — ADR 0084. EX-3a's Accept line ("fails to compile") is satisfiable today via `checks.verify.effectClasses`, and ADR 0086 closed the reachability hole that would have made it vacuous |
| KP-8 replay inspector as a product surface | app; **masking becomes a security boundary** | unchanged. ADR 0071 scoped it read-only and *internal*; user-facing, redaction must live in its read path with its own adversarial test at KC-2.3's standard. Not yet written |

### New finding N1 — EC-2 model routing collides with SG-5 replayability

SG-5 requires the miner to be *"replayable … an identical candidate set in an identical rank
order,"* and KP-3 asks that it be a pure projection. EC-2 routes escalations to a frontier model
**inside** that path. A projection that calls a model is not a projection: the second fold
disagrees with the first, and SG-5's Accept line fails non-deterministically — the worst way for
it to fail, because a green run proves nothing.

The fix is shipped and costs nothing: the escalation is a **decision**, not a computation.
`ctx.decide` records the model's output as `choice`; replay reads the recorded choice and never
re-calls the model ([ADR 0030](../adr/0030-decision-materialization.md)). Mining then folds over a
log that already contains the escalations. This also makes EC-4 ("every escalation metered and
attributable") a projection over the same events instead of separate bookkeeping.

### New finding N2 — KC-4.1 is very likely unpassable on evidence, and will be misread

KC-4.1 requires the learned policy to beat the fixed baseline **in off-policy evaluation** before
any online deployment. Three of TRD's own numbers make that gate fail for reasons that have
nothing to do with policy quality:

- **LP-8** caps exploration at **≤ 2 exploratory interruptions per user per week**;
- **M4's precondition** is ~**500 decision points** per user;
- `promotionGate`'s defaults are `minSteps: 1000` and `minEffectiveSamples: minSteps / 10`.

Off-policy evidence is bounded by **exploration volume**, not log length. At 2/week, eight weeks
yields ~16 counterfactual steps; effective sample size is a function of the propensity spread, so
a log that is mostly near-deterministic contributes almost nothing regardless of how many rows it
has. `evaluatePolicy` will warn *"effective sample size … is under a tenth of the evaluated
steps — a handful of steps dominate this estimate"*, and `promotionGate` will refuse. **That
refusal means "not enough evidence", and it will be read as "the learned policy lost."**

TRD should either state KC-4.1 in terms of a required ESS rather than a comparison, or accept
that M4 needs a deliberately elevated exploration budget for a bounded window — which is a
direct trade against LP-8 and belongs in the document as such, not discovered at the gate.

### Smaller mappings, all already served

EX-4 verification predicates → `OUTCOME_RECORDED` + `@loom/analytics` outcome lenses.
EX-5/EX-6 fail-closed and rollback → typed failure channels ([ADR 0060](../adr/0060-typed-failure-channels.md))
and saga compensation ([ADR 0041](../adr/0041-saga-compensation.md)).
PV-1 sensitive-field classification at capture → `@loom/classify` + wildcard classification paths
([ADR 0076](../adr/0076-wildcard-classification-paths.md)).
PV-2 "enforcement at blueprint validation" → the `classification-reachability` verify rule, which
is the existing name for exactly that check.
PV-3 one-action export/delete → K10 retention/erasure, `ERASURE_PENDING`, `PAYLOAD_SHREDDED`.
ME-1 VRM computed only from the log → analytics; but note that VRM's **condition 5** ("the manual
signature's recurrence rate dropped after activation") is a *causal* quantity being estimated
observationally, which is the confounding TRD correctly refuses to accept elsewhere. With C1
fixed it is estimable; without C1 it is a pre/post comparison wearing a causal label.

---

## 3. AET — AetherOS

**Not evaluable as submitted.** No requirement IDs, no thresholds, no acceptance criteria, no
kill gates, no falsifiable claims — the exact defect TRD's own §0.1 describes in its predecessor
(*"nothing in it could be falsified, which meant nothing in it could be argued with or
scheduled"*). It should be held to the bar TRD now meets before any platform work is scheduled
against it. What follows is what can be extracted anyway.

### 3.1 Most of it is shipped loom under other names

| AET subsystem | Loom |
|---|---|
| AetherFlow orchestration, DAG engine, scheduler | `@loom/workflow-runtime`, `@loom/graph-executor`, `@loom/orchestration`, `@loom/scheduler`, `@loom/fair-scheduler` |
| Oracle strategic planner → execution DAG | `@loom/planner`, `@loom/intent`, `@loom/reasoning` |
| Agent runtime, named specialist agents | `@loom/agent` (`agentLoop$`, [ADR 0087](../adr/0087-durable-agent-loop.md)), `@loom/registry`, `plugin-a2a` |
| AetherVault persistent intelligence, replay | the event log + `@loom/snapshot-runtime` + `@loom/replay-vm` |
| AetherMesh integration fabric, dynamic tool discovery | `plugin-mcp` + [ADR 0063](../adr/0063-mcp-dynamic-dispatch.md) |
| AetherGraph knowledge/memory | `@loom/memory` (`TieredMemory`), `plugin-read-model`; a graph store is a **3P plugin** |
| Sentinel governance, policy enforcement | K2 grants + `EFFECT_DENIED`, `plugin-sentinel`, [ADR 0048](../adr/0048-declarative-policy-enforcement.md), audit chain |
| Streaming updates to UI | `@loom/live-query` + `@loom/agent-surface` |
| Prism/Forge runtime UI composition | `@loom/blueprint-runtime` + `plugin-a2ui` — **subject to §4 W1** |

### 3.2 What is genuinely new, and the verdict on each

1. **AetherRules as a streaming rule fabric** — *"stream evaluation, event matching, state
   engine"* with temporal logic and correlation windows. **Reject.** A rule engine holding its own
   evaluation state is a **second, non-logged source of truth** — the ST-R streams/pipes rejection
   ([db-copilot infrastructure](2026-07-15-db-copilot-infrastructure.md)), restated for the render
   plane by [ADR 0067](../adr/0067-reactive-graph-resumability-rejected.md). The userland answer
   already exists and is strictly better: rules as **projections over the log** (correlation is a
   fold; temporal windows are durable timers, `TIMER_FIRED`), with the trigger as `ctx.emit`. That
   version survives the crash the "state engine" is supposed to protect against.
2. **Natural-language rule authoring compiled at runtime.** **Reject at runtime; accept at build
   time.** This is settled ground: P11 / `@loom/appgen` ([ADR 0042](../adr/0042-ai-native-brownfield-appgen.md))
   parses intent to a spec and generates **plain static TS** — deliberately **no runtime NL**. AET
   puts model inference on the rule-evaluation path, which is the same objection CON raises against
   itself and answers correctly with "no model in the render path" (P2).
3. **Unbounded runtime UI synthesis** (Prism/Forge generating components). **Reject**, and CON §9.1
   argues the case better than this document could: runtime synthesis makes accessibility
   unauditable *by construction*, because the property being certified is a property of individual
   outputs. AET is useful here mainly as the falsification case for W1.
4. **Plan caching to bypass reasoning.** See **C5**.

**Net kernel change from AET: zero, and net 1P change: zero.** Its one contribution is being a
third, independent consumer of the closed-vocabulary problem — and the clearest illustration of
what happens without it.

---

## 4. Recommended changes to loom

Three items. One is worth building now.

### W1 — Blueprint conformance: enforce the catalogue that is already declared **(recommended)**

> **Scope revised in Part II §9** — Part II found four further defects on the same surface and
> W1 absorbs them (W1a–W1e). This section states the original catalogue finding; §9 is the
> current scope.

**The finding.** Loom has two component-vocabulary paths and neither is closed:

- `@loom/blueprint-runtime` — `Widget.kind` is *"widened to `string` so custom renderers can
  register any kind"*, with `customWidget$` + `RendererRegistry.register(kind, …)` and **no
  validator anywhere**. `binding` is optional on a custom widget and `props` is free-form, so a
  composer can inline fetched data into a blueprint and nothing objects.
- `plugins/a2ui` — a real, schema-typed catalogue with `defineCatalog`, and **`A2UISurfaceBridge`
  stamps `catalogId` on every `createSurface` without ever checking a component against it.**
  A component type no catalogue defines is emitted happily and fails at the *client*, at render
  time, per viewer.

Neither `@loom/verify` nor the compiler knows the word "blueprint". This is the
[vacuous-check pattern](../adr/0083-second-consumer-rule.md) in its cleanest form: a declared
vocabulary that reads as coverage and enforces nothing. Today it is a latent risk; the moment a
**model** authors the blueprint it is the load-bearing check for three products at once.

**Second-consumer rule: satisfied three times.** CON P3/§5.1/§9.1 ("composition draws exclusively
from an audited catalogue; a missing component is a logged gap, never a runtime synthesis"),
TRD KP-4/BP-2 with a numeric gate on it (**KC-2.2**: ≥ 95% of synthesised blueprints validate on
first attempt — a criterion with **nothing today that could produce the number**), and AET as the
negative case.

**Placement: 1P, no kernel.** `KERNEL_ABI` unchanged, `EVENT_SCHEMA` unchanged, no syscall, no
event. Concretely:

- `validateBlueprint(blueprint, catalog)` in `@loom/blueprint-runtime`, returning findings rather
  than throwing, so CON §4.7's "no component fits → degrade to a typed table **and file a gap**"
  is a value the app can act on rather than an exception it must catch.
- Two checks, not one: **(a)** every `kind` is in the catalogue; **(b)** every data-bearing widget
  carries a `DataBinding` and no unbound payload in `props` — this second one is CON P4, and it is
  the **exfiltration boundary** of §10.2, not a style rule.
- `A2UISurfaceBridge` refuses a component absent from its declared catalogue, rather than
  deferring the failure to the client.
- Reuse `defineCatalog` — the declaration shape already exists and is already the A2UI contract.

**Acceptance is the negative case** (per the standing rule that "declared" and "enforced" look
identical in a green suite): a blueprint naming an unlisted `kind` must **fail**, and the bridge
must emit **nothing** — asserted on the emitted message stream, not on a return value.

### W2 — Document composition-as-a-logged-artifact as a pattern *(docs; optional)*

CON §5.4 and TRD KP-4 independently invented the same construction, and both assumed it needed
platform support. It does not: `ctx.emit("BLUEPRINT_COMPOSED", { ref })` where `ref` is a
`sha256:` ContentStore address, with claim-check keeping the payload out of the log, and a
`flowHash`-style pin for "the meaning of this view never changes silently." Three documents have
now reached for this and none found it, which is a documentation defect rather than a capability
gap. A `docs/` section plus one example would close it. **No code change.**

### W3 — Claim classes: record the shape, gate the promotion *(do not build yet)*

CON P8 is a good idea and the shape is familiar. It is the **integrity axis pointed the other
way**: ADR 0085's taint governs what may *enter* an instruction position; a claim class governs
what may *leave* an assertion position, and both are value-level labels refused at one seam. ADR
0084 supplies the other half — an **app-supplied ordered vocabulary** the framework checks but does
not define, which is exactly right here, since `observed | derived | correlated | estimated |
predicted | causal` is one product's taxonomy.

But the second consumer is not yet real. TRD's TX-3 ("never states a quantity it cannot defend;
a lower bound is labelled as such") and ME-4 are the same *instinct* — they are not demonstrably
the same *mechanism*. Per ADR 0083, that is an app-code verdict, not a 1P one.

**Recommendation: an ADR with an evidence gate** — build claim classes as app code in the console
first; promote to a third `@loom/classify` axis only when a second consumer's implementation is
shown to have the same shape, not merely the same motive. Note C7 while recording it: the
discipline is worthless if a sibling product on the same platform ships root-cause claims.

### Explicitly no change required

Reversibility/effect classes (ADR 0084 + 0086) · prompt-injection boundary (ADR 0085) · audit
(ADR 0037) · per-viewer hydration (`@loom/live-query` + ADR 0039) · long-lived suspensions
(ADR 0081) · policy state and off-policy evaluation (ADRs 0079/0080) · replay inspector
(ADR 0071) · ingest path (ADRs 0074/0065) · local execution host (dispatcher + worker-remote) ·
mining as a projection (`@loom/projection-runtime`) · knowledge graph (3P).

---

## 5. Summary

| | Kernel | 1P | App | Rejected / already shipped |
|---|---|---|---|---|
| **CON** | 0 | W1 (shared) | most of the paper | reversibility classes, injection boundary, audit, hydration, P7 |
| **TRD** | 0 | W1 (shared) | OB/EP/SG/AN/PR/EX/PV/EC/TX | KP-5 (ADR 0081), KP-6 (`guard$` ≠ real), KP-7 (ADR 0084 ships it) |
| **AET** | 0 | 0 | — | AetherRules streaming state (ST-R), runtime NL rules (appgen), unbounded UI synthesis (BP-2), plan cache |

`KERNEL_ABI` stays **1.1.0**. `EVENT_SCHEMA` stays **1.18.0**.

The portfolio's real risk is not platform capability. It is **C1** — one product is about to write
months of logs that cannot answer the question the product exists to answer, and nothing in the
system will report the loss until someone tries to evaluate against them.

---

---

# Part II — GenUI: a focused evaluation of the composition surface

Added 2026-09-01, before implementing W1. All three submissions are GenUI products, so W1 was
scoped against the catalogue alone. Reading the whole surface — `@loom/blueprint-runtime`,
`@loom/agent-surface`, `plugins/a2ui`, `plugins/renderer-react`, `plugins/renderer-terminal`,
`plugins/mcp-app`, and the `db-observability` reference example — found **five** defects, of which
the catalogue is one. **Still no kernel change, and no new package**: `KERNEL_ABI` 1.1.0,
`EVENT_SCHEMA` 1.18.0, and `SURFACE_PATCH` is a userspace domain event (not in
`knownEventTypes()`), so its payload is additive by construction.

The conclusion is that **W1 was scoped too narrowly**, not that anything new is needed.

## 6. The structural finding: loom's GenUI makes the structure static and the data dynamic

There are two composition models in the repo and they do not meet:

| | `@loom/blueprint-runtime` | `@loom/agent-surface` |
|---|---|---|
| Unit | `Blueprint` — layout tree of `Widget`s with `DataBinding`s | `SurfaceState` — an untyped state tree |
| Produced by | `blueprint$(...)` in app code | `SURFACE_PATCH` events from a flow/agent |
| Durable? | **No.** A plain value. Never emitted, never hashed, never replayed | **Yes.** Ordered, folded, replayable |
| Carries | structure | data |

`agentSurfaceProjection()` joins them by making surface state bindable, so the supported form of
dynamism is **stream data into a fixed structure**. Every 1P affordance points that way:
`SurfacePatch` ops are `set / merge / append / remove / increment` over *values*; there is no
structural op.

GenUI inverts this. The thing composed at runtime **is the structure**, and a runtime-composed
structure has no durable channel today. The reference example shows the consequence:
`db-observability`'s `DashboardComposer.answer()` returns `{ …, blueprint }` as an in-memory
value, the composer runs **in the browser**, and `App.tsx` hands the result straight to
`<BlueprintRenderer blueprint={result.blueprint} …>`. Nothing is logged, nothing is addressable,
and `blueprint$` derives the id from the topic string, so two
different compositions about CPU collide on one id.

This does **not** need a new primitive. `ctx.emit("BLUEPRINT_COMPOSED", { ref })` with a `sha256:`
ContentStore address is the whole mechanism, and that is exactly **W2**. What is missing is the
typed half: nothing validates that a blueprint read back off the log is a well-formed blueprint
drawn from a known catalogue — which is **W1**. G1 therefore collapses into W1 + W2 and adds no
surface of its own. Recorded here because three documents assumed platform support for it.

## 7. Five defects

### G2 — `updateComponents` is declared, exported, and unreachable

`A2UISurfaceBridge` takes `components: ComponentInstance[]` as a **constructor option**, sends it
once inside `createSurface`, and thereafter emits only `updateDataModel`. There is no method that
changes the component tree.

Meanwhile `messages.ts` defines `UpdateComponentsPayload`, includes it in the `A2UIServerMessage`
union, and `index.ts` exports it — with the comment *"the `updateComponents` type is defined for
completeness."* The `a2ui-egress` example even carries a render case for it that can never fire.
[ADR 0069](../adr/0069-a2ui-egress-adapter.md) names `updateComponents` as part of the protocol it
adapts and records **no decision to omit it**, so this is an unrecorded omission rather than a
scope cut.

Consequence: **recomposition cannot be expressed on the egress path at all.** CON §4.3 (*"a new
panel appears beside the existing surface"*), CON §4.5 (proposal surfaces), and TRD PR-3 (*edit
the proposed automation, then approve*) are all structural updates to a live surface. Second
consumer satisfied; the fix is one method (`recompose(components)`), and it must land with W1
because the catalogue check belongs at exactly that seam.

### G3 — Node identity is content-derived, so every edit re-identifies the node

`stableId(kind, props)` hashes kind + props with a 32-bit `Math.imul` rolling hash. Change one
prop and the widget's `id` changes — which is also its React `key`, so the component remounts, and
any annotation, pin, or agent reference keyed on that id breaks.

CON §5.2 requires the opposite in as many words: *"Nodes retain identity across revisions, so
annotations, pins, and agent references survive edits to the view"*, and §5.2's semantic
operations (add node, rebind, reorder) depend on it. TRD PR-3's edit-then-approve needs the same.

Two smaller consequences of the same code: two structurally identical widgets in one blueprint
collide on `id` (duplicate React keys); and while `customWidget$` accepts an explicit `id` — as
does `StreamingText`, alone among the eight built-in builders — **the other seven do not**, so on
the 1P path a stable id usually cannot be supplied at all. The fix is an optional `id` on the
remaining builders, and `StreamingText` already shows the shape.

Separately, and worth stating plainly: a 32-bit non-cryptographic hash is an **identity, not a
content address**. If a blueprint hash is to be the audit anchor for *"what was on screen when
this change was approved"* (CON §5.6), it must be a real digest. `contentAddress()` in
`@loom/plugin-content` already computes `sha256:` and should be the only thing used for that.

### G4 — Per-node provenance has no channel

CON §5.2 and §8.1 require every node to record who placed it — user, agent, model version,
evidence, tool call. TRD PR-5 needs the same for *"why did you suggest this?"*.

`ctx.emit(eventType, payload)` takes **no metadata argument**, and `SurfacePatchPayload` is
`{ surface?, patches }` with no provenance slot. So provenance can only be smuggled inside the
patched *value*, where it pollutes the data model the client binds to.

On the surface path this is otherwise nearly free: *"which patch last wrote this path"* is a
projection over the log, because patches are ordered events. One optional field —
`by` on `SurfacePatchPayload` — makes CON §5.2 and TRD PR-5 computable. `SURFACE_PATCH` is a
userspace domain event, so **`EVENT_SCHEMA` is unchanged**.

There is already an in-repo precedent for exactly this kind of evidence:
`plugins/mcp-app/src/provenance.ts`. See §8.

### G5 — No renderer conformance contract, and the two 1P renderers disagree

- `WidgetKind` declares **eight** built-in widgets. The React `defaultRegistry` registers
  **five**. `ProgressBar`, `DataTable` and `AlertCard` have no 1P React renderer, and an
  unregistered kind renders as the literal string `[No renderer for <kind>]` — per viewer, at
  render time. `BlueprintRenderer.test.tsx` **asserts that string for `DataTable`**, so the gap is
  pinned as intended behaviour rather than flagged as one.
- `renderBlueprintToString` (terminal) never reads `widget.kind` at all — it prints
  `title: value` for every widget. It cannot fail on an unknown kind because it never looks; it
  silently flattens the semantics instead.

So loom's own vocabulary is not fully rendered by loom's own renderer, and its two 1P renderers
degrade in opposite directions — one visibly, one invisibly. CON's trust model rests on *"two
responders on a call are guaranteed to be looking at the same thing"* (§4.3) and on P7's one
artifact / two projections. That guarantee is currently untested, and for three of eight built-ins
it is false.

This is the second half of W1: the conformance check has **two** directions —
blueprint → catalogue (does the composer name only known kinds) and catalogue → registry (does
this renderer cover the catalogue). The second one fails today, on shipped code, with no product
involved.

### G6 — The catalogue itself (W1 as already recorded), with new evidence

The reference example had to hand-roll the closure W1 proposes: `catalogue.ts` defines
`CatalogueEntry[]` with `build: () => Widget`, the model names an **entry id** rather than a
`kind`, and `catalogueEntry(id)` **throws** on an unknown id. That indirection is a good pattern
and confirms the need — but as app code it is re-invented per app, it is unavailable on the a2ui
egress path, it cannot express CON §4.7's *"degrade to a typed table and file a gap"* (a throw is
not a finding), and it cannot produce TRD **KC-2.2**'s number, because you cannot compute a
first-attempt validation rate from an exception.

## 8. What is already strong, and should not be rebuilt

Two of these are better than the submissions that ask for them.

- **The transient hydration-plan interpreter** — `db-observability/src/hydration.ts`, on
  ADRs [0060](../adr/0060-typed-failure-channels.md)/[0061](../adr/0061-step-identity-interpreter-guardrails.md)/[0063](../adr/0063-mcp-dynamic-dispatch.md)/[0064](../adr/0064-sandbox-eval-plugin.md)/[0065](../adr/0065-group-commit-deferred-evidence-gate.md)
  and `invokeTransient` ([ADR 0066](../adr/0066-transient-effect-invocation-facade.md)). An
  immutable plan whose nodes each pin an MCP tool's **input-schema hash**, a **content-addressed
  reshape script**, and an **expected output shape hash**, walked by plain code through
  `invokeTransient` — **zero events on the read path** — crossing the determinism boundary only
  when a pin drifts, at which point a durable run records `SCHEMA_REPAIRED`.
  This *is* CON §5.4 ("no model in the render path"; "render latency is a cache lookup") already
  built, and it answers two things CON leaves open: §4.7's **stale binding** state and §14's
  *"source schema changes that alter meaning → explicit migration"*. Loom's answer is a pinned
  hash verified per call plus a recorded repair.
- **Decision provenance across a long suspension** — `plugins/mcp-app/src/provenance.ts`:
  `SEEN_SEQUENCE_FIELD` and `isStale()` carry *the surface sequence the human had rendered when
  they clicked*. **This is stronger than CON §4.5/§8.2 asks for.** CON requires a diff, evidence
  links and a blast-radius view, but never asks whether the human was looking at current data —
  and for a gate open across days of surface churn, that is the question. Note also that
  `isStale` treats **absent** provenance as stale, which is the vacuous-check discipline applied
  correctly, and that the module deliberately stops at supplying the number rather than imposing
  a TTL (P10).
- **Per-widget selector subscription** ([ADR 0068](../adr/0068-projection-selector-subscription.md),
  `useWidgetValue` / `subscribeSelector`) — the render-path story for wide dashboards.
- **Egress redaction on both surface paths** — `agentSurfaceProjection({ redact })` masks in the
  fold; the a2ui bridge masks on egress while keeping true values internally so `increment` /
  `append` stay correct. Path-based and app-declared, not IAM-derived — which is the honest limit
  of CON §5.5's per-viewer hydration today.
- **Prototype-pollution hardening** on `applySurfacePatch` (`__proto__` / `constructor` /
  `prototype` dropped whole, at any depth).
- **`traverseBlueprintAsync`** — the interruptible, incremental-commit walker CON §4.7 needs for
  *"panels appear as their bindings resolve, with the arrangement settled first"*. It exists, it
  is opt-in, and it self-documents that **no production renderer ships against it yet**. Not a
  defect; a validated extension point with no consumer.

## 9. Revised W1

W1 stays **1P, no kernel, no new package**, and absorbs G2–G5. Sequenced so each step has a
negative test before the next lands:

| | Change | Serves |
|---|---|---|
| **W1a** | `validateBlueprint(blueprint, catalog)` in `@loom/blueprint-runtime` — returns findings, never throws, so a missing component can degrade *and* file a gap. Two checks: every `kind` is in the catalogue; every data-bearing widget carries a `DataBinding` and no unbound payload in `props` (CON P4 — the exfiltration boundary, not a style rule) | CON P3/P4, TRD KC-2.2, G6 |
| **W1b** | Catalogue → registry coverage check, and register (or remove) `ProgressBar` / `DataTable` / `AlertCard`. Replace the `[No renderer for …]` assertion with a coverage assertion | G5 |
| **W1c** | `A2UISurfaceBridge.recompose(components)` emitting `updateComponents`, validated against the declared `catalogId` on the way out | G2, CON §4.3/§4.5, TRD PR-3 |
| **W1d** | Optional `id` on the eight built-in widget builders; document that a composer supplies stable ids and that `stableId` is an identity, not a content address | G3, CON §5.2 |
| **W1e** | Optional `by` (provenance) on `SurfacePatchPayload`, plus a projection that answers "which patch last wrote this path" | G4, CON §5.2/§8.1, TRD PR-5 |

**Acceptance is the negative case throughout**, per the standing rule that *declared* and
*enforced* look identical in a green suite: a blueprint naming an unlisted `kind` must fail
validation; the bridge must emit **nothing** for an off-catalogue component, asserted on the
message stream rather than a return value; and the registry-coverage test must fail if a
`WidgetKind` is added without a renderer.

**W1a–W1b are the ones worth doing first** — they are the only two that fail on shipped code with
no product involved.
