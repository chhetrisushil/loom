# Ambient Experience Projection

- Provenance: **maintainer white paper**, recorded verbatim below the title as submitted on 2026-09-27; evaluated in [the placement evaluation](2026-09-27-ambient-experience-projection-evaluation.md), which holds all corrections.

*Non-blocking visual augmentation for routed agent systems*

Sushil

## Abstract

Agentic systems increasingly answer through a root agent that classifies intent and routes each request to a specialised sub-agent. The answer that comes back is prose. Prose is the right primary medium, but it is a poor carrier for the shape of evidence: a trend, a distribution, the structure of an investigation. Users are left to reconstruct from sentences what a chart would have shown at a glance.

This paper describes *ambient experience projection*: a pattern in which a separate, durable process observes every committed response, decides whether it deserves a visual, lifts it into a semantic experience description bound to the evidence that produced it, and lets a rendering runtime resolve that description for each surface. The main workflow never waits for it. Nothing in the pattern requires the answering agents to know it exists beyond one small contract: cite your evidence.

The central claims are that augmentation is a projection, not a step; that visuals must be built from recorded evidence, never from prose; that agents should assert experiences, not components; and that the correct default is to add nothing.

## The problem

### Prose is lossy about evidence

A sub-agent that investigates a latency regression may run a dozen queries, compare two time windows, rule out three hypotheses and land on one. Its answer compresses all of that into a few paragraphs. The conclusion survives. The structure of the reasoning, which hypotheses were tested and what the data looked like, mostly does not.

A targeted question has the same problem at a smaller scale. "p99 rose 40% after Tuesday's deploy" is a correct sentence and a weak one. A single chart with the deploy marked answers the follow-up questions the sentence invites.

### Three tempting designs, and why they fail

*In-band generation.* The answering agent emits UI alongside its prose. This couples every agent to a UI vocabulary, inflates every prompt with component definitions, adds generation latency to the critical path, and makes the visual only as good as the least UI-literate agent in the fleet. It also means the agent reasons about, and the platform renders, the same artefact, which ties agent behaviour to a rendering technology.

*Post-hoc rendering from prose.* A second model reads the finished answer and draws charts from the numbers in it. This is fast to build and quietly dangerous: the model re-derives data from text that already lost precision, and the chart can disagree with the sentence it illustrates. A visual that contradicts its caption is worse than no visual.

*Always-on dashboards.* Every response gets a panel. Users learn within a day to ignore the panel, and the one response that genuinely needed a visual is lost among the ones that did not.

### Requirements

A satisfactory design must:

- add no latency to the primary response;
- derive every visual from the same evidence that produced the prose;
- stay silent unless a visual adds something the prose cannot;
- keep answering agents ignorant of UI vocabulary and surfaces;
- survive retries, replays and regenerated answers without duplicating or orphaning visuals;
- enforce data classification before anything reaches a surface, including text fallbacks and broadcast channels;
- turn visuals into entry points for the next turn, not decoration on the last one.

## Thesis

### Augmentation is a projection

The augmenter is not a stage in the response pipeline. It is a consumer of the execution record. Responses are committed; the augmenter observes commits and projects experience from them, in the same way a read model is projected from an event stream. Being a projection is what makes it non-blocking by construction, rather than non-blocking by careful engineering.

### Three separations

The pattern rests on separating three concerns that in-band designs collapse:

- *Execution* decides what work happens: routing, tool calls, retries, suspension.
- *Experience* decides what should exist for the user, given the intent, the evidence and the answer.
- *Rendering* decides how that experience appears on one particular surface.

Agents, including the augmenter, operate only on the middle layer. The augmenter says "this response is an investigation with three findings and this evidence". It never says "place a line chart in column two". Whether an investigation becomes a dashboard, a headline with a link, or a compact card is a rendering decision.

### Evidence, not prose

Every element of an experience binds to a recorded tool output by reference. The prose and the visual are then two views of one set of facts. This single rule eliminates the most damaging failure mode, a chart that disagrees with its answer, and gives provenance, classification and cache keys as side effects.

## Reference architecture

```text
  user
   |
   v
+-------------------+      +--------------------+
|    Root agent     |----->|     Sub-agent      |
| intent + routing  |      | tools, reasoning   |
+-------------------+      +--------------------+
                                 |          |
                    prose (streams to user) |
                                 |          |
                                 v          v
+-----------------------------------------------------------+
|                 Durable execution record                  |
|  tool outputs, response.committed {msg, intent, evidence} |
+-----------------------------------------------------------+
                                 |
                                 v
+-----------------------------------------------------------+
|          Augmenter (detached, durable, recorded)          |
|       gate  ->  lift to experience  ->  validate          |
+-----------------------------------------------------------+
                                 |
                                 v
+-----------------------------------------------------------+
|      Experience runtime (projection over the record)      |<----+
+-----------------------------------------------------------+     |
                                 |                                |
                                 v                                |
+-----------------------------------------------------------+     |
|    Experience IR: semantic, closed, versioned, classified |     |
+-----------------------------------------------------------+     |
                                 |                                | semantic
                                 v                                | intents
+-----------------------------------------------------------+     |
|   Rendering runtime: negotiate, resolve, patch, prioritise|-----+
+-----------------------------------------------------------+
           |                     |                    |
           v                     v                    v
    +-------------+       +-------------+      +-------------+
    | Web surface |       | Chat surface|      | Embedded /  |
    |             |       | (broadcast) |      | host iframe |
    +-------------+       +-------------+      +-------------+
```

