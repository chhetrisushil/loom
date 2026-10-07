# Focus Handoff — contextual collaboration on AI-generated UI

- Provenance: **maintainer white papers**, two of them, recorded verbatim below as submitted on 2026-10-07
  (converted from Org to Markdown; wording unchanged). The first is the generic argument; the second
  applies it to GenUI on loom and loom-ui. Evaluated in
  [the placement evaluation](2026-10-07-focus-handoff-evaluation.md), which holds all corrections — several
  claims about loom, loom-ui and genUI below do not match the code.

---

# Paper 1 — Contextual Collaboration on AI-Generated UI

Sushil · 2026-10-07

## Abstract

When an AI agent generates a user interface around an investigation, sharing that interface transfers the artifact but not the intent that produced it. The recipient sees a dashboard; the sender knows why it exists and where the signal is. Today that gap is closed with side-channel messages: "look at the latency panel, third row, around 02:15."

This paper argues that the right fix is not a commenting system but a narrower primitive we call *focus handoff*: the sender's attention, carried with the share and rendered by the recipient's runtime. We show why generated UI is unusually suited to this (it already has stable structure and intent), why dashboard commenting has historically failed (the conversation lives elsewhere), and which problems make the naive version fail: targets the recipient cannot see, data that has moved on, and replies that drift into a second chat.

We recommend a minimal primitive, a measurement plan, and a clear statement of what the feature must not become. The decision it depends on most is a number nobody has yet: how often generated investigations are shared at all.

## The problem: shared artifact, lost intent

A generated interface is a snapshot of what an agent found and what it decided mattered. The person who asked for it carries a second layer the interface does not show: which of the twelve panels prompted the share, what they think is going on, and what they want the other person to do about it.

When the interface is shared, only the first layer travels. The recipient has to rebuild the second by reading everything, guessing which panels matter, and asking. In practice the sender pre-empts this with a message beside the link, and that message does the real work of the share. The link is almost incidental.

The cost shows up in three places:

- **Time to comprehension.** The recipient reads panels that do not matter before finding the ones that do.
- **Clarification traffic.** "Which spike?" "Which host?" "What time range?"
- **Duplicate investigation.** The recipient re-derives a conclusion the sender already reached, because the conclusion was in the sender's head and not in the share.

The problem is sharpest when the same interface changes hands repeatedly: on-call rotations, escalations, incident reviews. In a one-off "FYI, here is a chart" share the cost is small enough that nobody will adopt a new tool to avoid it.

## Why existing patterns fall short

Three patterns already exist for this, and each solves a neighbouring problem rather than this one.

| Pattern | What it answers | Where it fails here |
|---|---|---|
| Message beside the link | "What should I do with this?" | Recipient must map words back to panels by hand; the mapping is lost once the thread scrolls |
| Bookmark / saved view | "How do I get back here?" | Identifies the whole interface, not the element inside it; carries no reason and no recipient |
| Dashboard comments (Grafana annotations, Datadog notebooks) | "What did someone say about this panel?" | Historically low adoption: the conversation already lives in chat, and a second place to talk loses to the first |

The last row is the important lesson. Commenting on dashboards is not a new idea, and it has not failed for lack of trying. It fails because it asks people to move a conversation into the tool, and the tool loses to Slack every time. Any proposal here has to work *with* the channel people already use, not compete with it.

What none of the three provide is a way for the sender's attention to travel inside the share and be rendered by the recipient's interface rather than described in words.

## What makes generated UI different

A hand-built dashboard is a layout: panels placed by a person, with no record of why. A generated interface is the output of a process, and that process leaves structure behind that a layout never had.

- **Every element exists for a reason.** The agent put the latency chart there because the investigation touched latency. The reason is recoverable; in a hand-built dashboard it is not.
- **Elements have stable identity.** A generator that emits a component tree can give every node an identifier that survives re-rendering. Pixel coordinates and panel titles do not.
- **The interface is a representation, not the thing itself.** The same investigation can be rendered differently for different viewers, on different surfaces, or after the agent learns more. Anything attached to the rendering alone is lost at the next render.
- **An agent sits on both ends.** The sender's agent built the interface; the recipient's agent can read what the sender marked and act on it. Nothing in a static dashboard can do that.

These properties cut both ways. They make a focus cheap to express and durable to carry. They also mean the recipient's rendering may differ from the sender's, which is where the naive design breaks. The sections that follow use the first three properties and plan around the fourth.

## Focus handoff as the primitive

