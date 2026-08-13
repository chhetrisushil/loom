---
marp: true
theme: default
paginate: true
title: "Porting Loom — building a durable execution kernel in another language"
---

<!-- _paginate: false -->

# Building a Loom-class runtime in another language

### A proposal

**What must survive the port · what must be redesigned · what must never be built**

Derived from `docs/spec/loom-kernel-specification.md`, `docs/architecture.md` §2, and 86 ADRs

<!--
Presenter: "This is not 'rewrite Loom in Go.' It's a proposal to build a kernel
that satisfies the same contract in a host language where our users already
live. The deck's whole job is to separate the ~10 invariants that ARE the
product from the implementation choices that are just TypeScript."
-->

---

## The proposal in one slide

**Build:** a durable execution kernel in `<target language>` — event-sourced, replay-deterministic,
suspendable — that satisfies the *same normative contract* as Loom's kernel.

**Do not build:** a port. A line-by-line translation of `@loom/*` will fail, because a third of
Loom's surface is TypeScript-specific ergonomics (`$`-suffixed builders, bundler code-splitting,
structural types) that solve problems the target language does not have.

**The deliverable that matters:** a second implementation that can read the *same event log* and
fold it to the *same state*. If two kernels disagree on `fold(events)`, only one of them is a kernel.

<!--
Presenter: "Frame the success criterion early — cross-implementation fold
equivalence. It's testable on day one and it forces every other decision."
-->

---

## What Loom actually is (strip the vocabulary)

> A **durable execution kernel**: a minimal, event-sourced core that runs long-lived, suspendable,
> replay-deterministic executions, and exposes pluggable seams (storage, compute, effects, policy)
> around it. — `docs/spec/loom-kernel-specification.md` §0

One guarantee underneath everything:

> A function can be interrupted at any point — waiting on a tool, a model, or a **human** — survive a
> process restart, and resume from exactly where it left off, **without the application code knowing
> the difference** between a fresh run and a replay.

Everything else in the repo is a consequence of delivering that one sentence.

---

## Part I — The invariants

### These are the port. Everything else is negotiable.

Eleven principles (P1–P11) and two guardrails (G1/G2) govern the kernel. In dependency order, not
importance order — each one below exists to protect the one above it.

<!--
Presenter: "I'm going to give you ten slides, one invariant each. If the team
takes nothing else from this deck, take slides 6 through 15."
-->

---

## I1 — The log is the only source of truth (P1)

State is **never stored**. It is **derived**:

```
state = fold(events)
```

An append-only, per-execution, totally-ordered sequence of immutable events. The current state of an
execution is a left-fold over that sequence and **nothing else**.

**Why it must survive the port:** replay, resume, fork, audit, time-travel debugging, and branching
are not six features — they are six readings of this one property. Lose it and you lose all six, and
you have written a job queue.

**Portability note:** trivially portable. Every language can append to a log and fold it. The
temptation you must resist is a "small" mutable cache beside the log for speed. See I2.

---

## I2 — The fold is a pure function (P2)

The hard constraint, stated normatively:

> Folding a stored event log MUST reconstruct identical state. `state = fold(events)` is a pure
> function; the fold MUST NOT read wall-clock, randomness, or any ambient input.

Corollaries Loom enforces in the fold itself:

- An **unknown event type is inert** — ignored, never an error. This is what lets an old kernel read
  a new log.
- A handler MUST be pure `(state, event) => state`.
- The fold is **copy-on-write**; it never mutates caller-visible state.
- Container keys are validated (`__proto__` rejected — your language will have its own equivalent
  injection surface).

**This is the moat.** Every proposal in Loom's history that touched it was rejected. Nine of the
eleven principles exist only to keep this true.

---

## I3 — One sequencer, one writer

The single most important structural invariant in the implementation:

> The **journal** is the *sole* sequence allocator and the *only* component that appends to the store.