Facts flow down as patches. User interaction flows up as semantic intents, which re-enter through the root agent like any other request.

## Components

### The commit event

When a routed sub-agent finishes, the agent harness emits a `response.committed` event carrying the message identifier, a hash of the prose, the intent class the router assigned, the identity of the sub-agent, and references to the evidence the answer relied on. This is the augmenter's only trigger. It is emitted by the harness, not by each agent, so no agent needs to opt in.

### The evidence contract

This is the one obligation placed on answering agents. Claims in the prose carry references to the recorded tool outputs they rest on, for example as inline markers that are stripped before display. The harness can enforce the contract: a claim marker that points at no recorded output is a defect.

The contract costs agents almost nothing and gives the augmenter three things it could not otherwise get: which data supports which sentence, a stable identifier for each piece of evidence, and the classification of that evidence.

### The gate

The gate decides whether a response gets anything at all. It is tiered so that most decisions cost nothing.

1.  *Free signals.* The router's intent class, the sub-agent's identity, the number of evidence-bearing tool calls, and the shape of their outputs (time series, tabular, single scalar, none). Rules over these resolve a large share of cases. No structured evidence means no visual.
2.  *A small classifier* for the ambiguous middle, choosing among a handful of experience types or none.
3.  *Generation* only after a positive decision.

The gate's default is silence. A system that augments every response trains its users to ignore augmentation.

### Experience types

The augmenter lifts a response into one of a closed, versioned set of semantic experience types. A minimal starting set:

- `Answer`: a claim and the metric or series that supports it. Targeted questions land here.
- `Investigation`: a conclusion, findings, the evidence behind each, hypotheses ruled out, and optionally a timeline.
- `Comparison`: two or more entities measured on shared dimensions.
- `None`: the explicit decision to add nothing.

Each type declares its shape and the intents it accepts, such as `explore(evidence)` or `refute(finding)`. The vocabulary is closed for the same reason component vocabularies should be closed: it bounds what the model can assert, makes validation possible, and makes caching tractable. Types are added through review, not at runtime.

Investigations from a given sub-agent recur in shape. For those, the augmenter selects from precompiled templates and fills evidence bindings, rather than composing freely. Free composition is the fallback, not the norm.

### Experience IR

The output of lifting is an experience description that binds to evidence by reference, never by value. A finding does not contain the rows it summarises; it contains a pointer to the recorded tool output and a path into it. The IR is validated before it is admitted: shape conformance against the type, existence of every referenced piece of evidence, and classification clearance for the surfaces that will receive it.

### Rendering runtime

The rendering runtime turns experience into surface-specific output through four mechanisms.

*Negotiation.* Each surface declares its capabilities and its identity model: whether it renders rich layouts, whether content is seen by one authenticated viewer or broadcast to a channel, whether it supports late updates.

*Resolution.* Each experience type has a resolver per surface. An `Investigation` resolves to a full dashboard on a web surface, to a headline finding with a link on a broadcast chat surface, and to a compact card inside a host iframe. The augmenter never makes this choice. This is what lets the gate ask the easy question, "what kind of outcome is this?", rather than the hard one, "what UI should this get?".

*Patches.* Augmentation arrives as patches to the existing conversational experience, attached to the message it enhances. The prose was the first patch; the visual is a later one. There is no separate delivery mechanism for ambient content.

*Priority.* Prose patches are primary; augmentation patches are deferred. A surface that cannot show late-arriving content gracefully can collapse or drop deferred patches rather than reflow the conversation under the user's eyes.

Resolved output can be content-addressed and cached. If a system already has a compiled, immutable representation of rendered surfaces, it belongs here, as the product of resolution, rather than as the experience layer itself.

### Surface adapters

Adapters receive resolved output and patches, and emit intents. They never call tools directly on the user's behalf. A drill-down in a chart becomes `explore(evidence: E3)`, which returns to the experience runtime and from there to the root agent as a new request. This keeps every consequential action inside the recorded execution path, where it can be audited, replayed and authorised.

### The intent loop

The intent loop is what distinguishes this pattern from decoration. A finding the user refutes, a piece of evidence they expand, a comparison they pivot: each is a typed, semantic request that the root agent can route. Visuals become the most precise way to ask the next question.

## Durability and replay

### Augmentation as a recorded effect

The augmenter's model calls are nondeterministic effects. They are recorded when they happen, and replay reads the recorded result instead of invoking the model again. The experience runtime is a deterministic function of the record. Replaying a conversation reproduces exactly the visuals the user saw, which matters both for audit and for debugging a visual that misled.

### Detached, but causally linked

The augmenter runs as a child that its parent never joins. The parent completing, failing or rotating does not cancel it. It is nonetheless recorded in the same execution tree, causally linked to the commit event that spawned it.