A focus handoff is a share that carries three things: the interface, a set of elements the sender wants looked at, and at most one line of text. The recipient's runtime renders the marked elements emphasised and the rest subdued, and the line is shown once, at the top.

That is the whole feature. Specifically it is not:

- a thread on each element,
- a typed taxonomy of intents (question, hypothesis, action, approval),
- a lifecycle with states,
- a place for the recipient to reply.

Each of those is a separate product with its own data model, and each has failed before in dashboard tools for the reason given above. Focus alone is the minimum that tests the hypothesis: that carrying attention inside the share reduces the clarification and duplication costs.

A focus is also the natural unit for the agent on the recipient's side. "Why did this spike?" is unanswerable without knowing what "this" is. A focus resolves "this" to concrete elements, and from there to whatever those elements represent. The agent can narrate the handoff ("the sender flagged these two panels") and continue the investigation from them instead of from scratch. That is the capability no static tool can match, and it comes free with the primitive.

Replies go back to where the share came from. If a focus handoff was sent as a link in a chat channel, the recipient answers in that channel. The feature carries attention in one direction and does not try to own the conversation.

```text
 SENDER                                                  RECIPIENT
 ┌─────────────────────┐                                 ┌─────────────────────┐
 │  generated UI       │                                 │  generated UI       │
 │  ┌───┐ ┌───┐ ┌───┐  │   focus = { version,            │  ┌───┐ ┌───┐ ┌───┐  │
 │  │ A │ │ B │ │ C │  │             [A, C],             │  │ A │ │ b │ │ C │  │
 │  └─▲─┘ └───┘ └─▲─┘  │             window?,            │  └═══┘ └───┘ └═══┘  │
 │    └─ selects ──┘   │             note? }             │   A, C emphasised   │
 └──────────┬──────────┘                                 │   B subdued         │
            │ share: link + focus                        │   note shown once   │
            ▼                                            └──────────┬──────────┘
 ┌─────────────────────┐                                            │
 │  chat channel       │───── link opened ─────────────────────────▶│
 │  (Slack, etc.)      │                                            │
 │                     │◀──── reply goes back here ─────────────────┤
 └─────────────────────┘                                            │
                                                                    │ "why did this spike?"
                                                                    ▼
                                                         ┌─────────────────────┐
                                                         │  recipient's agent  │
                                                         │  "this" = A, C      │
                                                         │  + window + note    │
                                                         └─────────────────────┘
```

The focus travels with the share and is rendered by the recipient's runtime; the reply does not come back through the surface.

## Anchoring: structural and semantic identity

A focus has to point at something, and what it points at decides whether it survives. There are three candidate anchors, and the right answer is to use two of them in order.

| Anchor | Example | Survives re-render? | Survives regeneration? | Cost to build |
|---|---|---|---|---|
| Visual | x=425, y=280 | No | No | None |
| Structural | (interface version, node id) | Yes | No | Low: the generator already assigns node ids |
| Semantic | (metric, resource, time window) | Yes | Yes | High: requires an evidence model the generator may not have |

Visual anchoring is ruled out immediately; a generated interface re-lays itself out on every surface.

Structural anchoring is the right starting point. If the generator produces an immutable, versioned component tree with stable node identifiers, then a focus is simply a reference to a version and a list of node ids. It is exact, renders faithfully, and costs almost nothing. Its one weakness is that it dies when the agent regenerates the interface, because the new tree has new nodes.

Semantic anchoring fixes that weakness by pointing at what the node *represents* rather than the node itself. It requires the system to have a notion of evidence: an identity for "replication lag on prod-db-17 between 02:00 and 04:00" that exists independently of any rendering. Most generated-UI systems do not have this today; the agent produces prose and a tree, not an evidence graph. Building that graph is a larger project than the focus feature and should be evaluated on its own merits, because it has value for the agent regardless of collaboration.

The recommendation is therefore: anchor to structure now, add an optional time window (the one semantic field that is cheap and matters most), and defer semantic identity until regeneration-after-share is measured to be frequent enough to hurt. When semantic anchoring arrives, it layers on top: a focus carries both references and the runtime prefers the structural one when the version still exists.

```text
                      structural anchor                       semantic anchor (deferred)
                      exact, cheap                            survives regeneration
                      dies on regeneration                    needs an evidence model

  focus ──▶ (version H1, node id) ──▶ node in tree H1 ──▶ "replication lag · prod-db-17 · 02:00–04:00"
                                            │                              ▲
                                            │ agent regenerates            │ same evidence,
                                            ▼                              │ new node
                                      tree H2, new node ids ───────────────┘
                                            │
                                            ▼
                      old focus dangles ──▶ 1. show H1 beside H2   (MVP, zero cost)
                                            2. rebase via semantic diff (if lineage exists)
                                            3. re-anchor by evidence key (needs the model)
  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
  + window { start, end }   the one semantic field added now: cheap, and it survives regeneration
```