```
flow → ctx.run → journal.commit(event)
                   ├─ ++sequence        (sole allocator)
                   ├─ applyEvent → VM   (synchronous, authoritative)
                   └─ append → store    (async, order-preserving tail)
```

**Why:** a per-execution total order with no multi-writer race. The in-memory VM is updated
*synchronously and authoritatively*; the durable append is an order-preserving tail.

**Portability note:** this gets *easier* in languages with real concurrency primitives, and *more
dangerous* — with true parallelism you must actively prevent the second writer that JavaScript's
single thread accidentally prevented for you.

---

## I4 — Suspension is a normal return value (P3)

A workflow pausing to wait for a human is **not an error and not a special mode**. It is an ordinary
outcome of running, alongside "completed" and "failed."

Contract details worth copying verbatim:

- A suspension **MUST carry a correlation key** so its resume can be routed.
- A timed suspend **MUST record a durable wake time** in the log, fired as a resume event that
  survives restart. *The scheduled time is in the log — wall-clock drift never enters the fold.*
- Resumed gates replay **in order, each with its own recorded payload**.

**Portability note:** this is where the host language stops being neutral. See Part II.

---

## I5 — Every effect goes through one seam

All side effects — tool calls, model calls, human waits, agent-to-agent calls — pass through a single
**effect boundary**, keyed by a stable identifier.

That one boundary is simultaneously:

| Role | What it gives you |
|---|---|
| **Isolation** | replay serves completed effects from the log instead of re-running them |
| **Authority** | an optional authorizer can *deny* an effect — it never runs, the denial is logged |
| **Accounting** | tokens / cost / time metered per effect, folded into the state |
| **Policy** | declarative allow/deny, composed *under* the authorizer — tighten, never widen |
| **Middleware** | retry, memoize, redact, safety — as composable rings |

**One seam, five products.** Build it as one seam or you will build five leaky ones.

---

## I6 — Step identity is a pure function of logged inputs

**The single most portable-and-most-missed rule.** Loom learned this the hard way (ADR 0061):

> The sequence of durable-step identities an execution produces MUST be a pure function of logged
> inputs (flow input, step outputs, decisions, resume payloads). A step invoked more than once with
> different intent MUST mint a deterministic distinct id — `${id}#${index}` for loops,
> `${id}#retry:${n}` for deliberate retries.

Frames are keyed by id. **Reusing an id returns the first recorded outcome.** A loop that calls the
same step id twice is silently served iteration 1's output on iteration 2.

> That is the worst failure class in the system — **silent replay corruption** — and it sits one
> naive loop away.

**Mitigation in the port:** ship the rule *and* a static analysis pass for it in v1, plus a
crash-injection test at every loop position. Do not defer this to v2.

---

## I7 — Non-determinism is allowed, but only when logged (P9)

You are building a runtime for *intelligent* software. It will route between models, sample, elevate,
learn, and optimize. All of that is non-deterministic. All of it is allowed:

> A non-deterministic choice MUST be recorded as a decision event and served from the log on replay,
> **never re-computed**.

The result: **a given execution replays bit-for-bit forever, while outcomes improve run-to-run.**

This is the principle that lets a determinism-obsessed kernel host an AI workload without either side
lying. It is also the general escape hatch — anything you cannot make deterministic, you make
*recorded*.

---

## I8 — Minimal kernel; everything smart is opt-in (P10)

The kernel carries **mechanism**. **Policy** — which hosts, tenants, budgets, models — lives above it.

Anything "smart" (scheduling, reasoning, memory, prediction, optimization) is an **optional,
composable module** that may affect:

- **outcomes** — only through a logged decision (I7), or
- **latency** — only through off-log warming,

and is **never a hidden input to the fold**.

Enforced as a guardrail, not a preference:

> **G2** — Every additive capability MUST be opt-in: unwired, behaviour is **byte-identical** to the
> kernel without it.

**In practice:** every ring Loom added — authority, metering, safety, redaction — is omittable, and a
CI gate proves the disabled path costs nothing.

---

## I9 — Wiring is static and replay-safe (P5)