### One record, not two

Experience events belong in the same durable record as execution events. A separate experience store with its own lifecycle means two orderings to reconcile and a replay that can disagree with itself. Per-run logs are compatible with this: "one record" means one store with causal ordering across the run tree, not one writer appending to another's log.

### Idempotency, supersession and time budgets

- The augmentation job is keyed on the message identifier and the prose hash. Duplicate commit events and retries collapse to one result.
- If the answer is regenerated, its hash changes. The pending augmentation now targets content that no longer exists and is cancelled or discarded.
- Each augmentation has a time budget. A visual that arrives after the conversation has moved on by several turns is disorienting; past the budget it is dropped, or attached only as a collapsed supporting view.

## Data protection

Generated visuals over operational data create an exfiltration surface that prose alone does not. A chart can reveal values the prose deliberately summarised, and a broadcast surface can show them to people the original requester was not.

Classification therefore propagates from evidence. Every tool output carries a classification; every IR element inherits the classification of the evidence it binds to; admission requires clearance for the identity model of each target surface. This check happens at IR validation, before resolution, because some surfaces render text fallbacks that bypass any rendering-layer boundary. A resolver can only reduce what is shown. It cannot be the place where protection is enforced.

Intents flowing upward are untrusted input. They are validated against the type's declared intent schema and authorised like any other request, never executed as instructions.

## Cost and latency

The pattern moves visual generation off the critical path, but it still costs model calls. The main levers:

- The tiered gate means most responses cost nothing beyond rule evaluation.
- Templates for recurring investigation shapes reduce generation to filling bindings.
- Content-addressed caching keyed on experience type, intent class and evidence signature lets similar answers share resolved output.
- Retrieving only the relevant slice of the experience and component vocabulary keeps the augmenter's prompt small.
- A compact intermediate output format, expanded deterministically, is cheaper to generate and easier to validate than verbose structured output.

## Failure modes

*Inconsistency.* The visual shows something the prose did not claim. Mitigated structurally by evidence binding, and checked at admission by confirming that every claim the IR surfaces maps to a claim marker in the prose.

*Over-augmentation.* The gate fires too often and users stop looking. Measured directly (see below) and treated as a regression.

*Staleness.* The visual arrives after the user has moved on. Bounded by the time budget and by deferred priority.

*Orphaning.* The answer is regenerated or deleted and its augmentation attaches to nothing, or to the wrong thing. Prevented by keying on the prose hash.

*Leakage.* A resolver on a broadcast surface shows evidence cleared only for the requester. Prevented by enforcing clearance at admission rather than at rendering.

*Intent smuggling.* Content inside evidence, or a compromised surface, emits intents that look like user requests. Prevented by schema validation and by routing intents through the same authorisation as typed requests.

## Evaluation

Useful signals, per intent class and per experience type:

- *Augmentation rate.* The share of responses that received anything. It should be low and stable.
- *Engagement.* Expansions, drill-downs and intents emitted, against dismissals and collapses.
- *Consistency violations.* Admissions rejected because the IR and the prose disagree. Each one is a defect in either the evidence contract or the augmenter.
- *Time to visual.* The distribution of latency from commit to patch, and the share dropped by the time budget.
- *Intent follow-through.* How often an intent from a visual leads to a turn the user continues with.

Engagement data is also the training signal for the gate. The gate should learn from what users open, not from what the augmenter was able to produce.

## Adoption path

1.  *Record and commit.* Emit the commit event and establish the evidence contract. Nothing visible changes, but consistency can already be measured.
2.  *Answer, one surface.* Rule-based gating and the `Answer` type on the richest surface. This exercises the full path, from commit to patch, with minimal generation.
3.  *Investigation, templated.* Templates for the two or three most frequent investigation shapes.
4.  *A second surface.* A resolver for a constrained or broadcast surface. This is where negotiation, clearance and priority stop being theoretical, and where an abstraction for per-surface resolution earns its place.
5.  *Intents upward.* Close the loop so that visuals feed the next turn.

Generalisation should follow evidence of need. A per-surface resolution layer is justified when a second real surface exists, not before.

## Open questions

*One representation or two.* The experience IR is semantic; resolved output is surface-oriented. Keeping a single IR is simpler until two surfaces duplicate non-trivial logic.

*Experiences across turns.* Whether augmentation should patch a single evolving experience or attach a new one to each message affects both usability and the replay model.

*User authorship.* Treating user edits as semantic mutations on the experience, rather than on rendered output, preserves the separations above, but introduces merge questions between user edits and later augmentation.

*Growing the vocabulary.* A process in which the augmenter proposes candidate types, from responses it could only classify as `None` despite rich evidence, and humans admit them.

## Conclusion

Routed agent systems already produce the evidence a good visual needs. They record it, then discard its shape in prose. Ambient experience projection recovers that shape without asking answering agents to change beyond citing what they used, and without asking users to wait. It works because it treats augmentation as a projection over the execution record, binds every element to evidence, keeps agents on the semantic side of the rendering boundary, and defaults to silence. The result is a system in which prose remains the answer, and visuals become the most precise way to ask the next question.