Anchor to structure now; the window field is the only semantic piece in the MVP; evidence identity is its own project.

## Hard problems

Four problems break the naive design. None is unsolvable; all need a decision before the first prototype.

**The recipient may not be able to see the target.** Generated interfaces are often hydrated per viewer: sensitive fields, hosts, or whole panels are stripped according to the viewer's access. The sender can mark an element the recipient's rendering does not contain. A focus mode that highlights nothing fails silently and looks broken. The runtime needs a defined behaviour ("one of the three items the sender flagged is not visible to you"), and the share flow should warn the sender before the handoff leaves their hands. On broadcast surfaces, where the same rendering goes to everyone, the problem inverts: a focus on a sensitive element would reveal that it exists.

**The data has moved on.** The sender flagged a spike at 02:15. The recipient opens the share at 05:40 and the panel shows a different window, or the spike has resolved. A node reference is not enough; the focus needs a time window, and ideally a snapshot of the values the sender saw. This is the one place where bookmarking fails outright and where even a structural anchor needs one semantic field.

**Replies drift into a second chat.** The moment a recipient can respond on the element, there is a thread, and the thread competes with the channel the share came from. The design has to decide where replies live and hold to it. The safe answer is: in the originating channel, with the focus carrying a back-reference so the reply can be read in context.

**The feature may not be needed.** The side-channel message is annoying but it works, and people tolerate considerable annoyance before adopting a new primitive. Whether focus handoff is worth building depends on how often generated investigations are shared at all, and on how much explanation accompanies each share. Neither number is known. Both should be measured before any build, from logs where they exist and from a short observation of real handoffs where they do not.

```text
   SENDER (can see A, B, C)                   RECIPIENT (cannot see C)
   ┌──────┬──────┬──────┐                     ┌──────┬──────┬ ─ ─ ─ ┐
   │  A   │  B   │  C   │                     │  A   │  B   │  (C)  │   stripped per viewer
   └──────┴──────┴──────┘                     └──────┴──────┴ ─ ─ ─ ┘
   focus = [A, C]    ──── share ───────────▶  render focus after filtering
         │                                      ├─ A  emphasised
         │  warn before sending:                ├─ C  absent → dropped = 1
         │  "1 of 2 flagged items may not       └─ "2 flagged, 1 visible to you"
         ▼   be visible to the recipient"          (do not describe the missing one)

   broadcast surfaces (same rendering for everyone): a focus on a hidden element
   reveals that it exists → restrict focus to elements everyone may see
```

Visibility asymmetry: the one failure that looks like a bug rather than a design gap.

## Validation and metrics

Validate the need before the design. The order matters because a lab study will almost certainly show that pointing at things helps; what it cannot show is whether anyone shares often enough for that to matter.

1. **Baseline from usage.** Count how often generated investigations are shared, by whom, and in what setting (incident, review, FYI). If the rate is low, stop here.
2. **Observe real handoffs.** For a sample of shares, record the message that accompanied the link. Measure its length and how much of it is locating language ("the panel on the left", "around 2am", "the prod one"). If it is routinely a paragraph of locating language, the problem is real.
3. **Prototype focus only.** Select elements, add one line, share. Nothing else.
4. **Compare against the baseline.** Same metrics, with and without focus.

The primary metric is context-transfer efficiency: can the recipient act on the sender's intent without asking? It decomposes into:

| Metric | Definition | Expected direction |
|---|---|---|
| Clarification rate | Shares followed by a "which one / where / when" question | Down |
| Accompanying-message length | Words sent beside the link | Down |
| Time to first action | Share opened to recipient's first query or edit | Down |
| Duplicate investigation rate | Recipient re-runs a query the sender already ran | Down |
| Agent continuation rate | Shares where the recipient's first move is an agent query from the focused element | Up |

The metric to avoid is any count of focuses created. Volume measures adoption of the control, not reduction of the problem.

## What this is not

Scope will try to grow in four directions. Each is a reasonable product; none belongs in this one.