Everything that determines *what runs* — flow registration, effect registration, middleware,
surfaces — is wired **statically at build/boot time from explicit imports**.

No runtime filesystem globbing. No environment-conditional registration. No runtime plugin discovery.

**Why it is an invariant and not a style choice:** a resume, a remote worker, and a replay must each
reconstruct an *identical* set of flows and effects. That is only possible if wiring is deterministic.

Folder conventions are honored — via **build-time codegen**, never runtime discovery.

---

## I10 — Pure cores, thin edges; the core is isomorphic (P7/P8)

Each capability is a **pure, unit-testable core** (a fold, a format, a validate, a plan) wrapped by a
thin I/O shell. The durable core has **no environment assumptions**: storage, compute placement, model
providers, and renderers are all interfaces.

The seams Loom pins with a version constant *and* a conformance kit a third party can run:

| Seam | Why it is a seam |
|---|---|
| **Event log** | memory · SQLite · Postgres · your cloud store |
| **Snapshots** | bound the replay tail; `fold(snapshot, suffix) == fold(events)` |
| **Branch registry** | fork/branch lineage |
| **Dispatch / Worker** | in-process · HTTP · serverless |
| **Effect / middleware / authority** | every side effect and every ring |

**Optional methods are explicit** and the conformance kit skips them — so a minimal store is a
*legal* store, not a broken one.

---

## The invariant card

> Print this. It is the whole of Part I.

1. `state = fold(events)` — the log is the only source of truth
2. The fold is pure — no clock, no randomness, no ambient input; unknown events are inert
3. One sequencer, one writer
4. Suspension is a normal outcome, with a correlation key and a logged wake time
5. All effects cross one seam, keyed by a stable id
6. **Step identity is a pure function of logged inputs**
7. Non-determinism is fine — if it is recorded and served from the log
8. Kernel = mechanism; smart = opt-in, and byte-identical when unwired
9. Wiring is static
10. Pure cores, pluggable edges, versioned seams with conformance kits

<!--
Presenter: "If a design review can't map a proposed feature onto one of these
ten, that's the signal it belongs outside the kernel."
-->

---

## Part II — What does *not* port

### The invariants are language-independent. The mechanism that delivers them is not.

<!--
Presenter: "This is where a naive port dies. About a third of Loom's surface
area is TypeScript answering TypeScript-specific problems."
-->

---

## The fork in the road: how do you resume a function?

Loom's answer: **resume = re-run, served from the log.**

> Resuming re-executes the flow function; each durable seam short-circuits from the recorded log, so
> completed work is never repeated and the orchestration *between* recorded points re-runs
> deterministically.

The alternatives, and why they lose:

| Strategy | Verdict |
|---|---|
| **Re-run + short-circuit** *(Loom)* | Host-language-agnostic. Needs cheap re-execution + I6 discipline. **Recommended.** |
| **Serialize the continuation / stack** | Ties the log to a VM's internal representation. Breaks across versions and across languages. |
| **Compile flows to explicit state machines** | Deterministic, but you have re-invented a DSL and lost P4 ("intelligence stays as plain code"). |
| **Serialize the reactive graph** | Rejected outright — a **second, non-logged source of truth**. See Part III. |

**Decide this on slide one of your design doc.** Everything else follows from it.

---

## Host-language decision table

| Concern | TypeScript's answer | What the port must decide |
|---|---|---|
| **Flow as plain code** (P4) | `async` function + `await ctx.run()` | coroutines? goroutines + channels? virtual threads? `async fn` + a pinned executor? |
| **Cheap re-execution** | closures are free; re-running a flow body is microseconds | is your re-run cheap enough at your loop depth? measure before committing |
| **Handler co-location** | `handler$()` extracted by a compiler into lazy chunks | **not a kernel concern** — it is a bundler optimization. Drop it in v1. |
| **Payload schema** | structural types + runtime validators | you likely have a *better* answer (serde, protobuf, records) — use it |
| **Cancellation** | promise races + abort signals | context/cancellation tokens are a *first-class win* over JS here |
| **Parallel steps** | `ctx.parallel` over promises | true parallelism ⇒ you must enforce deterministic ordering of *results*, not of *execution* |
| **The `$` idiom** | `flow$` / `step$` / `agent$` builders | pure ergonomics. Use your language's idiom; keep the *shape*, drop the sigil. |

