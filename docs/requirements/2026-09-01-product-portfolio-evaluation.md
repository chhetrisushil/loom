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