- **Not a commenting system.** Threads on elements recreate Google Docs comments on a dashboard, and that pattern has already lost to chat in this domain.
- **Not a task or approval system.** "Please investigate X" and "approve this remediation" are workflow objects with assignees, states, and audit trails. Most systems that can take actions already have an approval mechanism; a second one attached to annotations duplicates it.
- **Not an intent taxonomy.** Typing focuses as question, hypothesis, or action adds a field the sender must choose and the recipient must interpret. The one line of free text covers all three and is read faster.
- **Not a chat replacement.** The handoff carries attention outward; it does not host the reply.

The test for any proposed addition: does it help the recipient find what the sender meant, or does it start a conversation? Only the first belongs here.

## Conclusion and path forward

The problem is real but narrower than "collaboration on generated UI" suggests. The sender's attention does not travel with the share, and people patch that with words. Generated interfaces are unusually well placed to fix it, because they already carry stable structure and the reason each element exists, and because an agent on the recipient's side can act on what the sender marked.

The primitive is focus handoff: elements plus one line, anchored to the interface's structure, with a time window, rendered as emphasis on the recipient's side. The agent reads it as context. Replies go back to the originating channel.

The path:

1. Measure share frequency and accompanying-message length. Decide whether to continue.
2. Decide the visibility-asymmetry behaviour and the time-window representation before any UI work.
3. Build focus only. Run the comparison.
4. If clarification and duplication fall, consider semantic anchoring as its own project, justified by agent benefit as much as by collaboration.
5. Revisit threads, intent types, and workflow objects only with evidence that recipients are asking for them, not because the design admits them.

The thesis in one sentence: traditional collaboration shares artifacts and messages; collaboration over generated UI should share attention, and let the agent do the rest.

---

# Paper 2 — Focus Handoff in GenUI

*Contextual collaboration on Loom and loom-ui* · Sushil · 2026-10-07

## Abstract

GenUI already has the two things a contextual-sharing feature normally has to build first: immutable, content-addressed blueprints with stable node identifiers, and semantic mutations as the way blueprints change. That makes **focus handoff** a small addition rather than a new subsystem. A focus is a reference to a blueprint hash, a set of node ids, an optional time window, and one line of text; rendering it on the recipient's side is a mutation that emphasises those nodes and subdues the rest; Loom stores it durably and hands it to the recipient's agent as structured context.

The design is constrained by decisions already made elsewhere in the platform. DE-9 per-viewer hydration means the sender can point at a node the recipient will never receive. The Slack adapter's broadcast identity model means a focus on a sensitive node reveals that it exists. Approval is already bound to a blueprint + presubmit hash pair, so an "approval annotation" would be a second approval path and must not be built.

This paper specifies the primitive against those constraints, scopes an MVP that reuses existing machinery, defers evidence identity until regeneration-after-share is measured, and lists what remains open.

## Context: GenUI blueprints and AI Mode

The parts of GenUI this design depends on, as they stand:

| Component | Property relied on |
|---|---|
| Blueprint | Content-addressed, immutable surface descriptor; a container/slot tree with stable node ids and LexoRank ordering |
| Component vocabulary | Closed and versioned, enforced at generation time; every node is a known component |
| Semantic mutations | Blueprints change through typed operations, merged rebase-before-promote |
| Approval | Bound to a (blueprint hash, presubmit hash) pair |
| DE-9 | Sensitive-field classification; blueprints are hydrated per viewer on interactive surfaces |
| Surface adapters | loom-ui as the primary interactive surface; Slack (Block Kit) as a broadcast surface with `block_id`/`action_id` as node addressing; MCP App views as leaf nodes |
| Root agent | Analyses intent and routes to a sub-agent; responses are prose, with ambient visual enhancement planned (dashboard for investigation outcomes, single widget for targeted questions) |
| Loom | Append-only Postgres event log as run source of truth; Zod-typed state at `$` boundaries; suspension as a first-class value; `step$`, `tool$`, `agent$`, `flow$`, `guard$`, `ui$`, `rotate$` |

AI Mode extends this: agents build the surface from what they find in the user's system or cloud infrastructure, from investigations, alerts, or current activity, and decide what the user should look at. The surface is therefore the rendering of an investigation run, and that run is a Loom run with an event log behind it.

One thing GenUI does not have is an evidence model. Sub-agents produce prose and a blueprint; there is no first-class identity for "replication lag on prod-db-17, 02:00–04:00" that exists apart from the node that displays it. That gap shapes the anchoring decision below.

## The problem in GenUI terms

When a user shares an AI Mode surface, the recipient receives a blueprint hash and a hydrated rendering of it. They do not receive the sender's reading of it: which nodes prompted the share, what the sender concluded, or what they want done. The sender supplies that in a Slack message beside the link, and the message does the work the share should have done.