---

## What gets *easier* in a systems language

- **True concurrency with real primitives.** Loom's single sequencer is a discipline in JS; it can be
  a *type-enforced* ownership property in Rust or a single owning goroutine in Go.
- **Cancellation and deadlines.** Context propagation beats abort-signal plumbing.
- **Memory-bounded folds.** Explicit control over copy-on-write and arena reuse; Loom had to hand-roll
  structural sharing for this.
- **Schema on the wire.** A real IDL makes the event log's on-disk ABI enforceable at compile time,
  where Loom needs a pinned test.
- **Zero-overhead-when-disabled (G2).** Monomorphization / build tags can make it *literally* zero,
  not merely "byte-identical at runtime."

---

## What gets *harder*

- **Cheap re-execution is not free.** Replay-based resumption re-runs orchestration code. Fine when
  it is an `async` function; verify it when it is a spawned task with setup cost.
- **Ambient non-determinism is easier to reach.** Map/dict iteration order, goroutine scheduling,
  thread interleaving, and default hashers can leak into the fold. Loom's guard is a compiler lint;
  yours must be a lint *and* a deterministic-simulation harness.
- **You must ban the clock harder.** No `now()` in the fold, in step identity, or in any hash. The log
  carries time; the code never reads it.
- **Serialization is now a versioning contract.** Structural JSON tolerated additive drift for free.
  A binary format makes you *design* additive evolution up front.

---

## Part III — What NOT to build

### Loom's most valuable output is its rejection record

Every item on the next slides was proposed, evaluated in writing, and **rejected on invariants** —
not on cost, not on schedule. Adopting the rejections is faster than re-deriving them.

<!--
Presenter: "This is the highest-leverage slide set in the deck. Each of these
cost us an evaluation cycle. The port gets them for free."
-->

---

## The permanent non-goals

| Rejected | Why |
|---|---|
| **Fibers / preemptive scheduling in the kernel** | The unit of scheduling is the durable execution. A second, in-memory scheduling identity buys nothing the log doesn't already give. |
| **Serialized reactive graph / signals as state** | A **second, non-logged source of truth** — violates P2. In-memory, single-process, lossy: strictly *weaker* than the log for the very durability cases it claims to serve. |
| **Streams / pipes as a kernel primitive** | Unrecorded in-flight data breaks the determinism boundary. |
| **Runtime plugin system** | Violates P5 (static wiring). Composition-time contributors only. |
| **Identity-preserving suspension transfer** | Rejected permanently — a wait that migrates between executions destroys per-execution total order. |
| **Durability classes / "ephemeral runs"** | Breaks crash recovery, fencing, and the "is it in the log?" binary. Rejected on invariants, not cost. |
| **A compiler plugin API** | A public extension point on a build-time optimizer becomes a de-facto ABI. |

---

## Three features that turned out to need *no kernel change*

The most useful discipline Loom developed: **assume the kernel needs nothing, and make the proposer
prove otherwise.**

| Feature | Planned kernel change | What actually shipped |
|---|---|---|
| **Saga / compensation** | a `compensate` syscall + compensation events | **Nothing.** Compensators are ordinary replay-guarded steps with deterministic ids. |
| **Child-workflow orchestration** | a `CHILD_COMPLETED` governed event | **Nothing.** Composed from existing primitives. |
| **Typed failure channels** | a `fail` syscall | **No syscall.** A userspace throw + two optional fields on an existing event. |

> Each of these was in an accepted plan before implementation disproved it.