The cost is highest where AI Mode is aimed: alert handoffs, escalations, and on-call rotation, where the same investigation changes hands several times and each recipient starts from the full surface. In that setting the locating language ("the lag panel, not the latency one, around 02:15") is a paragraph per handoff and a source of clarification round-trips.

Bookmarking does not help; it names the blueprint, not the node. A comment thread per node would help but has failed in every dashboard product that tried it, because the conversation already lives in Slack. The constraint, then, is to carry the sender's attention inside the share without hosting the conversation.

## Design: focus handoff as a semantic mutation

A focus is a small, immutable record. Its shape, as a Zod contract at the boundary where it enters Loom:

```ts
const Focus = z.object({
  id: z.string(),                 // content hash of the record below
  blueprint: z.string(),          // content hash of the blueprint the sender saw
  nodes: z.array(z.string()).min(1).max(5),
  window: z.object({ start: z.string().datetime(), end: z.string().datetime() }).optional(),
  note: z.string().max(280).optional(),
  author: z.string(),
  runId: z.string(),              // the Loom run that produced the blueprint
  origin: z.object({ surface: z.string(), ref: z.string() }).optional(), // where the share was sent
});
```

The node cap is deliberate. Five is enough for "look at these"; above that the sender is sharing the whole surface and should just share it.

On the recipient's side the focus is not a new rendering mode. It is a semantic mutation applied to the hydrated blueprint:

```ts
{ op: "emphasize", nodes: [...focus.nodes], subdue: "siblings" }
```

`emphasize` joins the existing mutation vocabulary, which means it rebases like any other operation, respects the closed component vocabulary (emphasis is a presentation attribute, not a new component), and does not fork the blueprint: the content hash the recipient sees is still the sender's. The mutation is applied at hydration, after DE-9 filtering, so a node that was stripped is simply absent from the emphasis set, and the adapter is told how many were dropped.

The note renders once, at the top of the surface, attributed to the author. It is not attached to a node and cannot be replied to in place; the `origin` field gives the surface a link back to the Slack thread or wherever the share came from, so a reply goes there.

Nothing in this design introduces an intent type, an assignee, a state, or a thread. The approval path stays where it is.

```text
 SENDER (loom-ui)                                         RECIPIENT (loom-ui)
 ┌──────────────────────┐                                 ┌──────────────────────┐
 │ blueprint H1         │                                 │ blueprint H1         │
 │ ┌───┐ ┌───┐ ┌───┐    │   Focus { blueprint: H1,        │ hydrate(viewer)      │
 │ │ A │ │ B │ │ C │    │           nodes: [A, C],        │   → DE-9 filter      │
 │ └─▲─┘ └───┘ └─▲─┘    │           window, note,         │   → emphasize [A,C]  │
 │   └── select ──┘     │           runId, origin }       │ ┌───┐ ┌───┐ ┌───┐    │
 └──────────┬───────────┘                                 │ │ A │ │ b │ │ C │    │
            │ focus.created ──▶ run log (Loom)            │ └═══┘ └───┘ └═══┘    │
            │                                             └──────────┬───────────┘
            ▼                                                        │
 ┌──────────────────────┐                                            │
 │ Slack thread         │◀──── origin back-link; reply lands here ───┤
 │ (origin)             │                                            │ "why did this spike?"
 └──────────────────────┘                                            ▼
                                                          ┌──────────────────────┐
                                                          │ root agent  (agent$) │
                                                          │ context: A, C, comps,│
                                                          │ window, note, runId  │
                                                          │ → resumes run        │
                                                          └──────────────────────┘
```

The focus is a mutation on hydration and an event on the run log; the Slack thread stays the place for replies.

## Anchoring with content-addressed blueprints and node IDs

Anchor to `(blueprint hash, node id)` and nothing else for the MVP. GenUI already gives this away: blueprints are immutable and content-addressed, nodes have stable ids, and the hash pins exactly the tree the sender was looking at. A focus addressed this way is exact, cheap, and renders faithfully on any surface whose adapter can resolve a node id (loom-ui directly; Slack through `block_id`).

What it does not survive is regeneration. If the recipient asks the agent to continue and the sub-agent emits a new blueprint, the new tree has new node ids and the focus points at the old hash. Three responses, in increasing cost:

1. **Show both.** The recipient's surface keeps the sender's blueprint reachable (it is immutable; nothing is lost) and the new blueprint alongside. The focus stays on the old one. Zero build cost; probably sufficient for an MVP.
2. **Carry through a semantic diff.** Refinement already produces semantic diffs between blueprints. If a diff can say "node A in v1 became node A' in v2", the focus can be rebased the same way mutations are. This reuses the rebase-before-promote machinery and costs little if the diff already tracks node lineage.
3. **Evidence identity.** Give nodes a semantic key (`metric`, `resource`, `window`) independent of the tree, and anchor the focus to that key as well as the node. This is the durable answer and the expensive one, because it needs an evidence model GenUI does not have. It is worth building for the agent's own sake, so it can cache and reuse evidence across runs, and it should be scoped as that project, not as a collaboration feature.

The time window is the one semantic field worth adding now. It is cheap (the sender's surface already knows the range it is showing), it survives regeneration, and it is the field the recipient most often has to ask about.

```text
                      structural anchor                       semantic anchor (deferred)
                      exact, cheap                            survives regeneration
                      dies on regeneration                    needs an evidence model

  focus ──▶ (version H1, node id) ──▶ node in tree H1 ──▶ "replication lag · prod-db-17 · 02:00–04:00"
                                            │                              ▲
                                            │ agent regenerates            │ same evidence,
                                            ▼                              │ new node
                                      tree H2, new node ids ───────────────┘
                                            │
                                            ▼
                      old focus dangles ──▶ 1. show H1 beside H2   (MVP, zero cost)
                                            2. rebase via semantic diff (if lineage exists)
                                            3. re-anchor by evidence key (needs the model)
  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
  + window { start, end }   the one semantic field added now: cheap, and it survives regeneration
```

Anchor to structure now; the window field is the only semantic piece in the MVP; evidence identity is its own project.

## Loom's role: durable state and agent continuation

A focus is state that outlives both the sender's session and the recipient's. Loom is where it lives.

**Storage.** A focus is appended to the event log of the run that produced the blueprint, as a `focus.created` event. The run is already the source of truth for the investigation; the focus is one more fact about it. Because the record is content-addressed, re-sending the same focus is idempotent, and because the log is append-only, a focus can be superseded by a later `focus.created` but never edited. This matches how everything else in Loom is recorded and needs no new store.

**Resolution.** When the recipient opens the share, hydration reads the focus events for that blueprint hash from the log and applies the `emphasize` mutation. Multiple focuses on the same blueprint (two senders, or one sender twice) are applied in log order and rebased like any other mutations.

**Agent context.** The important part. When the recipient asks the agent to continue ("why did this spike?"), the root agent receives the active focus as structured context at the `agent$` boundary: the node ids, the components they are, the time window, the note, and the run id. The agent does not have to infer what "this" means, and it can resume the original run rather than start a new one, because the run id is in the record. Suspension being first-class means the original run can have been suspended at a `guard$` and resumed by a different user; the focus rides along as state.

**Log classification.** A focus is replayable: it is a pure function of its inputs and must be reconstructable on replay. It is not in the "recorded, not replayed" class introduced for MCP App views. This matters for the IX replay inspector, which should show focuses as ordinary events.

**What Loom does not do.** It does not notify anyone. The share itself goes through whatever channel the sender chose; Loom records the `origin` so the surface can link back. Building notification into the kernel would be the first step toward hosting the conversation, which this design refuses.

```text
 run log (append-only, Postgres)                      who writes / reads
 ┌──────────────────────────────────────────┐
 │ step$ / tool$ results        ───┐        │  sub-agent, original run
 │ blueprint.promoted  H1       ◀──┘        │  content hash pins the tree
 │ ...                                      │
 │ focus.created { blueprint: H1,           │  sender, at share time
 │                 nodes: [A, C], window,   │  (content-addressed → idempotent;
 │                 note, author, runId,     │   superseded, never edited)
 │                 origin }                 │
 │ ...                                      │
 │ run.resumed  (recipient identity)        │  recipient opens / asks
 │ agent$ ← context { nodes, components,    │  root agent; permissions follow
 │                    window, note, runId } │  the recipient, not the sender
 │ blueprint.promoted  H2                   │  focus still points at H1
 └──────────────────────────────────────────┘
          │
          ▼
   hydration(viewer)
     read focus events for H1 ─▶ DE-9 filter ─▶ apply emphasize ─▶ adapter
                                                  (dropped count reported)
```

Everything the feature needs already has a place in the log; the only new event type is `focus.created`.

## loom-ui and surface adapters: rendering a focus

Each surface adapter decides what `emphasize` looks like. The mutation is the same; the treatment is not.

| Surface | Emphasis treatment | Subdue treatment | Note placement | Node resolution |
|---|---|---|---|---|
| loom-ui (interactive) | Highlight border, scroll-into-view on open, badge with author | Reduced opacity on siblings; toggle to clear | Banner above the surface with author and back-link | Node id directly |
| Slack (broadcast) | Section ordered first, context block "flagged by ..." | Omitted from the message, with a "view full" button | First block of the message | `block_id` |
| MCP App view (leaf) | Node-level only; the view's interior is opaque | Not applicable | As loom-ui | The view node itself |

Two requirements fall out of this for loom-ui specifically:

- **Selection is the sender's control.** The sender needs to pick one to five nodes on their own surface and attach the note. This is a selection affordance on container and leaf nodes, not a new mode; it should reuse whatever loom-ui already has for choosing a node to refine, since refinement already needs node-level selection.
- **Emphasis is reversible and non-destructive.** The recipient must be able to clear the focus and see the full surface without losing it. Since the focus is a mutation on hydration, clearing it is dropping the mutation, and re-applying it is re-reading the log.

On Slack the treatment is the most constrained. Block Kit has no visual hierarchy to speak of, so the only usable emphasis is order plus a context line. That is enough for "look at these two" and no more, which is the right level for a broadcast surface.

MCP App views are a hard boundary. A focus can say "look at this hosted view" and cannot say "look at row 4 inside it". That is acceptable for the MVP and consistent with leaf-only containment.

## Per-viewer hydration, DE-9 and visibility asymmetry

This is the problem the generic evaluation missed and the one most likely to ship broken.

On interactive surfaces, DE-9 classification strips sensitive fields and nodes per viewer at hydration. The sender hydrates with their clearance and sees node N. The recipient hydrates with theirs and node N is absent. A focus containing N then emphasises nothing, silently.

Required behaviour, in order of when it applies:

1. **At share time**, the sender's surface checks the focus nodes against the DE-9 classification of the blueprint. If any node carries a classification the intended recipient's tier would strip, the sender is told before sending ("1 of 3 flagged items will not be visible to this recipient"). This requires knowing the recipient at share time, which is not always true (a link pasted in a channel). When it is not known, the check runs against the blueprint's own classification and warns that some flagged nodes are tier-restricted.
2. **At hydration time**, the `emphasize` mutation is applied after filtering and reports how many nodes were dropped. The surface shows "the sender flagged 3 items; 2 are visible to you" rather than nothing. It must not name or describe the missing node, since that is exactly what DE-9 removed.
3. **The note is classified too.** Free text is a leak channel. The note should be scanned at share time by the same classifier that gates sensitive fields, and a note that names a stripped value is refused. This is a narrow check, not a general DLP system.

On broadcast surfaces the problem inverts. A Slack blueprint goes to everyone in the channel with no per-viewer hydration, which is why DE-9 became an early correctness requirement for that adapter. A focus on a sensitive node there would, at minimum, reveal that the node exists by ordering it first and labelling it. The rule for broadcast surfaces is therefore: a focus may only reference nodes that pass the broadcast tier, and the adapter rejects the share otherwise. This is the same constraint the Slack adapter already applies to the blueprint itself, extended to the focus.

Permissions for the agent follow the recipient, not the sender. When the recipient continues the run from a focus, the `agent$` call runs with the recipient's identity, and anything the sender could see that the recipient cannot stays out of the agent's context. The run id in the focus record grants continuity, not clearance.

```text
   SENDER  (clearance tier 2)                 RECIPIENT  (clearance tier 1)
   blueprint H1, hydrated for sender          blueprint H1, hydrated for recipient
   ┌──────┬──────┬──────┐                     ┌──────┬──────┬ ─ ─ ─ ┐
   │  A   │  B   │  C   │                     │  A   │  B   │  (C)  │   C stripped by DE-9
   └──────┴──────┴──────┘                     └──────┴──────┴ ─ ─ ─ ┘
   focus.nodes = [A, C]                       emphasize [A, C] after filter
         │                                      ├─ A  → emphasised
         │  share-time check:                   ├─ C  → absent, dropped = 1
         │  "1 of 2 flagged items is            └─ banner: "2 flagged, 1 visible to you"
         │   tier-restricted"                      (never names or describes C)
         ▼
   note scanned by the same classifier;
   a note naming a stripped value is refused

   BROADCAST (Slack): no per-viewer hydration → focus may reference only broadcast-tier nodes;
                      adapter rejects the share otherwise
```

The sender is warned before sending; the recipient is told how many flagged items are missing, never which.

## Data drift, time windows and versioning

A blueprint hash pins the tree, not the data in it. The sender flagged a latency chart showing a spike at 02:15; the recipient opens it at 05:40 and the chart, hydrated live, shows the last hour. The focus still points at the right node and the node shows the wrong thing.

Three layers address this, and the MVP needs the first two:

**Time window in the focus.** The sender's surface records the range each flagged node was displaying. On the recipient's side, hydration of a flagged node uses the focus window rather than the default, with an affordance to snap to live. This is the single most valuable field after the node ids and costs almost nothing.

**Snapshot of what the sender saw.** Loom's event log already records the tool results that populated the blueprint during the original run. Rather than re-fetching, the recipient's surface can hydrate a flagged node from the logged tool result for that run, which is exactly the data the sender was looking at. This is a replay, which Loom does natively. It also removes a class of "I don't see the spike" confusion entirely. Cost: the surface needs a hydration source switch (live vs. run-replay), which is probably useful beyond this feature.

**Evidence identity.** Covered under anchoring. Deferred.

Versioning follows from immutability. There are four versions in play and each is already pinned by something that exists:

| Thing | Pinned by |
|---|---|
| Blueprint | Content hash |
| Data the sender saw | Run id + event log position |
| Focus | Content hash of the focus record |
| Recipient's current view | Latest blueprint hash in the run, if the agent has continued |

No new version scheme is needed. A stale focus is one whose blueprint hash is no longer the run's head; the surface labels it as such and offers both views.

## MVP scope and validation

Measure first. Before any build, two numbers from existing logs and a short observation: how often AI Mode surfaces are shared, and how many words of locating language accompany each share. If shares are rare, stop. If the accompanying message is routinely a paragraph, proceed.

The build, in dependency order:

| Step | Work | Reuses | New |
|---|---|---|---|
| 1 | `Focus` Zod contract; `focus.created` event on the run log | Event log, content addressing | Record shape only |
| 2 | `emphasize` semantic mutation applied at hydration after DE-9 filtering, with dropped-count | Mutation vocabulary, rebase, DE-9 | One mutation op |
| 3 | loom-ui: node selection + note at share time; emphasis, subdue, banner, clear on receive | Refinement's node selection | Share affordance, banner |
| 4 | Time window captured at share, applied at hydration | Surface already knows its range | Window field |
| 5 | DE-9 share-time check and note scan; broadcast-tier rejection for Slack | DE-9 classifier | Two checks |
| 6 | Root agent receives active focus as `agent$` context; continues the original run | `agent$`, run resumption | Context injection |

Not in the MVP: Slack rendering of focus (step 5 only rejects; rendering waits), run-replay hydration, semantic diff rebasing, evidence identity, any reply affordance.

Validation compares the measured baseline against the same metrics with focus available:

- clarification rate (shares followed by a which/where/when question),
- accompanying-message length,
- time from open to first agent query,
- agent continuation rate (first move is a query from a flagged node),
- duplicate-investigation rate (recipient re-runs a tool call already in the run log; Loom can measure this directly).

The last metric is one GenUI can measure that no dashboard tool can, because every tool call is in the event log. It is the strongest evidence the feature could produce.

## Open questions

- [ ] Does refinement's semantic diff already carry node lineage between blueprint versions? If yes, rebasing a focus across regeneration is nearly free; if no, option 1 (show both) is the MVP answer.
- [ ] Does loom-ui already expose node-level selection for refinement, or is that still agent-side? The share affordance should not be the first node-selection UI built.
- [ ] Can the DE-9 classifier run on free text (the note) with acceptable latency at share time, or does the note need a simpler allow-list check?
- [ ] At share time, is the recipient known often enough for the per-recipient visibility warning to be worth building, or should the MVP only warn on tier-restricted nodes generically?
- [ ] Should a focus be scoped to a blueprint hash or to a run? A run-scoped focus could follow the head blueprint automatically, at the cost of pointing at nodes that no longer exist.
- [ ] Is `emphasize` a presentation attribute on existing nodes, or does it need a wrapper node in the vocabulary? The former keeps the closed vocabulary unchanged; the latter is cleaner for Slack.
- [ ] Run-replay hydration (showing the sender's data from the event log) is valuable beyond this feature. Is it already planned under the IX inspector, and can this feature share it?
- [ ] Where do shares actually originate today: a loom-ui share button, a pasted link, the Slack App Home? The `origin` field and the reply-back-link depend on the answer.
- [ ] Should agents be allowed to create focuses ("I found three things; look at these")? This is the AI Mode story in one sentence and may be more valuable than human-to-human focus, but it is a different feature with different trust requirements.