**Rule for the port:** the placement verdict — *kernel / first-party module / third-party module* —
is the **opening line** of every proposal, and the default is **outward**.

---

## The cost of getting placement wrong

**Kernel surface is the only thing you can never take back.**

- A syscall added is a **minor** version; a syscall removed or repurposed is a **major break**.
- An event type added is a **minor**; a type removed or renamed is a **major break** — and every log
  ever written is your compatibility test suite.
- A module can be deleted in an afternoon.

Loom's scorecard across its largest expansion — a seven-phase arc adding deterministic simulation
testing, coordination primitives, and multi-tenant isolation across seven new packages:

> **Syscall ABI: unchanged.** One additive event type.

That is what "bias outward" buys.

---

## Part IV — How you prove it, continuously

### Architecture that isn't executable is architecture that has already drifted

Loom's invariants are **fitness functions** — every PR proves them. Copy the mechanism, not just the
list.

---

## The seven executable gates

| # | Gate | What it proves |
|---|---|---|
| 1 | **Replay unchanged** | golden-log replay + deploy-simulation: a code change cannot silently re-fold historical logs differently |
| 2 | **ABI pinned** | the syscall surface cannot drift silently (add = minor, remove = major) |
| 3 | **Event schema pinned** | the event-type set cannot change without bumping version *and* pin, together |
| 4 | **Zero-overhead when disabled** | a disabled-path behavioural test + a relative-ratio bench canary |
| 5 | **Benchmarks measured** | machine-*stable ratios* are gated; absolute numbers stay advisory |
| 6 | **SPI conformance** | a storage/dispatch implementation runs the kit and proves it honours the contract |
| 7 | **Static validation** | flows structurally valid; non-determinism and loop-identity caught pre-dispatch |
| + | **Maturity self-checks** | a capability's maturity badge fails CI if it claims evidence it does not have |

**One command, one CI gate.** If proving the architecture is a separate ritual, it stops happening.

---

## Two gates worth extra investment in the port

**Deterministic simulation testing (DST).** Drive the whole kernel under a seeded, controlled clock
and scheduler; inject crashes at every step boundary; assert byte-identical folds after recovery.
In a language with real parallelism this moves from "valuable" to **mandatory** — it is the only
practical way to find the interleavings that break I2/I3.

**Cross-implementation fold vectors.** A shared corpus of `(event log → expected folded state)`
fixtures, checked into a language-neutral format and run by *both* kernels.

> This is the single artifact that makes "a second implementation" mean something. Build it in week
> one, before either kernel is finished.

---

## Part V — Proposed build order

### A walking skeleton first; capability second

Each milestone ends **green and demoable**. Nothing below is speculative — it is Loom's own
dependency order, with the parts that proved unnecessary removed.

---

## Milestones

| # | Milestone | Ships | Proves |
|---|---|---|---|
| **M0** | **Fold vectors** | shared log→state fixture corpus + runner | the contract exists before the code does |
| **M1** | **Walking skeleton** | event envelope · append-only store (memory) · pure fold · journal (sole writer) · one syscall (`run`) | I1 · I2 · I3 |
| **M2** | **Suspend / resume** | correlation keys · durable wake times · resume routing · crash-recovery tests | I4 — *the product* |
| **M3** | **Effect seam** | one boundary · replay short-circuit · middleware rings · retry | I5 |
| **M4** | **Identity + validation** | the identity rule · loop-identity lint · crash-matrix at every loop position | I6 — **do not defer** |
| **M5** | **Durable storage + snapshots** | a real store behind the SPI · conformance kit · snapshot equivalence | I10 |
| **M6** | **Decision seam** | recorded non-deterministic choices, served from the log on replay | I7 |
| **M7** | **Placement** | stateless workers · dispatch SPI · *resume = migration* | I10 at scale |

Rings (authority, metering, policy, safety), reasoning, memory, and analytics are all **post-v1** and
all **opt-in** — by construction (I8), they cannot be on the critical path.

---

## Explicitly out of scope for v1

Stating these up front is what keeps M1–M7 achievable:

- **No compiler / code-splitting.** A bundler optimization for a language that needs bundling.
- **No UI / projection layer.** A downstream concern; the kernel emits events, something else folds
  them into views.
- **No natural-language authoring.** Build-time convenience, never a runtime input — and it needs a
  finished kernel to target.
- **No agent / model / memory runtimes.** They are consumers of the kernel, not parts of it.
- **No multi-tenant isolation, quotas, or audit chain.** All opt-in rings; all provably additive.

> Every one of these exists in Loom, and **every one of them was built after the kernel was stable.**
> That ordering is not an accident and is not negotiable.

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Re-execution cost** in a language where a flow body is not a cheap closure | Benchmark M1 at realistic loop depth *before* M2. Snapshots bound the replay tail; measure the bound. |
| **Ambient non-determinism** from real parallelism (iteration order, scheduling, hashing) | DST from M1, not M5. Lint + seeded simulation, both. |
| **Silent replay corruption** from reused step ids | M4 is a milestone, not a task. Lint + crash-matrix. |
| **Kernel bloat** under feature pressure | Placement verdict opens every proposal; G2 disabled-path test is a merge gate. |
| **Divergence from the reference kernel** | Shared fold vectors (M0), run in both CIs. Divergence is a red build, not a discussion. |
| **Scope creep into agents/UI** | The out-of-scope slide is a signed part of this proposal. |

---

## What success looks like

**Technical**

- Both kernels fold the shared corpus identically. A new fixture added to either repo is a gate in both.
- An execution suspends on a human approval, the process is killed, and it resumes on a different
  worker with byte-identical state.
- Crash injection at every step boundary of a plan-driven loop recovers with correct per-step
  invocation counts.
- Disabling every optional ring is byte-identical to a kernel built without them.

**Organizational**

- A "does this belong in the kernel?" question has a written, evidence-shaped answer within a day.
- The rejection record grows. **A proposal rejected on invariants is a shipped artifact.**

---

## The ask

1. **Agree the invariant card** (slide 15) as the contract. It is the port.
2. **Pick the target language and the continuation strategy** — one decision, made explicitly, on the
   record.
3. **Fund M0–M4** — fold vectors, walking skeleton, suspend/resume, effect seam, identity. That is the
   kernel; everything after it is additive by construction.
4. **Adopt the discipline, not just the design** — placement verdict on every proposal, fitness
   functions in CI from M1, and an ADR for every rejection.

> The port that succeeds is the one that treats the ten invariants as non-negotiable and everything
> else as an implementation detail — **including most of what Loom currently looks like.**

---

## Appendix — reading order in this repo

| Document | Read it for |
|---|---|
| [`docs/spec/loom-kernel-specification.md`](../spec/loom-kernel-specification.md) | The normative *what*: execution, replay, event, suspension, placement, SPI, resource, and compatibility semantics |
| [`docs/spec/fitness-functions.md`](../spec/fitness-functions.md) | The seven executable gates and where each is enforced |
| [`docs/architecture.md`](../architecture.md) §2 | P1–P11, in full, with rationale |
| [`docs/loom-2.0/00-overview.md`](../loom-2.0/00-overview.md) | The layering discipline: kernel vs. application vs. platform |
| [`docs/adr/0016-…`](../adr/0016-loom-2.0-execution-runtime-and-decision-seam.md) | The execution + decision seams — the two spines |
| [`docs/adr/0061-…`](../adr/0061-step-identity-interpreter-guardrails.md) | The identity rule (I6) and its guardrails |
| [`docs/adr/0067-…`](../adr/0067-reactive-graph-resumability-rejected.md) | A model rejection, in full — the shape every rejection should take |
| [`docs/spec/maturity.md`](../spec/maturity.md) | Evidence-derived capability maturity — how a claim earns its badge |

<!--
Presenter: "Hand the first two to anyone who wants to argue with the deck.
Hand the last four to anyone who wants to write the thing."
-->
